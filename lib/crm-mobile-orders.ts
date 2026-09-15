import { createCrmOrder, CrmError, linkChatwootConversationOrder } from "./crm";
import { type CrmPanelContext, validateCrmPanelContext } from "./crm-panel";
import { calculatePrices, settingsFromRow } from "./pricing";
import { syncConversationOrder } from "./chatwoot-sync";
import { type ChatwootClient } from "./chatwoot-client";

type Row = Record<string, unknown>;
type CartLine = { kind: "INVENTORY" | "SPECIAL_ORDER"; id: number; quantity: number; discountAmount?: number };

function text(value: unknown, max = 1000) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function integer(value: unknown, field: string, min = 0, max = 100_000_000) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new CrmError(`${field} es inválido.`, 400, "CRM_PANEL_ORDER_INVALID"); return parsed; }
function operationId(value: unknown) { const result = text(value, 160); if (!/^[A-Za-z0-9:_-]{8,160}$/.test(result)) throw new CrmError("operationId es obligatorio para crear el pedido.", 400, "CRM_PANEL_OPERATION_REQUIRED"); return result; }
function price(row: Row, settings: Row) {
  if (row.purchase_price_usd_cents == null || row.weight_milli_lb == null) throw new CrmError(`No hay precio comercial calculable para “${row.name}”.`, 409, "CRM_PANEL_PRODUCT_PRICE_UNAVAILABLE");
  return calculatePrices(Number(row.purchase_price_usd_cents) / 100, Number(row.weight_milli_lb) / 1000, settingsFromRow(settings)).gamPriceCrc;
}
function availability(row: Row) { const quantity = Number(row.quantity_available || 0); return quantity > 0 ? "AVAILABLE" : "OUT_OF_STOCK"; }
function productResult(row: Row, settings: Row) { const commercialPrice = Math.round(price(row, settings)); return { id: Number(row.id), kind: "INVENTORY" as const, name: String(row.name), brand: row.brand ? String(row.brand) : null, presentation: row.presentation ? String(row.presentation) : null, code: row.code ? String(row.code) : null, commercialPrice, quantityAvailable: Number(row.quantity_available || 0), availability: availability(row) }; }
function quoteResult(row: Row, settings: Row) { const commercialPrice = Math.round(price(row, settings)); return { id: Number(row.id), kind: "SPECIAL_ORDER" as const, name: String(row.name), brand: null, presentation: null, code: row.code ? String(row.code) : null, commercialPrice, quantityAvailable: null, availability: "SPECIAL_ORDER" as const }; }

export async function searchCrmMobileProducts(db: D1Database, query: string) {
  const term = text(query, 200); if (!term) throw new CrmError("Ingresá un término de búsqueda.", 400, "CRM_PANEL_PRODUCT_QUERY_REQUIRED");
  const settings = await db.prepare("SELECT * FROM settings WHERE id=1").first<Row>(); if (!settings) throw new CrmError("No hay configuración comercial disponible.", 409, "CRM_PANEL_PRICING_UNAVAILABLE");
  const pattern = `%${term.toLowerCase()}%`;
  const [products, quotes] = await Promise.all([
    db.prepare("SELECT * FROM products WHERE lower(name) LIKE ? OR lower(COALESCE(code,'')) LIKE ? OR lower(COALESCE(normalized_name,'')) LIKE ? OR lower(COALESCE(brand,'')) LIKE ? OR lower(COALESCE(presentation,'')) LIKE ? ORDER BY name LIMIT 30").bind(pattern, pattern, pattern, pattern, pattern).all<Row>(),
    db.prepare("SELECT * FROM non_inventory_quotes WHERE lower(name) LIKE ? OR lower(COALESCE(code,'')) LIKE ? ORDER BY name LIMIT 20").bind(pattern, pattern).all<Row>(),
  ]);
  return [...products.results.map((row) => productResult(row, settings)), ...quotes.results.map((row) => quoteResult(row, settings))];
}

async function canonicalLines(db: D1Database, input: Record<string, unknown>) {
  const source = Array.isArray(input.lines) ? input.lines : null; if (!source?.length || source.length > 100) throw new CrmError("Agregá entre 1 y 100 productos.", 400, "CRM_PANEL_LINES_REQUIRED");
  const parsed = source.map((value) => {
    const line = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const kind = text(line.kind, 30).toUpperCase(); if (kind !== "INVENTORY" && kind !== "SPECIAL_ORDER") throw new CrmError("El tipo de producto es inválido.", 400, "CRM_PANEL_LINE_KIND_INVALID");
    return { kind: kind as CartLine["kind"], id: integer(line.id, "El producto", 1, 2_147_483_647), quantity: integer(line.quantity, "La cantidad", 1, 100_000), discountAmount: integer(line.discountAmount ?? 0, "El descuento", 0) };
  });
  const kinds = new Set(parsed.map((line) => line.kind)); if (kinds.size > 1) throw new CrmError("No combinés inventario y encargos en el mismo pedido. Creá pedidos separados para conservar el flujo operativo.", 409, "CRM_PANEL_MIXED_ORDER_TYPES");
  const settings = await db.prepare("SELECT * FROM settings WHERE id=1").first<Row>(); if (!settings) throw new CrmError("No hay configuración comercial disponible.", 409, "CRM_PANEL_PRICING_UNAVAILABLE");
  const ids = [...new Set(parsed.map((line) => line.id))];
  const sourceTable = parsed[0].kind === "INVENTORY" ? "products" : "non_inventory_quotes";
  const records = await db.prepare(`SELECT * FROM ${sourceTable} WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<Row>();
  const byId = new Map(records.results.map((row) => [Number(row.id), row])); if (byId.size !== ids.length) throw new CrmError("Uno de los productos ya no existe. Actualizá la búsqueda.", 409, "CRM_PANEL_PRODUCT_NOT_FOUND");
  return { orderType: parsed[0].kind === "SPECIAL_ORDER" ? "SPECIAL_ORDER" : "STANDARD", lines: parsed.map((line) => { const row = byId.get(line.id)!; const unitPriceSold = Math.round(price(row, settings)); const subtotal = line.quantity * unitPriceSold; if (line.discountAmount > subtotal) throw new CrmError(`El descuento de “${row.name}” supera su subtotal.`, 400, "CRM_PANEL_DISCOUNT_INVALID"); return { productId: line.kind === "INVENTORY" ? line.id : null, productName: String(row.name), presentation: row.presentation ? String(row.presentation) : null, barcode: row.code ? String(row.code) : null, quantity: line.quantity, unitPriceOriginal: unitPriceSold, unitPriceSold, discountAmount: line.discountAmount }; }) };
}

export async function createCrmMobileOrder(db: D1Database, context: CrmPanelContext, input: Record<string, unknown>, client?: ChatwootClient) {
  const customer = await validateCrmPanelContext(db, context, client);
  const lines = await canonicalLines(db, input);
  const result = await createCrmOrder(db, {
    operationId: operationId(input.operationId), customerId: customer.id, orderType: lines.orderType, lines: lines.lines,
    deliveryAddress: text(input.deliveryAddress, 2000) || customer.default_delivery_address, deliveryInstructions: text(input.deliveryInstructions, 1000) || null,
    province: text(input.province, 120) || customer.province, canton: text(input.canton, 120) || customer.canton, district: text(input.district, 120) || customer.district,
    latitude: input.latitude ?? customer.latitude, longitude: input.longitude ?? customer.longitude, scheduledDeliveryDate: input.scheduledDeliveryDate ?? null,
    estimatedArrivalDate: input.estimatedArrivalDate ?? null, expectedPaymentMethod: input.expectedPaymentMethod ?? customer.preferred_payment_method ?? null,
    deliveryFee: integer(input.deliveryFee ?? 0, "El costo de entrega", 0), deliveryNotes: text(input.deliveryNotes, 3000) || null, source: "CRM",
  });
  if (context.conversationId != null) {
    await linkChatwootConversationOrder(db, { accountId: context.accountId, conversationId: context.conversationId, orderId: result.order?.id, linkRole: "PRIMARY" });
    if (client && result.order?.id) await syncConversationOrder(db, client, context.accountId, context.conversationId, result.order.id);
  }
  return result;
}
