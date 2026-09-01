import { calculatePrices, settingsFromRow } from "./pricing";
import { financeSaleReversalStatements, financeSaleStatements } from "./finance";
import {
  ORDER_SOURCES,
  PAYMENT_METHODS,
  SPECIAL_ORDER_RECEIPT_MODES,
  SPECIAL_ORDER_STATUSES,
  OrderError,
  cleanText,
  costaRicaDate,
  integerValue,
  newOrderChildId,
  newOrderId,
  normalizeCostaRicaPhone,
  optionalCoordinate,
  optionalInteger,
  optionalText,
  orderRequestHash,
  paymentSummary,
  requiredOperationId,
  requiredVersion,
  type OrderSource,
  type OrderStatus,
  type PaymentMethod,
  type SpecialOrderReceiptMode,
  type SpecialOrderStatus,
} from "./orders";

type Row = Record<string, unknown>;

type ParsedLine = {
  id: string;
  position: number;
  productId: number | null;
  quantity: number;
  productNameSnapshot: string;
  presentationSnapshot: string | null;
  barcodeSnapshot: string | null;
  unitPriceOriginal: number | null;
  unitPriceSold: number;
  discountAmount: number;
  lineSubtotal: number;
  lineTotal: number;
  historicalCostSnapshot: number | null;
  existing: Row | null;
};

type ParsedOrder = {
  customerId: string | null;
  customerNameSnapshot: string;
  phoneRaw: string | null;
  phoneNormalized: string | null;
  deliveryAddress: string | null;
  deliveryInstructions: string | null;
  province: string | null;
  canton: string | null;
  district: string | null;
  latitude: number | null;
  longitude: number | null;
  scheduledDeliveryDate: string | null;
  orderType: "STANDARD" | "SPECIAL_ORDER";
  currency: "CRC";
  expectedPaymentMethod: PaymentMethod | null;
  estimatedArrivalDate: string | null;
  source: OrderSource;
  internalNotes: string | null;
  deliveryNotes: string | null;
  deliveryFee: number;
  subtotal: number;
  discountTotal: number;
  total: number;
  lines: ParsedLine[];
};

type OperationClaim = {
  orderId: string;
  replayed: boolean;
};

type MovementPlan = {
  lineId: string;
  productId: number;
  productName: string;
  barcode: string | null;
  movementType: string;
  quantityChange: number;
  reason: string | null;
  previousQuantity?: number;
  resultingQuantity?: number;
};

function asRow(value: unknown): Row {
  return value && typeof value === "object" ? value as Row : {};
}

function sourceValue(value: unknown, fallback: unknown): OrderSource {
  const source = cleanText(value ?? fallback, 40).toUpperCase();
  if (!ORDER_SOURCES.includes(source as OrderSource)) {
    throw new OrderError("El origen del pedido no es válido. Seleccioná un origen permitido; no se realizó ningún cambio.", 400, "ORDER_INVALID_SOURCE", "Origen inválido");
  }
  return source as OrderSource;
}

function expectedPaymentMethodValue(value: unknown, fallback: unknown): PaymentMethod | null {
  const method = cleanText(value ?? fallback, 20).toUpperCase();
  if (!method) return null;
  if (!PAYMENT_METHODS.includes(method as PaymentMethod)) {
    throw new OrderError("El método esperado de pago no es válido. Seleccioná Efectivo, SINPE, Tarjeta u Otro; no se realizó ningún cambio ni pago.", 400, "ORDER_EXPECTED_PAYMENT_METHOD_INVALID", "Método esperado inválido");
  }
  return method as PaymentMethod;
}

function productCostSnapshot(product: Row, settings: Row | null) {
  if (!settings || product.purchase_price_usd_cents == null || product.weight_milli_lb == null) return null;
  const prices = calculatePrices(
    Number(product.purchase_price_usd_cents) / 100,
    Number(product.weight_milli_lb) / 1000,
    settingsFromRow(settings),
  );
  return Number.isFinite(prices.costCrc) ? Math.round(prices.costCrc) : null;
}

async function parseOrderPayload(db: D1Database, payload: Record<string, unknown>, existingOrder: Row | null, existingLines: Row[]) {
  const sourceLines = Array.isArray(payload.lines) ? payload.lines.map(asRow).slice(0, 500) : null;
  if (!sourceLines || sourceLines.length === 0) {
    throw new OrderError("Agregá al menos un producto al pedido. El pedido conserva su estado anterior y el inventario no fue modificado.", 400, "ORDER_LINES_REQUIRED", "Pedido sin productos");
  }
  const orderType = cleanText(payload.orderType ?? existingOrder?.order_type ?? "STANDARD", 30).toUpperCase();
  if (!['STANDARD', 'SPECIAL_ORDER'].includes(orderType)) {
    throw new OrderError("El tipo de pedido no es válido. Elegí Entrega o Encargo; no se realizó ningún cambio.", 400, "ORDER_TYPE_INVALID", "Tipo de pedido inválido");
  }
  const currency = cleanText(payload.currency ?? existingOrder?.currency ?? "CRC", 3).toUpperCase();
  if (currency !== "CRC") {
    throw new OrderError("Esta fase de Pedidos solo admite montos en CRC. Corregí la moneda; no se realizó ningún cambio.", 400, "ORDER_CURRENCY_NOT_SUPPORTED", "Moneda no disponible");
  }
  const customerNameSnapshot = cleanText(payload.customerName ?? payload.customerNameSnapshot ?? existingOrder?.customer_name_snapshot, 250);
  if (!customerNameSnapshot) {
    throw new OrderError("Ingresá el nombre del cliente. El pedido no fue guardado y el inventario no fue modificado.", 400, "ORDER_CUSTOMER_REQUIRED", "Cliente requerido");
  }
  const phone = normalizeCostaRicaPhone(payload.phoneRaw ?? payload.phone ?? existingOrder?.phone_raw);
  const deliveryFee = integerValue(payload.deliveryFee ?? existingOrder?.delivery_fee ?? 0, "El costo de entrega", 0, 10_000_000);
  const existingById = new Map(existingLines.map((line) => [String(line.id), line]));
  const requestedIds = sourceLines.map((line) => cleanText(line.id, 100)).filter(Boolean);
  if (new Set(requestedIds).size !== requestedIds.length) {
    throw new OrderError("El pedido contiene una línea repetida. Actualizalo y volvé a intentarlo; no se realizó ningún cambio.", 409, "ORDER_DUPLICATE_LINE", "Línea repetida");
  }
  const requestedProductIds = [...new Set(sourceLines.map((line) => Number(line.productId)).filter((id) => Number.isInteger(id) && id > 0))];
  const productResult = requestedProductIds.length
    ? await db.prepare("SELECT * FROM products WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(requestedProductIds)).all<Row>()
    : { results: [] as Row[] };
  const products = new Map(productResult.results.map((product) => [Number(product.id), product]));
  if (products.size !== requestedProductIds.length) {
    const missing = requestedProductIds.filter((id) => !products.has(id));
    throw new OrderError("Uno de los productos vinculados ya no existe. Seleccioná nuevamente el producto; no se realizó ningún cambio.", 409, "ORDER_PRODUCT_NOT_FOUND", "Producto no encontrado", { productIds: missing });
  }
  const settings = await db.prepare("SELECT * FROM settings WHERE id=1").first<Row>();
  const lines: ParsedLine[] = sourceLines.map((sourceLine, index) => {
    const suppliedId = cleanText(sourceLine.id, 100);
    const existing = suppliedId ? existingById.get(suppliedId) || null : null;
    if (suppliedId && !existing) {
      throw new OrderError("Una línea del pedido ya no coincide con la versión guardada. Actualizá el pedido; no se realizó ningún cambio.", 409, "ORDER_LINE_NOT_FOUND", "Pedido desactualizado");
    }
    const productIdRaw = sourceLine.productId;
    const productId = productIdRaw == null || productIdRaw === "" ? null : integerValue(productIdRaw, `El producto de la línea ${index + 1}`, 1, 2_147_483_647);
    const product = productId ? products.get(productId) || null : null;
    const sameHistoricalProduct = Boolean(existing && Number(existing.product_id || 0) === Number(productId || 0));
    const manualName = cleanText(sourceLine.productName ?? sourceLine.name, 500);
    const productNameSnapshot = product
      ? sameHistoricalProduct ? String(existing?.product_name_snapshot) : String(product.name)
      : manualName || (sameHistoricalProduct ? String(existing?.product_name_snapshot || "") : "");
    if (!productNameSnapshot) {
      throw new OrderError(`La línea ${index + 1} no tiene nombre de producto. Corregila; no se realizó ningún cambio.`, 400, "ORDER_LINE_NAME_REQUIRED", "Producto sin nombre");
    }
    const quantity = integerValue(sourceLine.quantity, `La cantidad de “${productNameSnapshot}”`, 1, 100_000);
    const unitPriceSold = integerValue(sourceLine.unitPriceSold, `El precio vendido de “${productNameSnapshot}”`, 0, 100_000_000);
    const unitPriceOriginal = optionalInteger(sourceLine.unitPriceOriginal, `El precio original de “${productNameSnapshot}”`, 0, 100_000_000);
    const lineSubtotal = quantity * unitPriceSold;
    const discountAmount = integerValue(sourceLine.discountAmount ?? 0, `El descuento de “${productNameSnapshot}”`, 0, lineSubtotal);
    return {
      id: suppliedId || newOrderChildId("oline"),
      position: index + 1,
      productId,
      quantity,
      productNameSnapshot,
      presentationSnapshot: product
        ? sameHistoricalProduct ? optionalText(existing?.presentation_snapshot, 300) : optionalText(product.presentation, 300)
        : optionalText(sourceLine.presentation ?? existing?.presentation_snapshot, 300),
      barcodeSnapshot: product
        ? sameHistoricalProduct ? optionalText(existing?.barcode_snapshot, 256) : optionalText(product.code, 256)
        : optionalText(sourceLine.barcode ?? existing?.barcode_snapshot, 256),
      unitPriceOriginal,
      unitPriceSold,
      discountAmount,
      lineSubtotal,
      lineTotal: lineSubtotal - discountAmount,
      historicalCostSnapshot: product
        ? sameHistoricalProduct ? optionalInteger(existing?.historical_cost_snapshot, "El costo histórico", 0, 100_000_000) : productCostSnapshot(product, settings)
        : null,
      existing,
    };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.lineSubtotal, 0);
  const discountTotal = lines.reduce((sum, line) => sum + line.discountAmount, 0);
  return {
    customerId: optionalText(payload.customerId ?? existingOrder?.customer_id, 100),
    customerNameSnapshot,
    phoneRaw: phone.raw,
    phoneNormalized: phone.normalized,
    deliveryAddress: optionalText(payload.deliveryAddress ?? existingOrder?.delivery_address, 2000),
    deliveryInstructions: optionalText(payload.deliveryInstructions ?? existingOrder?.delivery_instructions, 1000),
    province: optionalText(payload.province ?? existingOrder?.province, 120),
    canton: optionalText(payload.canton ?? existingOrder?.canton, 120),
    district: optionalText(payload.district ?? existingOrder?.district, 120),
    latitude: optionalCoordinate(payload.latitude ?? existingOrder?.latitude, "La latitud", -90, 90),
    longitude: optionalCoordinate(payload.longitude ?? existingOrder?.longitude, "La longitud", -180, 180),
    scheduledDeliveryDate: costaRicaDate(
      Object.hasOwn(payload, "scheduledDeliveryDate") ? payload.scheduledDeliveryDate : existingOrder?.scheduled_delivery_date,
      "La fecha de entrega",
    ),
    orderType: orderType as "STANDARD" | "SPECIAL_ORDER",
    currency: "CRC" as const,
    expectedPaymentMethod: expectedPaymentMethodValue(payload.expectedPaymentMethod, existingOrder?.expected_payment_method),
    estimatedArrivalDate: orderType === "SPECIAL_ORDER"
      ? costaRicaDate(payload.estimatedArrivalDate ?? existingOrder?.estimated_arrival_date, "La fecha estimada de llegada")
      : null,
    source: sourceValue(payload.source, existingOrder?.source ?? "MANUAL"),
    internalNotes: optionalText(payload.internalNotes ?? existingOrder?.internal_notes, 3000),
    deliveryNotes: optionalText(payload.deliveryNotes ?? existingOrder?.delivery_notes, 3000),
    deliveryFee,
    subtotal,
    discountTotal,
    total: subtotal - discountTotal + deliveryFee,
    lines,
  } satisfies ParsedOrder;
}

async function beginOperation(
  db: D1Database,
  candidateOrderId: string,
  operationType: string,
  operationId: string,
  payload: Record<string, unknown>,
  createOperation = false,
): Promise<OperationClaim> {
  const requestHash = await orderRequestHash(operationType, payload);
  const load = () => db.prepare("SELECT * FROM order_operations WHERE operation_id=? LIMIT 1").bind(operationId).first<Row>();
  let existing = await load();
  if (existing?.status === "pending") {
    await db.prepare(`DELETE FROM order_operations WHERE operation_id=? AND status='pending'
      AND julianday(replace(replace(created_at,'T',' '),'Z',''))<=julianday('now','-5 minutes')`).bind(operationId).run();
    existing = await load();
  }
  if (!existing) {
    const inserted = await db.prepare(`INSERT OR IGNORE INTO order_operations (
      operation_id,order_id,operation_type,request_hash,status,created_at
    ) VALUES (?,?,?,?,'pending',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(operationId, candidateOrderId, operationType, requestHash).run();
    if (Number(inserted.meta?.changes || 0) > 0) return { orderId: candidateOrderId, replayed: false };
    existing = await load();
  }
  if (!existing) throw new OrderError("No se pudo reservar la operación. Intentá nuevamente; no se realizó ningún cambio.", 409, "ORDER_OPERATION_NOT_CLAIMED", "Operación pendiente");
  if (String(existing.operation_type) !== operationType || String(existing.request_hash) !== requestHash
    || (!createOperation && String(existing.order_id) !== candidateOrderId)) {
    throw new OrderError("Ese operationId ya fue utilizado con otros datos. Generá uno nuevo; no se realizó ningún cambio.", 409, "ORDER_OPERATION_ID_CONFLICT", "Identificador ya utilizado");
  }
  for (let attempt = 0; attempt < 60 && String(existing.status) === "pending"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    existing = await load() || existing;
  }
  if (String(existing.status) !== "completed") {
    throw new OrderError("La misma operación todavía se está procesando. Esperá unos segundos y actualizá el pedido; no la envíes con otro identificador.", 409, "ORDER_OPERATION_IN_PROGRESS", "Operación en proceso");
  }
  return { orderId: String(existing.order_id), replayed: true };
}

async function completedOperation(
  db: D1Database,
  orderId: string,
  operationType: string,
  operationId: string,
  payload: Record<string, unknown>,
) {
  const existing = await db.prepare("SELECT * FROM order_operations WHERE operation_id=? AND status='completed' LIMIT 1").bind(operationId).first<Row>();
  if (!existing) return false;
  const requestHash = await orderRequestHash(operationType, payload);
  if (String(existing.order_id) !== orderId || String(existing.operation_type) !== operationType || String(existing.request_hash) !== requestHash) {
    throw new OrderError("Ese operationId ya fue utilizado con otros datos. Generá uno nuevo; no se realizó ningún cambio.", 409, "ORDER_OPERATION_ID_CONFLICT", "Identificador ya utilizado");
  }
  return true;
}

async function abandonOperation(db: D1Database, operationId: string) {
  await db.prepare("DELETE FROM order_operations WHERE operation_id=? AND status='pending'").bind(operationId).run().catch(() => undefined);
}

function completeOperationStatement(db: D1Database, operationId: string, orderId: string, now: string) {
  return db.prepare(`UPDATE order_operations SET status='completed',response_json=?,completed_at=?
    WHERE operation_id=? AND status='pending'`).bind(JSON.stringify({ orderId }), now, operationId);
}

function guardStatement(db: D1Database, operationId: string, orderId: string, version: number, statuses: OrderStatus[]) {
  return db.prepare(`UPDATE order_operations SET guard=(SELECT CASE WHEN EXISTS (
    SELECT 1 FROM orders WHERE id=? AND version=? AND status IN (SELECT value FROM json_each(?))
  ) THEN 1 ELSE 0 END) WHERE operation_id=?`).bind(orderId, version, JSON.stringify(statuses), operationId);
}

function lineInsertStatement(db: D1Database, orderId: string, line: ParsedLine, now: string) {
  return db.prepare(`INSERT INTO order_lines (
    id,order_id,position,product_id,quantity,product_name_snapshot,presentation_snapshot,barcode_snapshot,
    unit_price_original,unit_price_sold,discount_amount,line_subtotal,line_total,historical_cost_snapshot,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    line.id, orderId, line.position, line.productId, line.quantity, line.productNameSnapshot,
    line.presentationSnapshot, line.barcodeSnapshot, line.unitPriceOriginal, line.unitPriceSold,
    line.discountAmount, line.lineSubtotal, line.lineTotal, line.historicalCostSnapshot, now, now,
  );
}

function orderHeaderBindings(parsed: ParsedOrder) {
  return [
    parsed.orderType, parsed.customerId, parsed.customerNameSnapshot, parsed.phoneRaw, parsed.phoneNormalized,
    parsed.deliveryAddress, parsed.deliveryInstructions, parsed.province, parsed.canton, parsed.district,
    parsed.latitude, parsed.longitude, parsed.scheduledDeliveryDate, parsed.currency, parsed.subtotal,
    parsed.discountTotal, parsed.deliveryFee, parsed.total, parsed.expectedPaymentMethod, parsed.internalNotes, parsed.deliveryNotes, parsed.source,
  ];
}

function eventStatement(db: D1Database, orderId: string, eventType: string, operationId: string, payload: unknown, now: string) {
  return db.prepare(`INSERT INTO order_events (id,order_id,event_type,payload_json,operation_id,actor_principal,created_at)
    VALUES (?,?,?,?,?,NULL,?)`).bind(newOrderChildId("oevent"), orderId, eventType, JSON.stringify(payload ?? {}), operationId, now);
}

function statusEventStatement(db: D1Database, orderId: string, fromStatus: string | null, toStatus: string, operationId: string, reason: string | null, now: string) {
  return db.prepare(`INSERT INTO order_status_events (id,order_id,from_status,to_status,reason,operation_id,actor_principal,created_at)
    VALUES (?,?,?,?,?,?,NULL,?)`).bind(newOrderChildId("osevent"), orderId, fromStatus, toStatus, reason, operationId, now);
}

function assignMovementQuantities(plans: MovementPlan[], products: Map<number, Row>) {
  const stock = new Map([...products].map(([id, row]) => [id, Number(row.quantity_available || 0)]));
  return plans.map((plan) => {
    const previousQuantity = stock.get(plan.productId);
    if (previousQuantity == null) {
      throw new OrderError(`El producto “${plan.productName}” ya no existe. Actualizá el pedido; no se realizó ningún cambio.`, 409, "ORDER_PRODUCT_NOT_FOUND", "Producto no encontrado", { productId: plan.productId });
    }
    const resultingQuantity = previousQuantity + plan.quantityChange;
    stock.set(plan.productId, resultingQuantity);
    return { ...plan, previousQuantity, resultingQuantity };
  });
}

function movementStatement(db: D1Database, orderId: string, operationId: string, plan: MovementPlan, now: string) {
  return db.prepare(`INSERT INTO inventory_movements (
    id,operation_id,original_movement_id,document_line_id,order_id,order_line_id,movement_type,
    product_id,product_name,barcode,canonical_barcode,secondary_id,secondary_type,previous_quantity,
    quantity_change,conversion,resulting_quantity,barcode_method,barcode_source,confirmed_by,reason,created_at
  ) VALUES (?,?,NULL,NULL,?,?,?,?,?,?,NULL,NULL,NULL,?,?,1,?,NULL,'Pedidos',NULL,?,?)`).bind(
    newOrderChildId("mov"), operationId, orderId, plan.lineId, plan.movementType,
    plan.productId, plan.productName, plan.barcode, plan.previousQuantity, plan.quantityChange,
    plan.resultingQuantity, plan.reason, now,
  );
}

async function productsForLines(db: D1Database, lines: Array<{ product_id?: unknown; productId?: number | null }>) {
  const ids = [...new Set(lines.map((line) => Number(line.productId ?? line.product_id)).filter((id) => Number.isInteger(id) && id > 0))];
  const result = ids.length
    ? await db.prepare("SELECT * FROM products WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all<Row>()
    : { results: [] as Row[] };
  return new Map(result.results.map((row) => [Number(row.id), row]));
}

function insufficientStock(lines: Array<{ productId: number; productName: string; required: number }>, products: Map<number, Row>) {
  const aggregate = new Map<number, { productId: number; productName: string; required: number; available: number; missing: number }>();
  lines.forEach((line) => {
    const current = aggregate.get(line.productId) || {
      productId: line.productId,
      productName: line.productName,
      required: 0,
      available: Number(products.get(line.productId)?.quantity_available || 0),
      missing: 0,
    };
    current.required += line.required;
    current.missing = Math.max(0, current.required - current.available);
    aggregate.set(line.productId, current);
  });
  return [...aggregate.values()].filter((entry) => entry.missing > 0);
}

function throwInsufficient(shortages: Array<{ productId: number; productName: string; required: number; available: number; missing: number }>) {
  if (!shortages.length) return;
  const first = shortages[0];
  throw new OrderError(
    `Faltan ${first.missing} unidades de “${first.productName}”. Revisá el inventario o ajustá la cantidad. El pedido continúa en su estado anterior y no se modificó ningún producto.`,
    409,
    "ORDER_INSUFFICIENT_STOCK",
    "Stock insuficiente",
    { shortages },
  );
}

function orderHeaderFromRow(row: Row) {
  const paid = Number(row.paid_total || 0);
  const deliveredUnits = Number(row.delivered_units || 0);
  const returnedUnits = Number(row.returned_units || 0);
  return {
    id: String(row.id),
    orderNumber: String(row.order_number),
    orderType: String(row.order_type),
    customerId: row.customer_id ? String(row.customer_id) : null,
    customerName: String(row.customer_name_snapshot),
    phoneRaw: row.phone_raw ? String(row.phone_raw) : null,
    phoneNormalized: row.phone_normalized ? String(row.phone_normalized) : null,
    deliveryAddress: row.delivery_address ? String(row.delivery_address) : null,
    deliveryInstructions: row.delivery_instructions ? String(row.delivery_instructions) : null,
    province: row.province ? String(row.province) : null,
    canton: row.canton ? String(row.canton) : null,
    district: row.district ? String(row.district) : null,
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    scheduledDeliveryDate: row.scheduled_delivery_date ? String(row.scheduled_delivery_date) : null,
    routeId: row.route_id ? String(row.route_id) : null,
    routePosition: row.route_position == null ? null : Number(row.route_position),
    status: String(row.status),
    returnStatus: returnedUnits <= 0 ? "NONE" : returnedUnits >= deliveredUnits ? "RETURNED" : "PARTIALLY_RETURNED",
    currency: String(row.currency),
    subtotal: Number(row.subtotal),
    discountTotal: Number(row.discount_total),
    deliveryFee: Number(row.delivery_fee),
    total: Number(row.total),
    expectedPaymentMethod: row.expected_payment_method ? String(row.expected_payment_method) : null,
    specialOrderStatus: row.special_order_status ? String(row.special_order_status) : null,
    estimatedArrivalDate: row.estimated_arrival_date ? String(row.estimated_arrival_date) : null,
    receiptResolvedAt: row.receipt_resolved_at ? String(row.receipt_resolved_at) : null,
    ...paymentSummary(Number(row.total), paid),
    internalNotes: row.internal_notes ? String(row.internal_notes) : null,
    deliveryNotes: row.delivery_notes ? String(row.delivery_notes) : null,
    source: String(row.source),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    confirmedAt: row.confirmed_at ? String(row.confirmed_at) : null,
    preparedAt: row.prepared_at ? String(row.prepared_at) : null,
    deliveredAt: row.delivered_at ? String(row.delivered_at) : null,
    cancelledAt: row.cancelled_at ? String(row.cancelled_at) : null,
    reopenedAt: row.reopened_at ? String(row.reopened_at) : null,
    lineCount: Number(row.line_count || 0),
    unitTotal: Number(row.unit_total || 0),
    productSummary: row.product_summary ? String(row.product_summary) : null,
  };
}

function lineFromRow(row: Row) {
  const quantity = Number(row.quantity);
  const deliveredQuantity = Number(row.delivered_quantity || 0);
  const returnedQuantity = Number(row.returned_quantity || 0);
  const receivedQuantity = Number(row.received_quantity || 0);
  return {
    id: String(row.id),
    position: Number(row.position),
    productId: row.product_id == null ? null : Number(row.product_id),
    quantity,
    productName: String(row.product_name_snapshot),
    presentation: row.presentation_snapshot ? String(row.presentation_snapshot) : null,
    barcode: row.barcode_snapshot ? String(row.barcode_snapshot) : null,
    unitPriceOriginal: row.unit_price_original == null ? null : Number(row.unit_price_original),
    unitPriceSold: Number(row.unit_price_sold),
    discountAmount: Number(row.discount_amount),
    lineSubtotal: Number(row.line_subtotal),
    lineTotal: Number(row.line_total),
    historicalCostSnapshot: row.historical_cost_snapshot == null ? null : Number(row.historical_cost_snapshot),
    deliveredQuantity,
    pendingDeliveryQuantity: Math.max(0, quantity - deliveredQuantity),
    returnedQuantity,
    receivedQuantity,
    pendingReceiptQuantity: Math.max(0, quantity - receivedQuantity),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    removedAt: row.removed_at ? String(row.removed_at) : null,
    removedReason: row.removed_reason ? String(row.removed_reason) : null,
  };
}

export async function loadOrder(db: D1Database, orderId: string) {
  const row = await db.prepare(`SELECT o.*,sd.special_order_status,sd.requested_at,sd.ordered_at,
    sd.estimated_arrival_date,sd.received_at,sd.receipt_resolved_at,
    sd.created_at AS special_created_at,sd.updated_at AS special_updated_at,
    COALESCE((SELECT SUM(CASE WHEN p.payment_type='PAYMENT' THEN p.amount ELSE -p.amount END)
      FROM order_payments p WHERE p.order_id=o.id AND p.status='POSTED'),0) AS paid_total
    ,COALESCE((SELECT SUM(fl.quantity) FROM order_fulfillment_lines fl
      JOIN order_fulfillments f ON f.id=fl.fulfillment_id WHERE f.order_id=o.id),0) AS delivered_units
    ,COALESCE((SELECT SUM(rl.quantity) FROM order_return_lines rl
      JOIN order_returns r ON r.id=rl.return_id WHERE r.order_id=o.id AND r.status='COMPLETED'),0) AS returned_units
    FROM orders o LEFT JOIN special_order_details sd ON sd.order_id=o.id WHERE o.id=? LIMIT 1`).bind(orderId).first<Row>();
  if (!row) return null;
  const [lines, payments, route, receiptLines] = await Promise.all([
    db.prepare(`SELECT l.*,
      COALESCE((SELECT SUM(fl.quantity) FROM order_fulfillment_lines fl
        JOIN order_fulfillments f ON f.id=fl.fulfillment_id WHERE fl.order_line_id=l.id),0) AS delivered_quantity,
      COALESCE((SELECT SUM(rl.quantity) FROM order_return_lines rl
        JOIN order_returns r ON r.id=rl.return_id WHERE rl.order_line_id=l.id AND r.status='COMPLETED'),0) AS returned_quantity
      ,COALESCE((SELECT SUM(srl.quantity_received) FROM special_order_receipt_lines srl
        JOIN special_order_receipts sr ON sr.id=srl.receipt_id WHERE srl.order_line_id=l.id AND sr.order_id=l.order_id),0) AS received_quantity
      FROM order_lines l WHERE l.order_id=? ORDER BY l.removed_at IS NOT NULL,l.position,l.id`).bind(orderId).all<Row>(),
    db.prepare("SELECT * FROM order_payments WHERE order_id=? ORDER BY created_at,id").bind(orderId).all<Row>(),
    db.prepare(`SELECT ro.*,r.route_date,r.label,r.status AS route_status FROM route_orders ro
      JOIN delivery_routes r ON r.id=ro.route_id WHERE ro.order_id=? AND ro.removed_at IS NULL LIMIT 1`).bind(orderId).first<Row>(),
    db.prepare(`SELECT sr.id AS receipt_id,sr.resolution_mode,sr.operation_id,sr.resolved_at,sr.created_at,
      srl.id AS receipt_line_id,srl.order_line_id,srl.product_id,srl.quantity_received,srl.inventory_movement_created
      FROM special_order_receipts sr JOIN special_order_receipt_lines srl ON srl.receipt_id=sr.id
      WHERE sr.order_id=? ORDER BY sr.resolved_at,sr.id,srl.id`).bind(orderId).all<Row>(),
  ]);
  const receiptMap = new Map<string, { id: string; resolutionMode: string; operationId: string; resolvedAt: string; createdAt: string; lines: Array<Record<string, unknown>> }>();
  receiptLines.results.forEach((entry) => {
    const receiptId = String(entry.receipt_id);
    const receipt = receiptMap.get(receiptId) || {
      id: receiptId,
      resolutionMode: String(entry.resolution_mode),
      operationId: String(entry.operation_id),
      resolvedAt: String(entry.resolved_at),
      createdAt: String(entry.created_at),
      lines: [],
    };
    receipt.lines.push({
      id: String(entry.receipt_line_id),
      orderLineId: String(entry.order_line_id),
      productId: Number(entry.product_id),
      quantityReceived: Number(entry.quantity_received),
      inventoryMovementCreated: Number(entry.inventory_movement_created) === 1,
    });
    receiptMap.set(receiptId, receipt);
  });
  return {
    ...orderHeaderFromRow(row),
    lines: lines.results.filter((line) => !line.removed_at).map(lineFromRow),
    removedLines: lines.results.filter((line) => Boolean(line.removed_at)).map(lineFromRow),
    payments: payments.results.map((payment) => ({
      id: String(payment.id),
      amount: Number(payment.amount),
      currency: String(payment.currency),
      method: String(payment.method),
      type: String(payment.payment_type),
      status: String(payment.status),
      reference: payment.reference ? String(payment.reference) : null,
      reversesPaymentId: payment.reverses_payment_id ? String(payment.reverses_payment_id) : null,
      reason: payment.reason ? String(payment.reason) : null,
      operationId: String(payment.operation_id),
      createdAt: String(payment.created_at),
    })),
    route: route ? {
      id: String(route.route_id),
      date: String(route.route_date),
      label: route.label ? String(route.label) : null,
      status: String(route.route_status),
      position: Number(route.position),
    } : null,
    specialOrder: String(row.order_type) === "SPECIAL_ORDER" ? {
      status: String(row.special_order_status),
      requestedAt: String(row.requested_at),
      orderedAt: row.ordered_at ? String(row.ordered_at) : null,
      estimatedArrivalDate: row.estimated_arrival_date ? String(row.estimated_arrival_date) : null,
      receivedAt: row.received_at ? String(row.received_at) : null,
      receiptResolvedAt: row.receipt_resolved_at ? String(row.receipt_resolved_at) : null,
      createdAt: String(row.special_created_at),
      updatedAt: String(row.special_updated_at),
      receipts: [...receiptMap.values()],
    } : null,
  };
}

export async function listOrders(db: D1Database, request: Request) {
  const url = new URL(request.url);
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (clause: string, ...bindings: unknown[]) => { clauses.push(clause); values.push(...bindings); };
  const date = costaRicaDate(url.searchParams.get("date"), "La fecha");
  const from = costaRicaDate(url.searchParams.get("from"), "La fecha inicial");
  const to = costaRicaDate(url.searchParams.get("to"), "La fecha final");
  if (date) add("o.scheduled_delivery_date=?", date);
  if (from) add("o.scheduled_delivery_date>=?", from);
  if (to) add("o.scheduled_delivery_date<=?", to);
  const status = cleanText(url.searchParams.get("status"), 30).toUpperCase();
  if (status) add("o.status=?", status);
  const orderType = cleanText(url.searchParams.get("orderType"), 30).toUpperCase();
  if (orderType) add("o.order_type=?", orderType);
  const phone = normalizeCostaRicaPhone(url.searchParams.get("phone"));
  if (phone.normalized) add("o.phone_normalized=?", phone.normalized);
  const orderNumber = cleanText(url.searchParams.get("orderNumber"), 30);
  if (orderNumber) add("o.order_number LIKE ?", `%${orderNumber}%`);
  const product = cleanText(url.searchParams.get("product"), 200).toLowerCase();
  if (product) add("EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id=o.id AND l.removed_at IS NULL AND lower(l.product_name_snapshot) LIKE ?)", `%${product}%`);
  const search = cleanText(url.searchParams.get("search"), 250).toLowerCase();
  if (search) {
    const phoneSearch = search.replace(/\D/g, "");
    const like = `%${search}%`;
    const phoneLike = `%${phoneSearch}%`;
    add(`(lower(o.order_number) LIKE ? OR lower(o.customer_name_snapshot) LIKE ? OR lower(COALESCE(o.phone_raw,'')) LIKE ?
      OR replace(replace(replace(replace(COALESCE(o.phone_normalized,''),'+',''),'-',''),' ',''),'(', '') LIKE ?
      OR EXISTS (SELECT 1 FROM order_lines ls WHERE ls.order_id=o.id AND ls.removed_at IS NULL AND lower(ls.product_name_snapshot) LIKE ?))`,
    like, like, like, phoneLike, like);
  }
  if (url.searchParams.get("active") === "1") add("o.status NOT IN ('DELIVERED','CANCELLED')");
  const paymentStatus = cleanText(url.searchParams.get("paymentStatus"), 20).toUpperCase();
  if (paymentStatus) {
    const paidSql = `COALESCE((SELECT SUM(CASE WHEN px.payment_type='PAYMENT' THEN px.amount ELSE -px.amount END)
      FROM order_payments px WHERE px.order_id=o.id AND px.status='POSTED'),0)`;
    if (paymentStatus === "PAID") add(`${paidSql}>=o.total`);
    else if (paymentStatus === "PARTIAL") add(`${paidSql}>0 AND ${paidSql}<o.total`);
    else if (paymentStatus === "PENDING") add(`${paidSql}=0`);
    else throw new OrderError("El filtro de pago no es válido. Usá PENDING, PARTIAL o PAID.", 400, "ORDER_INVALID_PAYMENT_FILTER", "Filtro inválido");
  }
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 25));
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const [result, count] = await Promise.all([
    db.prepare(`SELECT o.*,sd.special_order_status,sd.estimated_arrival_date,sd.receipt_resolved_at,
      COALESCE((SELECT SUM(CASE WHEN p.payment_type='PAYMENT' THEN p.amount ELSE -p.amount END)
        FROM order_payments p WHERE p.order_id=o.id AND p.status='POSTED'),0) AS paid_total,
      COALESCE((SELECT COUNT(*) FROM order_lines l WHERE l.order_id=o.id AND l.removed_at IS NULL),0) AS line_count,
      COALESCE((SELECT SUM(l.quantity) FROM order_lines l WHERE l.order_id=o.id AND l.removed_at IS NULL),0) AS unit_total,
      (SELECT GROUP_CONCAT(l.product_name_snapshot||' × '||l.quantity,' · ')
        FROM order_lines l WHERE l.order_id=o.id AND l.removed_at IS NULL) AS product_summary,
      COALESCE((SELECT SUM(fl.quantity) FROM order_fulfillment_lines fl
        JOIN order_fulfillments f ON f.id=fl.fulfillment_id WHERE f.order_id=o.id),0) AS delivered_units,
      COALESCE((SELECT SUM(rl.quantity) FROM order_return_lines rl
        JOIN order_returns r ON r.id=rl.return_id WHERE r.order_id=o.id AND r.status='COMPLETED'),0) AS returned_units,
      (SELECT ro.position FROM route_orders ro WHERE ro.order_id=o.id AND ro.removed_at IS NULL LIMIT 1) AS route_position
      FROM orders o LEFT JOIN special_order_details sd ON sd.order_id=o.id ${where}
      ORDER BY COALESCE(o.scheduled_delivery_date,'9999-12-31'),
        CASE WHEN route_position IS NULL THEN 1 ELSE 0 END,route_position,o.created_at DESC,o.id DESC LIMIT ? OFFSET ?`)
      .bind(...values, limit, (page - 1) * limit).all<Row>(),
    db.prepare(`SELECT COUNT(*) AS total FROM orders o ${where}`).bind(...values).first<{ total: number }>(),
  ]);
  return { orders: result.results.map(orderHeaderFromRow), page, limit, total: Number(count?.total || 0) };
}

export async function createOrder(db: D1Database, payload: Record<string, unknown>) {
  const operationId = requiredOperationId(payload);
  const parsed = await parseOrderPayload(db, payload, null, []);
  if (parsed.orderType === "SPECIAL_ORDER" && parsed.scheduledDeliveryDate) {
    throw new OrderError("La fecha inicial del Encargo es la llegada estimada, no una entrega al cliente. Dejá la entrega sin fecha y programala después de resolver la recepción; todavía no se creó el Encargo ni se registró ningún pago.", 400, "SPECIAL_ORDER_DELIVERY_BEFORE_RECEIPT", "Fecha de entrega anticipada");
  }
  const initialPaymentSource = payload.initialPayment == null ? null : asRow(payload.initialPayment);
  let initialPayment: { amount: number; method: PaymentMethod } | null = null;
  if (initialPaymentSource) {
    const amount = integerValue(initialPaymentSource.amount, "El monto del abono inicial", 1, parsed.total);
    const method = cleanText(initialPaymentSource.method, 20).toUpperCase() as PaymentMethod;
    if (!PAYMENT_METHODS.includes(method)) throw new OrderError("Seleccioná un método válido para el abono inicial. El pedido todavía no se creó y no se registró ningún pago.", 400, "ORDER_PAYMENT_METHOD_INVALID", "Método inválido");
    initialPayment = { amount, method };
  }
  const candidateId = newOrderId();
  const claim = await beginOperation(db, candidateId, "CREATE", operationId, payload, true);
  if (claim.replayed) return { order: await loadOrder(db, claim.orderId), idempotent: true };
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    db.prepare("INSERT INTO order_number_allocations (order_id,allocated_at) VALUES (?,?)").bind(claim.orderId, now),
    db.prepare(`INSERT INTO orders (
      id,order_number,order_type,customer_id,customer_name_snapshot,phone_raw,phone_normalized,
      delivery_address,delivery_instructions,province,canton,district,latitude,longitude,scheduled_delivery_date,
      route_id,status,currency,subtotal,discount_total,delivery_fee,total,expected_payment_method,internal_notes,delivery_notes,source,
      version,created_at,updated_at
    ) SELECT ?,'NP-'||printf('%06d',sequence),?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'DRAFT',?,?,?,?,?,?,?,?,?,1,?,?
      FROM order_number_allocations WHERE order_id=?`).bind(
      claim.orderId, ...orderHeaderBindings(parsed), now, now, claim.orderId,
    ),
    ...parsed.lines.map((line) => lineInsertStatement(db, claim.orderId, line, now)),
    ...(parsed.orderType === "SPECIAL_ORDER" ? [db.prepare(`INSERT INTO special_order_details (
      order_id,special_order_status,requested_at,estimated_arrival_date,created_at,updated_at
    ) VALUES (?,'REQUESTED',?,?,?,?)`).bind(claim.orderId, now, parsed.estimatedArrivalDate, now, now)] : []),
    ...(initialPayment ? [db.prepare(`INSERT INTO order_payments (
      id,order_id,amount,currency,method,payment_type,status,reference,reverses_payment_id,reason,operation_id,created_at
    ) VALUES (?,?,?,'CRC',?,'PAYMENT','POSTED','Abono inicial del pedido',NULL,NULL,?,?)`).bind(
      newOrderChildId("payment"), claim.orderId, initialPayment.amount, initialPayment.method, `${operationId}:initial-payment`, now,
    ), eventStatement(db, claim.orderId, "payment.recorded", operationId, { type: "PAYMENT", amount: initialPayment.amount, method: initialPayment.method, initial: true }, now)] : []),
    statusEventStatement(db, claim.orderId, null, "DRAFT", operationId, null, now),
    eventStatement(db, claim.orderId, "order.created", operationId, { source: parsed.source }, now),
    completeOperationStatement(db, operationId, claim.orderId, now),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    await abandonOperation(db, operationId);
    throw error;
  }
  return { order: await loadOrder(db, claim.orderId), idempotent: false };
}

async function openRouteTarget(db: D1Database, date: string) {
  const existing = await db.prepare("SELECT id FROM delivery_routes WHERE route_date=? AND status='OPEN' ORDER BY created_at,id LIMIT 1")
    .bind(date).first<{ id: string }>();
  const id = existing?.id || newOrderChildId("route");
  const maximum = existing
    ? await db.prepare("SELECT COALESCE(MAX(position),0) AS maximum FROM route_orders WHERE route_id=? AND removed_at IS NULL")
      .bind(id).first<{ maximum: number }>()
    : null;
  return { id, create: !existing, position: Number(maximum?.maximum || 0) + 1 };
}

export async function updateOrder(db: D1Database, orderId: string, payload: Record<string, unknown>) {
  const operationId = requiredOperationId(payload);
  if (await completedOperation(db, orderId, "UPDATE", operationId, payload)) return { order: await loadOrder(db, orderId), idempotent: true };
  const version = requiredVersion(payload);
  const current = await db.prepare(`SELECT o.*,sd.special_order_status,sd.estimated_arrival_date,sd.receipt_resolved_at
    FROM orders o LEFT JOIN special_order_details sd ON sd.order_id=o.id WHERE o.id=? LIMIT 1`).bind(orderId).first<Row>();
  if (!current) throw new OrderError("No encontramos el pedido. Actualizá la lista; no se realizó ningún cambio.", 404, "ORDER_NOT_FOUND", "Pedido no encontrado");
  const status = String(current.status) as OrderStatus;
  if (!["DRAFT", "CONFIRMED", "REOPENED"].includes(status)) {
    throw new OrderError(
      status === "DELIVERED"
        ? "El pedido ya fue entregado. Usá Reabrir/Corregir pedido e indicá el motivo; no se realizó ningún cambio."
        : "El estado actual no permite editar el pedido. Actualizalo y utilizá la operación correspondiente; no se realizó ningún cambio.",
      409,
      "ORDER_EDIT_FORBIDDEN",
      "Pedido bloqueado",
    );
  }
  const existingResult = await db.prepare("SELECT * FROM order_lines WHERE order_id=? AND removed_at IS NULL ORDER BY position,id").bind(orderId).all<Row>();
  const parsed = await parseOrderPayload(db, payload, current, existingResult.results);
  if (parsed.orderType !== String(current.order_type)) {
    throw new OrderError("El tipo Entrega/Encargo no puede cambiarse después de crear el pedido. Creá un pedido del tipo correcto; no se realizó ningún cambio.", 409, "ORDER_TYPE_IMMUTABLE", "Tipo de pedido protegido");
  }
  let hasSpecialReceipts = false;
  if (parsed.orderType === "SPECIAL_ORDER") {
    const receiptCount = await db.prepare("SELECT COUNT(*) AS total FROM special_order_receipts WHERE order_id=?").bind(orderId).first<{ total: number }>();
    hasSpecialReceipts = Number(receiptCount?.total || 0) > 0;
    if (hasSpecialReceipts) {
      const sameReceivedLines = existingResult.results.length === parsed.lines.length && parsed.lines.every((line) => {
        const existing = line.existing;
        return Boolean(existing)
          && Number(existing?.product_id || 0) === Number(line.productId || 0)
          && Number(existing?.quantity) === line.quantity;
      });
      if (!sameReceivedLines) {
        throw new OrderError("El Encargo ya tiene una recepción registrada. Podés editar cliente, precio, notas o fechas, pero no cambiar productos ni cantidades recibidas. El pedido, los pagos y el inventario conservaron su estado anterior.", 409, "SPECIAL_ORDER_RECEIPT_LOCKED", "Recepción protegida");
      }
    }
  }
  const claim = await beginOperation(db, orderId, "UPDATE", operationId, payload);
  if (claim.replayed) return { order: await loadOrder(db, orderId), idempotent: true };
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [guardStatement(db, operationId, orderId, version, [status])];

  if (status === "DRAFT" && !hasSpecialReceipts) {
    statements.push(db.prepare("DELETE FROM order_lines WHERE order_id=?").bind(orderId));
    statements.push(...parsed.lines.map((line) => lineInsertStatement(db, orderId, line, now)));
  } else if (status === "DRAFT") {
    parsed.lines.forEach((line) => statements.push(db.prepare(`UPDATE order_lines SET position=?,product_id=?,quantity=?,product_name_snapshot=?,presentation_snapshot=?,
      barcode_snapshot=?,unit_price_original=?,unit_price_sold=?,discount_amount=?,line_subtotal=?,line_total=?,historical_cost_snapshot=?,updated_at=?
      WHERE id=? AND order_id=? AND removed_at IS NULL`).bind(
      line.position, line.productId, line.quantity, line.productNameSnapshot, line.presentationSnapshot, line.barcodeSnapshot,
      line.unitPriceOriginal, line.unitPriceSold, line.discountAmount, line.lineSubtotal, line.lineTotal,
      line.historicalCostSnapshot, now, line.id, orderId,
    )));
  } else {
    const nextById = new Map(parsed.lines.filter((line) => line.existing).map((line) => [line.id, line]));
    const removed = existingResult.results.filter((line) => !nextById.has(String(line.id)));
    const oldProductRows = await productsForLines(db, existingResult.results);
    const newProductRows = await productsForLines(db, parsed.lines);
    const products = new Map([...oldProductRows, ...newProductRows]);
    const restores: MovementPlan[] = [];
    const reserves: MovementPlan[] = [];

    removed.forEach((line) => {
      if (line.product_id != null) restores.push({
        lineId: String(line.id), productId: Number(line.product_id), productName: String(line.product_name_snapshot),
        barcode: line.barcode_snapshot ? String(line.barcode_snapshot) : null, movementType: "ORDER_EDIT_REMOVE",
        quantityChange: Number(line.quantity), reason: "Línea eliminada de pedido confirmado",
      });
    });
    parsed.lines.forEach((line) => {
      const old = line.existing;
      if (!old && line.productId) {
        reserves.push({ lineId: line.id, productId: line.productId, productName: line.productNameSnapshot, barcode: line.barcodeSnapshot, movementType: "ORDER_EDIT_ADD", quantityChange: -line.quantity, reason: "Línea agregada a pedido confirmado" });
        return;
      }
      if (!old) return;
      const oldProductId = old.product_id == null ? null : Number(old.product_id);
      const oldQuantity = Number(old.quantity);
      if (oldProductId && oldProductId !== line.productId) {
        restores.push({ lineId: line.id, productId: oldProductId, productName: String(old.product_name_snapshot), barcode: old.barcode_snapshot ? String(old.barcode_snapshot) : null, movementType: "ORDER_EDIT_PRODUCT_RESTORE", quantityChange: oldQuantity, reason: "Producto sustituido en pedido confirmado" });
      }
      if (line.productId && oldProductId !== line.productId) {
        reserves.push({ lineId: line.id, productId: line.productId, productName: line.productNameSnapshot, barcode: line.barcodeSnapshot, movementType: "ORDER_EDIT_PRODUCT_RESERVE", quantityChange: -line.quantity, reason: "Producto sustituido en pedido confirmado" });
      } else if (line.productId && oldProductId === line.productId && line.quantity !== oldQuantity) {
        const delta = oldQuantity - line.quantity;
        (delta > 0 ? restores : reserves).push({
          lineId: line.id, productId: line.productId, productName: line.productNameSnapshot, barcode: line.barcodeSnapshot,
          movementType: delta > 0 ? "ORDER_EDIT_DECREASE" : "ORDER_EDIT_INCREASE", quantityChange: delta,
          reason: "Cantidad corregida en pedido confirmado",
        });
      }
    });
    const allPlans = [...restores, ...reserves];
    const required = new Map<number, { productId: number; productName: string; required: number }>();
    allPlans.forEach((plan) => {
      const currentRequired = required.get(plan.productId) || { productId: plan.productId, productName: plan.productName, required: 0 };
      currentRequired.required -= plan.quantityChange;
      required.set(plan.productId, currentRequired);
    });
    let assigned: Array<MovementPlan & { previousQuantity: number; resultingQuantity: number }>;
    try {
      throwInsufficient(insufficientStock([...required.values()].filter((item) => item.required > 0), products));
      assigned = assignMovementQuantities(allPlans, products) as Array<MovementPlan & { previousQuantity: number; resultingQuantity: number }>;
    } catch (error) {
      await abandonOperation(db, operationId);
      throw error;
    }
    const assignedRestores = assigned.slice(0, restores.length);
    const assignedReserves = assigned.slice(restores.length);
    statements.push(...assignedRestores.map((plan) => movementStatement(db, orderId, operationId, plan, now)));
    statements.push(db.prepare("UPDATE order_lines SET position=position+1000000 WHERE order_id=? AND removed_at IS NULL").bind(orderId));
    removed.forEach((line) => statements.push(db.prepare("UPDATE order_lines SET removed_at=?,removed_reason=?,updated_at=? WHERE id=? AND order_id=? AND removed_at IS NULL")
      .bind(now, "Eliminada durante corrección del pedido", now, String(line.id), orderId)));
    parsed.lines.forEach((line) => {
      if (!line.existing) statements.push(lineInsertStatement(db, orderId, line, now));
      else statements.push(db.prepare(`UPDATE order_lines SET position=?,product_id=?,quantity=?,product_name_snapshot=?,presentation_snapshot=?,
        barcode_snapshot=?,unit_price_original=?,unit_price_sold=?,discount_amount=?,line_subtotal=?,line_total=?,historical_cost_snapshot=?,updated_at=?
        WHERE id=? AND order_id=? AND removed_at IS NULL`).bind(
        line.position, line.productId, line.quantity, line.productNameSnapshot, line.presentationSnapshot, line.barcodeSnapshot,
        line.unitPriceOriginal, line.unitPriceSold, line.discountAmount, line.lineSubtotal, line.lineTotal,
        line.historicalCostSnapshot, now, line.id, orderId,
      ));
    });
    statements.push(...assignedReserves.map((plan) => movementStatement(db, orderId, operationId, plan, now)));
  }

  statements.push(db.prepare(`UPDATE orders SET order_type=?,customer_id=?,customer_name_snapshot=?,phone_raw=?,phone_normalized=?,
    delivery_address=?,delivery_instructions=?,province=?,canton=?,district=?,latitude=?,longitude=?,scheduled_delivery_date=?,
    currency=?,subtotal=?,discount_total=?,delivery_fee=?,total=?,expected_payment_method=?,internal_notes=?,delivery_notes=?,source=?,version=version+1,updated_at=?
    WHERE id=? AND version=? AND status=?`).bind(...orderHeaderBindings(parsed), now, orderId, version, status));
  if (parsed.orderType === "SPECIAL_ORDER") {
    statements.push(db.prepare("UPDATE special_order_details SET estimated_arrival_date=?,updated_at=? WHERE order_id=?")
      .bind(parsed.estimatedArrivalDate, now, orderId));
  }
  statements.push(eventStatement(db, orderId, "order.updated", operationId, { status }, now));
  statements.push(completeOperationStatement(db, operationId, orderId, now));
  try {
    await db.batch(statements);
  } catch (error) {
    await abandonOperation(db, operationId);
    throw error;
  }
  return { order: await loadOrder(db, orderId), idempotent: false };
}

async function transitionOrder(
  db: D1Database,
  orderId: string,
  payload: Record<string, unknown>,
  operationType: string,
  fromStatus: OrderStatus,
  toStatus: OrderStatus,
  options: { reasonRequired?: boolean; timestampColumn?: string; eventType: string },
) {
  const operationId = requiredOperationId(payload);
  const version = requiredVersion(payload);
  const reason = optionalText(payload.reason, 1000);
  if (options.reasonRequired && (!reason || reason.length < 3)) {
    throw new OrderError("Indicá el motivo de esta operación. El pedido y el inventario conservaron su estado anterior.", 400, "ORDER_REASON_REQUIRED", "Motivo requerido");
  }
  if (await completedOperation(db, orderId, operationType, operationId, payload)) return { order: await loadOrder(db, orderId), idempotent: true };
  const current = await db.prepare("SELECT * FROM orders WHERE id=? LIMIT 1").bind(orderId).first<Row>();
  if (!current) throw new OrderError("No encontramos el pedido. Actualizá la lista; no se realizó ningún cambio.", 404, "ORDER_NOT_FOUND", "Pedido no encontrado");
  if (current.status !== fromStatus) throw new OrderError("El estado actual del pedido no permite esa acción. Actualizalo; no se realizó ningún cambio.", 409, "ORDER_INVALID_TRANSITION", "Transición no permitida");
  const claim = await beginOperation(db, orderId, operationType, operationId, payload);
  if (claim.replayed) return { order: await loadOrder(db, orderId), idempotent: true };
  const now = new Date().toISOString();
  const activeSale = toStatus === "REOPENED"
    ? await db.prepare("SELECT * FROM finance_sales WHERE order_id=? AND status='RECOGNIZED' LIMIT 1").bind(orderId).first<Row>()
    : null;
  const timestampSql = options.timestampColumn ? `,${options.timestampColumn}=?` : "";
  const bindings = options.timestampColumn ? [toStatus, now, now, orderId, version, fromStatus] : [toStatus, now, orderId, version, fromStatus];
  const statements: D1PreparedStatement[] = [
    guardStatement(db, operationId, orderId, version, [fromStatus]),
    db.prepare(`UPDATE orders SET status=?,version=version+1,updated_at=?${timestampSql} WHERE id=? AND version=? AND status=?`).bind(...bindings),
    ...(activeSale ? financeSaleReversalStatements(db, activeSale, operationId, reason || "Pedido reabierto para corrección", now) : []),
    statusEventStatement(db, orderId, fromStatus, toStatus, operationId, reason, now),
    eventStatement(db, orderId, options.eventType, operationId, reason ? { reason } : {}, now),
    completeOperationStatement(db, operationId, orderId, now),
  ];
  try { await db.batch(statements); }
  catch (error) { await abandonOperation(db, operationId); throw error; }
  return { order: await loadOrder(db, orderId), idempotent: false };
}

export async function confirmOrder(db: D1Database, orderId: string, payload: Record<string, unknown>) {
  const operationId = requiredOperationId(payload);
  if (await completedOperation(db, orderId, "CONFIRM", operationId, payload)) return { order: await loadOrder(db, orderId), idempotent: true };
  const version = requiredVersion(payload);
  const current = await db.prepare("SELECT * FROM orders WHERE id=? LIMIT 1").bind(orderId).first<Row>();
  if (!current) throw new OrderError("No encontramos el pedido. Actualizá la lista; no se realizó ningún cambio.", 404, "ORDER_NOT_FOUND", "Pedido no encontrado");
  const status = String(current.status) as OrderStatus;
  if (!["DRAFT", "REOPENED"].includes(status)) {
    throw new OrderError("El pedido no está en un estado que permita confirmarlo. Actualizalo; no se realizó ningún descuento adicional.", 409, "ORDER_CONFIRM_FORBIDDEN", "Confirmación no permitida");
  }
  const lines = await db.prepare("SELECT * FROM order_lines WHERE order_id=? AND removed_at IS NULL ORDER BY position,id").bind(orderId).all<Row>();
  if (!lines.results.length) throw new OrderError("El pedido no contiene productos. Agregá al menos uno; el inventario no fue modificado.", 409, "ORDER_LINES_REQUIRED", "Pedido sin productos");
  if (String(current.order_type) === "SPECIAL_ORDER") {
    const detail = await db.prepare("SELECT * FROM special_order_details WHERE order_id=? LIMIT 1").bind(orderId).first<Row>();
    if (!detail || !detail.receipt_resolved_at) {
      throw new OrderError("La recepción del Encargo todavía no está resuelta. Marcá si las unidades deben ingresar ahora o si ya fueron ingresadas mediante Facturas/Inventario. El pedido sigue en Borrador y no se modificó el inventario.", 409, "SPECIAL_ORDER_RECEIPT_UNRESOLVED", "Recepción pendiente");
    }
    const allowedSpecialStatuses = status === "REOPENED" ? ["DELIVERED"] : ["RECEIVED_READY", "ADDED_TO_ROUTE"];
    if (!allowedSpecialStatuses.includes(String(detail.special_order_status))) {
      throw new OrderError("El Encargo todavía no está listo para confirmar. Completá primero su flujo de proveedor y recepción; el pedido sigue en Borrador y no se modificó el inventario.", 409, "SPECIAL_ORDER_NOT_READY", "Encargo no listo");
    }
    const receiptTotals = await db.prepare(`SELECT l.id,l.product_id,l.quantity,
      COALESCE((SELECT SUM(srl.quantity_received) FROM special_order_receipt_lines srl
        JOIN special_order_receipts sr ON sr.id=srl.receipt_id WHERE sr.order_id=l.order_id AND srl.order_line_id=l.id),0) AS received_quantity
      FROM order_lines l WHERE l.order_id=? AND l.removed_at IS NULL`).bind(orderId).all<Row>();
    const unresolved = receiptTotals.results.filter((line) => line.product_id == null || Number(line.received_quantity || 0) < Number(line.quantity));
    if (unresolved.length) {
      throw new OrderError("Todas las líneas del Encargo deben estar vinculadas y recibidas antes de confirmar. Resolvé las cantidades pendientes; el pedido sigue en Borrador y no se modificó el inventario.", 409, "SPECIAL_ORDER_LINES_UNRESOLVED", "Productos pendientes", { lineIds: unresolved.map((line) => String(line.id)) });
    }
  }
  const products = await productsForLines(db, lines.results);
  const linked = lines.results.filter((line) => line.product_id != null).map((line) => ({
    productId: Number(line.product_id), productName: String(line.product_name_snapshot), required: Number(line.quantity),
  }));
  if (status === "DRAFT") throwInsufficient(insufficientStock(linked, products));
  const plans = status === "DRAFT" ? assignMovementQuantities(lines.results.flatMap((line) => line.product_id == null ? [] : [{
    lineId: String(line.id), productId: Number(line.product_id), productName: String(line.product_name_snapshot),
    barcode: line.barcode_snapshot ? String(line.barcode_snapshot) : null, movementType: "ORDER_CONFIRM",
    quantityChange: -Number(line.quantity), reason: null,
  }]), products) : [];
  const routeTarget = status === "DRAFT" && current.scheduled_delivery_date && !current.route_id
    ? await openRouteTarget(db, String(current.scheduled_delivery_date))
    : null;
  const claim = await beginOperation(db, orderId, "CONFIRM", operationId, payload);
  if (claim.replayed) return { order: await loadOrder(db, orderId), idempotent: true };
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [guardStatement(db, operationId, orderId, version, [status])];
  statements.push(...plans.map((plan) => movementStatement(db, orderId, operationId, plan, now)));
  if (routeTarget?.create) statements.push(db.prepare("INSERT INTO delivery_routes (id,route_date,label,status,created_at) VALUES (?,?,?,'OPEN',?)")
    .bind(routeTarget.id, String(current.scheduled_delivery_date), `Entregas ${String(current.scheduled_delivery_date)}`, now));
  statements.push(db.prepare(`UPDATE orders SET status='CONFIRMED',confirmed_at=COALESCE(confirmed_at,?),version=version+1,updated_at=?
    WHERE id=? AND version=? AND status=?`).bind(now, now, orderId, version, status));
  if (routeTarget) {
    statements.push(db.prepare("UPDATE route_orders SET removed_at=? WHERE order_id=? AND removed_at IS NULL").bind(now, orderId));
    statements.push(db.prepare("INSERT INTO route_orders (id,route_id,order_id,position,assigned_at) VALUES (?,?,?,?,?)")
      .bind(newOrderChildId("routeorder"), routeTarget.id, orderId, routeTarget.position, now));
    statements.push(db.prepare("UPDATE orders SET route_id=? WHERE id=?").bind(routeTarget.id, orderId));
    if (String(current.order_type) === "SPECIAL_ORDER") statements.push(db.prepare("UPDATE special_order_details SET special_order_status='ADDED_TO_ROUTE',updated_at=? WHERE order_id=? AND special_order_status='RECEIVED_READY'").bind(now, orderId));
  }
  statements.push(statusEventStatement(db, orderId, status, "CONFIRMED", operationId, null, now));
  statements.push(eventStatement(db, orderId, "order.confirmed", operationId, {}, now));
  statements.push(completeOperationStatement(db, operationId, orderId, now));
  try { await db.batch(statements); }
  catch (error) { await abandonOperation(db, operationId); throw error; }
  return { order: await loadOrder(db, orderId), idempotent: false };
}

export function prepareOrder(db: D1Database, orderId: string, payload: Record<string, unknown>) {
  return transitionOrder(db, orderId, payload, "PREPARE", "CONFIRMED", "PREPARED", { timestampColumn: "prepared_at", eventType: "order.prepared" });
}

export async function deliverOrder(db: D1Database, orderId: string, payload: Record<string, unknown>) {
  const operationId = requiredOperationId(payload);
  const version = requiredVersion(payload);
  if (await completedOperation(db, orderId, "DELIVER", operationId, payload)) return { order: await loadOrder(db, orderId), idempotent: true };
  const current = await db.prepare("SELECT * FROM orders WHERE id=? LIMIT 1").bind(orderId).first<Row>();
  if (!current) throw new OrderError("No encontramos el pedido. Actualizá la lista; no se realizó ningún cambio.", 404, "ORDER_NOT_FOUND", "Pedido no encontrado");
  if (current.status !== "PREPARED") throw new OrderError("Prepará el pedido antes de marcarlo como entregado. No se realizó ningún cambio ni se descontó inventario adicional.", 409, "ORDER_DELIVER_REQUIRES_PREPARED", "Pedido no preparado");
  const claim = await beginOperation(db, orderId, "DELIVER", operationId, payload);
  if (claim.replayed) return { order: await loadOrder(db, orderId), idempotent: true };
  const now = new Date().toISOString();
  const lines = await db.prepare(`SELECT l.*,
    COALESCE((SELECT SUM(fl.quantity) FROM order_fulfillment_lines fl JOIN order_fulfillments f ON f.id=fl.fulfillment_id
      WHERE fl.order_line_id=l.id),0) AS delivered_quantity
    FROM order_lines l WHERE l.order_id=? AND l.removed_at IS NULL ORDER BY l.position,l.id`).bind(orderId).all<Row>();
  const fulfillmentId = newOrderChildId("fulfillment");
  const pendingLines = lines.results.map((line) => ({ line, quantity: Math.max(0, Number(line.quantity) - Number(line.delivered_quantity || 0)) })).filter((item) => item.quantity > 0);
  const statements: D1PreparedStatement[] = [
    guardStatement(db, operationId, orderId, version, ["PREPARED"]),
    db.prepare("INSERT INTO order_fulfillments (id,order_id,status,operation_id,delivered_at) VALUES (?,?,'DELIVERED',?,?)").bind(fulfillmentId, orderId, operationId, now),
    ...pendingLines.map(({ line, quantity }) => db.prepare("INSERT INTO order_fulfillment_lines (id,fulfillment_id,order_line_id,quantity) VALUES (?,?,?,?)")
      .bind(newOrderChildId("fuline"), fulfillmentId, String(line.id), quantity)),
    db.prepare("UPDATE orders SET status='DELIVERED',delivered_at=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status='PREPARED'").bind(now, now, orderId, version),
    ...(current.order_type === "SPECIAL_ORDER" ? [db.prepare(`UPDATE special_order_details SET special_order_status='DELIVERED',updated_at=?
      WHERE order_id=? AND special_order_status='ADDED_TO_ROUTE'`).bind(now, orderId)] : []),
    statusEventStatement(db, orderId, "PREPARED", "DELIVERED", operationId, null, now),
    eventStatement(db, orderId, "order.delivered", operationId, { lineCount: pendingLines.length }, now),
    ...financeSaleStatements(db, current, lines.results, operationId, now),
    completeOperationStatement(db, operationId, orderId, now),
  ];
  try { await db.batch(statements); }
  catch (error) { await abandonOperation(db, operationId); throw error; }
  return { order: await loadOrder(db, orderId), idempotent: false };
}

export async function fulfillOrder(db: D1Database, orderId: string, payload: Record<string, unknown>) {
  const operationId = requiredOperationId(payload);
  if (await completedOperation(db, orderId, "FULFILL", operationId, payload)) {
    return { order: await loadOrder(db, orderId), idempotent: true };
  }
  const version = requiredVersion(payload);
  const current = await db.prepare("SELECT * FROM orders WHERE id=? LIMIT 1").bind(orderId).first<Row>();
  if (!current) throw new OrderError("No encontramos el pedido. Actualizá la lista; no se realizó ningún cambio.", 404, "ORDER_NOT_FOUND", "Pedido no encontrado");
  if (current.status !== "PREPARED") {
    throw new OrderError("Prepará el pedido antes de registrar una entrega total o parcial. No se realizó ningún cambio ni movimiento de inventario.", 409, "ORDER_FULFILL_REQUIRES_PREPARED", "Pedido no preparado");
  }
  const lines = await db.prepare(`SELECT l.*,
    COALESCE((SELECT SUM(fl.quantity) FROM order_fulfillment_lines fl
      JOIN order_fulfillments f ON f.id=fl.fulfillment_id WHERE fl.order_line_id=l.id),0) AS delivered_quantity
    FROM order_lines l WHERE l.order_id=? AND l.removed_at IS NULL ORDER BY l.position,l.id`).bind(orderId).all<Row>();
  const byId = new Map(lines.results.map((line) => [String(line.id), line]));
  const requested = Array.isArray(payload.lines) ? payload.lines.map(asRow).slice(0, 500) : [];
  if (!requested.length) {
    throw new OrderError("Seleccioná al menos un producto y la cantidad entregada. El pedido conserva su estado anterior.", 400, "ORDER_FULFILL_LINES_REQUIRED", "Entrega sin productos");
  }
  const parsed = requested.map((source, index) => {
    const lineId = cleanText(source.orderLineId ?? source.lineId, 100);
    const line = byId.get(lineId);
    if (!line) throw new OrderError(`La línea ${index + 1} no pertenece al pedido. Actualizalo; no se realizó ningún cambio.`, 409, "ORDER_FULFILL_LINE_NOT_FOUND", "Producto no encontrado");
    const quantity = integerValue(source.quantity, `La cantidad entregada de “${String(line.product_name_snapshot)}”`, 1, 100_000);
    const pending = Math.max(0, Number(line.quantity) - Number(line.delivered_quantity || 0));
    if (quantity > pending) {
      throw new OrderError(`Solo quedan ${pending} unidades pendientes de “${String(line.product_name_snapshot)}”. Corregí la cantidad; no se realizó ningún cambio.`, 409, "ORDER_FULFILL_EXCEEDS_PENDING", "Cantidad entregada inválida", { lineId, pending });
    }
    return { lineId, line, quantity };
  });
  if (new Set(parsed.map((entry) => entry.lineId)).size !== parsed.length) {
    throw new OrderError("La entrega contiene una línea repetida. Corregila; no se realizó ningún cambio.", 409, "ORDER_DUPLICATE_LINE", "Línea repetida");
  }
  const deliveredNow = new Map(parsed.map((entry) => [entry.lineId, entry.quantity]));
  const completed = lines.results.every((line) => Number(line.delivered_quantity || 0) + (deliveredNow.get(String(line.id)) || 0) >= Number(line.quantity));
  const pendingDate = completed ? null : costaRicaDate(payload.pendingDeliveryDate ?? payload.scheduledDeliveryDate, "La fecha de la entrega pendiente");
  const currentRoute = !completed && current.route_id
    ? await db.prepare("SELECT route_date FROM delivery_routes WHERE id=? LIMIT 1").bind(current.route_id).first<{ route_date: string }>()
    : null;
  const removeFromRoute = Boolean(!completed && current.route_id && pendingDate && currentRoute?.route_date !== pendingDate);
  const claim = await beginOperation(db, orderId, "FULFILL", operationId, payload);
  if (claim.replayed) return { order: await loadOrder(db, orderId), idempotent: true };
  const now = new Date().toISOString();
  const fulfillmentId = newOrderChildId("fulfillment");
  const statements: D1PreparedStatement[] = [
    guardStatement(db, operationId, orderId, version, ["PREPARED"]),
    db.prepare("INSERT INTO order_fulfillments (id,order_id,status,operation_id,delivered_at) VALUES (?,?,?,?,?)")
      .bind(fulfillmentId, orderId, completed ? "DELIVERED" : "PARTIAL", operationId, now),
    ...parsed.map((entry) => db.prepare("INSERT INTO order_fulfillment_lines (id,fulfillment_id,order_line_id,quantity) VALUES (?,?,?,?)")
      .bind(newOrderChildId("fuline"), fulfillmentId, entry.lineId, entry.quantity)),
    ...(removeFromRoute ? [db.prepare("UPDATE route_orders SET removed_at=? WHERE order_id=? AND removed_at IS NULL").bind(now, orderId)] : []),
    completed
      ? db.prepare("UPDATE orders SET status='DELIVERED',delivered_at=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status='PREPARED'")
        .bind(now, now, orderId, version)
      : db.prepare("UPDATE orders SET scheduled_delivery_date=COALESCE(?,scheduled_delivery_date),route_id=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status='PREPARED'")
        .bind(pendingDate, removeFromRoute ? null : current.route_id, now, orderId, version),
    ...(completed && current.order_type === "SPECIAL_ORDER" ? [db.prepare(`UPDATE special_order_details SET special_order_status='DELIVERED',updated_at=?
      WHERE order_id=? AND special_order_status='ADDED_TO_ROUTE'`).bind(now, orderId)] : []),
    ...(completed ? [statusEventStatement(db, orderId, "PREPARED", "DELIVERED", operationId, null, now)] : []),
    eventStatement(db, orderId, completed ? "order.delivered" : "order.partially_delivered", operationId, {
      fulfillmentId,
      completed,
      deliveredUnits: parsed.reduce((sum, entry) => sum + entry.quantity, 0),
      pendingDeliveryDate: pendingDate,
      removedFromRoute: removeFromRoute,
    }, now),
    ...(completed ? financeSaleStatements(db, current, lines.results, operationId, now) : []),
    completeOperationStatement(db, operationId, orderId, now),
  ];
  try { await db.batch(statements); }
  catch (error) { await abandonOperation(db, operationId); throw error; }
  return { order: await loadOrder(db, orderId), idempotent: false };
}

export async function cancelOrder(db: D1Database, orderId: string, payload: Record<string, unknown>) {
  const operationId = requiredOperationId(payload);
  if (await completedOperation(db, orderId, "CANCEL", operationId, payload)) return { order: await loadOrder(db, orderId), idempotent: true };
  const version = requiredVersion(payload);
  const reason = cleanText(payload.reason, 1000);
  if (reason.length < 3) throw new OrderError("Indicá el motivo de la cancelación. El pedido y el inventario conservaron su estado anterior.", 400, "ORDER_REASON_REQUIRED", "Motivo requerido");
  const order = await db.prepare("SELECT * FROM orders WHERE id=? LIMIT 1").bind(orderId).first<Row>();
  if (!order) throw new OrderError("No encontramos el pedido. Actualizá la lista; no se realizó ningún cambio.", 404, "ORDER_NOT_FOUND", "Pedido no encontrado");
  const status = String(order.status) as OrderStatus;
  if (!["DRAFT", "CONFIRMED", "PREPARED"].includes(status)) {
    throw new OrderError("Ese pedido no puede cancelarse directamente. Si fue entregado, utilizá Reabrir/Corregir o una devolución; no se realizó ningún cambio.", 409, "ORDER_CANCEL_FORBIDDEN", "Cancelación no permitida");
  }
  const lines = await db.prepare("SELECT * FROM order_lines WHERE order_id=? AND removed_at IS NULL ORDER BY position,id").bind(orderId).all<Row>();
  const products = await productsForLines(db, lines.results);
  const plans = status === "DRAFT" ? [] : assignMovementQuantities(lines.results.flatMap((line) => line.product_id == null ? [] : [{
    lineId: String(line.id), productId: Number(line.product_id), productName: String(line.product_name_snapshot),
    barcode: line.barcode_snapshot ? String(line.barcode_snapshot) : null, movementType: "ORDER_CANCEL",
    quantityChange: Number(line.quantity), reason,
  }]), products);
  const claim = await beginOperation(db, orderId, "CANCEL", operationId, payload);
  if (claim.replayed) return { order: await loadOrder(db, orderId), idempotent: true };
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [guardStatement(db, operationId, orderId, version, [status])];
  statements.push(...plans.map((plan) => movementStatement(db, orderId, operationId, plan, now)));
  statements.push(db.prepare("UPDATE orders SET status='CANCELLED',cancelled_at=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status=?")
    .bind(now, now, orderId, version, status));
  if (String(order.order_type) === "SPECIAL_ORDER") {
    statements.push(db.prepare(`UPDATE special_order_details SET special_order_status='CANCELLED',updated_at=?
      WHERE order_id=? AND special_order_status NOT IN ('DELIVERED','CANCELLED')`).bind(now, orderId));
  }
  statements.push(statusEventStatement(db, orderId, status, "CANCELLED", operationId, reason, now));
  statements.push(eventStatement(db, orderId, "order.cancelled", operationId, { reason }, now));
  statements.push(completeOperationStatement(db, operationId, orderId, now));
  try { await db.batch(statements); }
  catch (error) { await abandonOperation(db, operationId); throw error; }
  return { order: await loadOrder(db, orderId), idempotent: false };
}

export async function reprogramOrder(db: D1Database, orderId: string, payload: Record<string, unknown>) {
  const operationId = requiredOperationId(payload);
  if (await completedOperation(db, orderId, "REPROGRAM", operationId, payload)) return { order: await loadOrder(db, orderId), idempotent: true };
  const version = requiredVersion(payload);
  const newDate = costaRicaDate(payload.scheduledDeliveryDate, "La nueva fecha de entrega");
  if (!newDate) throw new OrderError("Seleccioná una nueva fecha de entrega. No se realizó ningún cambio.", 400, "ORDER_DATE_REQUIRED", "Fecha requerida");
  const current = await db.prepare("SELECT * FROM orders WHERE id=? LIMIT 1").bind(orderId).first<Row>();
  if (!current) throw new OrderError("No encontramos el pedido. Actualizá la lista; no se realizó ningún cambio.", 404, "ORDER_NOT_FOUND", "Pedido no encontrado");
  const status = String(current.status) as OrderStatus;
  if (!["DRAFT", "CONFIRMED", "PREPARED", "REOPENED"].includes(status)) throw new OrderError("El estado actual no permite reprogramar el pedido. No se realizó ningún cambio.", 409, "ORDER_REPROGRAM_FORBIDDEN", "Reprogramación no permitida");
  const reason = optionalText(payload.reason, 1000);
  const route = current.route_id
    ? await db.prepare("SELECT route_date FROM delivery_routes WHERE id=? LIMIT 1").bind(String(current.route_id)).first<{ route_date: string }>()
    : null;
  const removeFromRoute = Boolean(current.route_id && route?.route_date !== newDate);
  const routeTarget = removeFromRoute ? await openRouteTarget(db, newDate) : null;
  const claim = await beginOperation(db, orderId, "REPROGRAM", operationId, payload);
  if (claim.replayed) return { order: await loadOrder(db, orderId), idempotent: true };
  const now = new Date().toISOString();
  const statements = [
    guardStatement(db, operationId, orderId, version, [status]),
    ...(removeFromRoute ? [db.prepare("UPDATE route_orders SET removed_at=? WHERE order_id=? AND removed_at IS NULL").bind(now, orderId)] : []),
    ...(routeTarget?.create ? [db.prepare("INSERT INTO delivery_routes (id,route_date,label,status,created_at) VALUES (?,?,?,'OPEN',?)")
      .bind(routeTarget.id, newDate, `Entregas ${newDate}`, now)] : []),
    ...(routeTarget ? [db.prepare("INSERT INTO route_orders (id,route_id,order_id,position,assigned_at) VALUES (?,?,?,?,?)")
      .bind(newOrderChildId("routeorder"), routeTarget.id, orderId, routeTarget.position, now)] : []),
    db.prepare("UPDATE orders SET scheduled_delivery_date=?,route_id=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status=?")
      .bind(newDate, routeTarget?.id || current.route_id || null, now, orderId, version, status),
    eventStatement(db, orderId, "order.reprogrammed", operationId, { from: current.scheduled_delivery_date || null, to: newDate, reason, removedFromRoute: removeFromRoute }, now),
    completeOperationStatement(db, operationId, orderId, now),
  ];
  try { await db.batch(statements); }
  catch (error) { await abandonOperation(db, operationId); throw error; }
  return { order: await loadOrder(db, orderId), idempotent: false };
}

export function reopenOrder(db: D1Database, orderId: string, payload: Record<string, unknown>) {
  return transitionOrder(db, orderId, payload, "REOPEN", "DELIVERED", "REOPENED", { reasonRequired: true, timestampColumn: "reopened_at", eventType: "order.reopened" });
}

export async function recordPayment(db: D1Database, orderId: string, payload: Record<string, unknown>) {
  const operationId = requiredOperationId(payload);
  if (await completedOperation(db, orderId, "PAYMENT", operationId, payload)) return { order: await loadOrder(db, orderId), idempotent: true };
  const version = requiredVersion(payload);
  const order = await db.prepare(`SELECT o.*,
    COALESCE((SELECT SUM(CASE WHEN payment_type='PAYMENT' THEN amount ELSE -amount END) FROM order_payments WHERE order_id=o.id AND status='POSTED'),0) AS paid_total
    FROM orders o WHERE o.id=? LIMIT 1`).bind(orderId).first<Row>();
  if (!order) throw new OrderError("No encontramos el pedido. Actualizá la lista; no se realizó ningún cambio.", 404, "ORDER_NOT_FOUND", "Pedido no encontrado");
  if (String(order.status) === "CANCELLED") throw new OrderError("Un pedido cancelado no puede recibir pagos nuevos. Registrá únicamente la reversión correspondiente; no se realizó ningún cambio.", 409, "ORDER_PAYMENT_FORBIDDEN", "Pago no permitido");
  const requestedType = cleanText(payload.type ?? "PAYMENT", 20).toUpperCase();
  let amount: number;
  let method: string;
  let reversesPaymentId: string | null = null;
  let reason: string | null = null;
  if (requestedType === "PAYMENT") {
    amount = integerValue(payload.amount, "El monto del pago", 1, 100_000_000);
    method = cleanText(payload.method, 20).toUpperCase();
    if (!["CASH", "SINPE", "CARD", "OTHER"].includes(method)) throw new OrderError("Seleccioná un método de pago válido. No se realizó ningún cambio.", 400, "ORDER_PAYMENT_METHOD_INVALID", "Método inválido");
    const balance = Math.max(0, Number(order.total) - Number(order.paid_total || 0));
    if (amount > balance) throw new OrderError(`El pago supera el saldo pendiente de ₡${balance}. Corregí el monto; no se realizó ningún cambio.`, 409, "ORDER_PAYMENT_EXCEEDS_BALANCE", "Pago mayor al saldo", { balance });
  } else if (["REVERSAL", "REFUND", "VOID"].includes(requestedType)) {
    reversesPaymentId = cleanText(payload.reversesPaymentId, 100);
    reason = optionalText(payload.reason, 1000);
    if (!reversesPaymentId || !reason || reason.length < 3) throw new OrderError("Seleccioná el pago original e indicá el motivo. No se realizó ninguna reversión.", 400, "ORDER_PAYMENT_REVERSAL_REQUIRED", "Reversión incompleta");
    const original = await db.prepare("SELECT * FROM order_payments WHERE id=? AND order_id=? AND payment_type='PAYMENT' AND status='POSTED' LIMIT 1")
      .bind(reversesPaymentId, orderId).first<Row>();
    if (!original) throw new OrderError("No encontramos el pago original. Actualizá el pedido; no se realizó ninguna reversión.", 404, "ORDER_PAYMENT_NOT_FOUND", "Pago no encontrado");
    const reversed = await db.prepare("SELECT id FROM order_payments WHERE reverses_payment_id=? LIMIT 1").bind(reversesPaymentId).first();
    if (reversed) throw new OrderError("Ese pago ya fue revertido. No se duplicó la reversión.", 409, "ORDER_PAYMENT_ALREADY_REVERSED", "Pago ya revertido");
    amount = Number(original.amount);
    method = String(original.method);
  } else {
    throw new OrderError("El tipo de movimiento de pago no es válido. No se realizó ningún cambio.", 400, "ORDER_PAYMENT_TYPE_INVALID", "Movimiento inválido");
  }
  const claim = await beginOperation(db, orderId, "PAYMENT", operationId, payload);
  if (claim.replayed) return { order: await loadOrder(db, orderId), idempotent: true };
  const now = new Date().toISOString();
  const paymentId = newOrderChildId("payment");
  const statements = [
    guardStatement(db, operationId, orderId, version, [String(order.status) as OrderStatus]),
    db.prepare(`INSERT INTO order_payments (
      id,order_id,amount,currency,method,payment_type,status,reference,reverses_payment_id,reason,operation_id,created_at
    ) VALUES (?,?,?,?,?,?,'POSTED',?,?,?,?,?)`).bind(
      paymentId, orderId, amount, String(order.currency), method, requestedType,
      optionalText(payload.reference, 500), reversesPaymentId, reason, operationId, now,
    ),
    db.prepare("UPDATE orders SET version=version+1,updated_at=? WHERE id=? AND version=?").bind(now, orderId, version),
    eventStatement(db, orderId, "payment.recorded", operationId, { paymentId, type: requestedType, amount, method }, now),
    completeOperationStatement(db, operationId, orderId, now),
  ];
  try { await db.batch(statements); }
  catch (error) { await abandonOperation(db, operationId); throw error; }
  return { order: await loadOrder(db, orderId), idempotent: false };
}

export async function transitionSpecialOrder(db: D1Database, orderId: string, payload: Record<string, unknown>) {
  const operationId = requiredOperationId(payload);
  if (await completedOperation(db, orderId, "SPECIAL_STATUS", operationId, payload)) {
    return { order: await loadOrder(db, orderId), idempotent: true };
  }
  const version = requiredVersion(payload);
  const target = cleanText(payload.targetStatus ?? payload.status ?? payload.specialOrderStatus, 50).toUpperCase();
  if (!SPECIAL_ORDER_STATUSES.includes(target as SpecialOrderStatus)) {
    throw new OrderError("El estado solicitado para el Encargo no es válido. Actualizá el pedido y elegí una acción disponible; no se realizó ningún cambio.", 400, "SPECIAL_ORDER_STATUS_INVALID", "Estado de Encargo inválido");
  }
  if (!["ORDERED_FROM_SUPPLIER", "IN_TRANSIT", "RECEIVED_PENDING_RESOLUTION"].includes(target)) {
    throw new OrderError("Ese estado del Encargo se alcanza mediante recepción, ruta, entrega o cancelación. Usá la acción correspondiente; no se realizó ningún cambio.", 409, "SPECIAL_ORDER_STATUS_ACTION_REQUIRED", "Acción específica requerida");
  }
  const row = await db.prepare(`SELECT o.status AS order_status,o.order_type,sd.* FROM orders o
    LEFT JOIN special_order_details sd ON sd.order_id=o.id WHERE o.id=? LIMIT 1`).bind(orderId).first<Row>();
  if (!row) throw new OrderError("No encontramos el Encargo. Actualizá la lista; no se realizó ningún cambio.", 404, "ORDER_NOT_FOUND", "Encargo no encontrado");
  if (String(row.order_type) !== "SPECIAL_ORDER" || !row.special_order_status) {
    throw new OrderError("Este pedido no es un Encargo. Usá sus acciones logísticas normales; no se realizó ningún cambio.", 409, "SPECIAL_ORDER_REQUIRED", "No es un Encargo");
  }
  if (String(row.order_status) !== "DRAFT") {
    throw new OrderError("El Encargo ya inició su flujo logístico normal y no puede retroceder al flujo de proveedor. No se realizó ningún cambio ni movimiento de inventario.", 409, "SPECIAL_ORDER_STATUS_LOCKED", "Encargo bloqueado");
  }
  const transitions: Record<string, string> = {
    REQUESTED: "ORDERED_FROM_SUPPLIER",
    ORDERED_FROM_SUPPLIER: "IN_TRANSIT",
    IN_TRANSIT: "RECEIVED_PENDING_RESOLUTION",
  };
  const currentStatus = String(row.special_order_status);
  if (transitions[currentStatus] !== target) {
    throw new OrderError("Ese cambio de estado no sigue el orden del Encargo. Usá la siguiente acción disponible; el pedido y el inventario conservaron su estado anterior.", 409, "SPECIAL_ORDER_INVALID_TRANSITION", "Transición no permitida");
  }
  const estimatedArrivalDate = Object.hasOwn(payload, "estimatedArrivalDate")
    ? costaRicaDate(payload.estimatedArrivalDate, "La fecha estimada de llegada")
    : row.estimated_arrival_date ? String(row.estimated_arrival_date) : null;
  const claim = await beginOperation(db, orderId, "SPECIAL_STATUS", operationId, payload);
  if (claim.replayed) return { order: await loadOrder(db, orderId), idempotent: true };
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    guardStatement(db, operationId, orderId, version, ["DRAFT"]),
    db.prepare(`UPDATE special_order_details SET special_order_status=?,
      ordered_at=CASE WHEN ?='ORDERED_FROM_SUPPLIER' THEN COALESCE(ordered_at,?) ELSE ordered_at END,
      received_at=CASE WHEN ?='RECEIVED_PENDING_RESOLUTION' THEN COALESCE(received_at,?) ELSE received_at END,
      estimated_arrival_date=?,updated_at=? WHERE order_id=? AND special_order_status=?`).bind(
      target, target, now, target, now, estimatedArrivalDate, now, orderId, currentStatus,
    ),
    db.prepare("UPDATE orders SET version=version+1,updated_at=? WHERE id=? AND version=? AND status='DRAFT'").bind(now, orderId, version),
    eventStatement(db, orderId, "special_order.status_changed", operationId, { from: currentStatus, to: target }, now),
    completeOperationStatement(db, operationId, orderId, now),
  ];
  try { await db.batch(statements); }
  catch (error) { await abandonOperation(db, operationId); throw error; }
  return { order: await loadOrder(db, orderId), idempotent: false };
}

export async function resolveSpecialOrderReceipt(db: D1Database, orderId: string, payload: Record<string, unknown>) {
  const operationId = requiredOperationId(payload);
  if (await completedOperation(db, orderId, "SPECIAL_RECEIPT", operationId, payload)) {
    return { order: await loadOrder(db, orderId), idempotent: true };
  }
  const version = requiredVersion(payload);
  const mode = cleanText(payload.mode ?? payload.resolutionMode, 40).toUpperCase();
  if (!SPECIAL_ORDER_RECEIPT_MODES.includes(mode as SpecialOrderReceiptMode)) {
    throw new OrderError("Elegí si estas unidades ingresan ahora al inventario o si ya fueron ingresadas mediante Facturas/Inventario. No se realizó ningún cambio.", 400, "SPECIAL_ORDER_RECEIPT_MODE_INVALID", "Resolución requerida");
  }
  const order = await db.prepare(`SELECT o.*,sd.special_order_status,sd.receipt_resolved_at FROM orders o
    LEFT JOIN special_order_details sd ON sd.order_id=o.id WHERE o.id=? LIMIT 1`).bind(orderId).first<Row>();
  if (!order) throw new OrderError("No encontramos el Encargo. Actualizá la lista; no se realizó ningún cambio.", 404, "ORDER_NOT_FOUND", "Encargo no encontrado");
  if (String(order.order_type) !== "SPECIAL_ORDER") throw new OrderError("Este pedido no es un Encargo. No se realizó ningún cambio.", 409, "SPECIAL_ORDER_REQUIRED", "No es un Encargo");
  if (String(order.status) !== "DRAFT" || !["RECEIVED_PENDING_RESOLUTION", "PARTIALLY_RECEIVED"].includes(String(order.special_order_status))) {
    throw new OrderError("La recepción no está pendiente de resolver. Actualizá el Encargo y usá la acción disponible; no se realizó ningún cambio ni movimiento de inventario.", 409, "SPECIAL_ORDER_RECEIPT_NOT_PENDING", "Recepción no disponible");
  }
  const requestedLines = Array.isArray(payload.lines) ? payload.lines.map(asRow).slice(0, 500) : [];
  if (!requestedLines.length) throw new OrderError("Seleccioná al menos un producto y su cantidad recibida. No se realizó ningún cambio ni movimiento de inventario.", 400, "SPECIAL_ORDER_RECEIPT_LINES_REQUIRED", "Recepción sin productos");
  const activeLines = await db.prepare(`SELECT l.*,
    COALESCE((SELECT SUM(srl.quantity_received) FROM special_order_receipt_lines srl
      JOIN special_order_receipts sr ON sr.id=srl.receipt_id WHERE sr.order_id=l.order_id AND srl.order_line_id=l.id),0) AS received_quantity
    FROM order_lines l WHERE l.order_id=? AND l.removed_at IS NULL ORDER BY l.position,l.id`).bind(orderId).all<Row>();
  const byId = new Map(activeLines.results.map((line) => [String(line.id), line]));
  const parsed = requestedLines.map((source, index) => {
    const lineId = cleanText(source.orderLineId ?? source.lineId, 100);
    const line = byId.get(lineId);
    if (!line) throw new OrderError(`La línea ${index + 1} no pertenece al Encargo. Actualizalo; no se realizó ningún cambio.`, 409, "SPECIAL_ORDER_RECEIPT_LINE_NOT_FOUND", "Producto no encontrado");
    const productId = integerValue(source.productId, `El producto vinculado de “${String(line.product_name_snapshot)}”`, 1, 2_147_483_647);
    const quantityReceived = integerValue(source.quantityReceived ?? source.quantity, `La cantidad recibida de “${String(line.product_name_snapshot)}”`, 1, 100_000);
    const remaining = Math.max(0, Number(line.quantity) - Number(line.received_quantity || 0));
    if (quantityReceived > remaining) {
      throw new OrderError(`Solo faltan ${remaining} unidades por recibir de “${String(line.product_name_snapshot)}”. Corregí la cantidad; no se realizó ningún cambio ni movimiento de inventario.`, 409, "SPECIAL_ORDER_RECEIPT_EXCEEDS_PENDING", "Cantidad recibida inválida", { lineId, remaining });
    }
    if (line.product_id != null && Number(line.product_id) !== productId) {
      throw new OrderError(`“${String(line.product_name_snapshot)}” ya está vinculado a otro producto. Revisá la selección; no se realizó ningún cambio ni movimiento de inventario.`, 409, "SPECIAL_ORDER_PRODUCT_LINK_CONFLICT", "Vinculación incompatible", { lineId });
    }
    return { line, lineId, productId, quantityReceived };
  });
  if (new Set(parsed.map((line) => line.lineId)).size !== parsed.length) {
    throw new OrderError("La recepción contiene una línea repetida. Corregila; no se realizó ningún cambio ni movimiento de inventario.", 409, "ORDER_DUPLICATE_LINE", "Línea repetida");
  }
  const productIds = [...new Set(parsed.map((line) => line.productId))];
  const productRows = await db.prepare("SELECT * FROM products WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(productIds)).all<Row>();
  const products = new Map(productRows.results.map((product) => [Number(product.id), product]));
  if (products.size !== productIds.length) {
    const missing = productIds.filter((productId) => !products.has(productId));
    throw new OrderError("Uno de los productos seleccionados no existe en Inventario. Crealo o seleccionalo mediante el flujo seguro antes de resolver la recepción; no se realizó ningún cambio.", 409, "ORDER_PRODUCT_NOT_FOUND", "Producto no encontrado", { productIds: missing });
  }
  const receivedByLine = new Map(activeLines.results.map((line) => [String(line.id), Number(line.received_quantity || 0)]));
  parsed.forEach((line) => receivedByLine.set(line.lineId, (receivedByLine.get(line.lineId) || 0) + line.quantityReceived));
  const fullyResolved = activeLines.results.every((line) => (receivedByLine.get(String(line.id)) || 0) >= Number(line.quantity));
  const nextStatus: SpecialOrderStatus = fullyResolved ? "RECEIVED_READY" : "PARTIALLY_RECEIVED";
  if (mode === "ALREADY_INVENTORY") {
    const requiredByProduct = new Map<number, { productId: number; productName: string; required: number }>();
    const parsedProducts = new Map(parsed.map((entry) => [entry.lineId, entry.productId]));
    const linesToValidate = fullyResolved ? activeLines.results.map((line) => ({
      productId: parsedProducts.get(String(line.id)) || Number(line.product_id || 0),
      productName: String(line.product_name_snapshot),
      quantity: Number(line.quantity),
    })) : parsed.map((entry) => ({ productId: entry.productId, productName: String(entry.line.product_name_snapshot), quantity: entry.quantityReceived }));
    linesToValidate.forEach((line) => {
      const currentRequired = requiredByProduct.get(line.productId) || { productId: line.productId, productName: line.productName, required: 0 };
      currentRequired.required += line.quantity;
      requiredByProduct.set(line.productId, currentRequired);
    });
    const shortages = insufficientStock([...requiredByProduct.values()], products);
    if (shortages.length) {
      const first = shortages[0];
      throw new OrderError(`“${first.productName}” se indicó como ya ingresado, pero Inventario solo tiene ${first.available} y el Encargo necesita ${first.required}. Elegí “Ingresar estas unidades al inventario ahora” si esta recepción todavía no fue registrada, o registrá primero la entrada real en Facturas/Inventario. El Encargo, los pagos y el inventario conservaron su estado anterior.`, 409, "SPECIAL_ORDER_ALREADY_INVENTORY_SHORTAGE", "Recepción sin stock registrado", { shortages });
    }
  }
  const movementPlans = mode === "INVENTORY_NOW" ? assignMovementQuantities(parsed.map(({ line, lineId, productId, quantityReceived }) => ({
    lineId,
    productId,
    productName: String(line.product_name_snapshot),
    barcode: products.get(productId)?.code ? String(products.get(productId)?.code) : null,
    movementType: "SPECIAL_ORDER_RECEIPT",
    quantityChange: quantityReceived,
    reason: "Recepción de Encargo ingresada al inventario",
  })), products) : [];
  const claim = await beginOperation(db, orderId, "SPECIAL_RECEIPT", operationId, payload);
  if (claim.replayed) return { order: await loadOrder(db, orderId), idempotent: true };
  const now = new Date().toISOString();
  const receiptId = newOrderChildId("sreceipt");
  const statements: D1PreparedStatement[] = [guardStatement(db, operationId, orderId, version, ["DRAFT"])];
  parsed.forEach(({ lineId, productId }) => statements.push(db.prepare(`UPDATE order_lines SET product_id=?,
    barcode_snapshot=COALESCE(barcode_snapshot,(SELECT code FROM products WHERE id=?)),
    presentation_snapshot=COALESCE(presentation_snapshot,(SELECT presentation FROM products WHERE id=?)),updated_at=?
    WHERE id=? AND order_id=? AND removed_at IS NULL AND (product_id IS NULL OR product_id=?)`).bind(
    productId, productId, productId, now, lineId, orderId, productId,
  )));
  statements.push(db.prepare(`INSERT INTO special_order_receipts (
    id,order_id,resolution_mode,operation_id,resolved_at,created_at
  ) VALUES (?,?,?,?,?,?)`).bind(receiptId, orderId, mode, operationId, now, now));
  parsed.forEach(({ lineId, productId, quantityReceived }) => statements.push(db.prepare(`INSERT INTO special_order_receipt_lines (
    id,receipt_id,order_line_id,product_id,quantity_received,inventory_movement_created,created_at
  ) VALUES (?,?,?,?,?,?,?)`).bind(
    newOrderChildId("srline"), receiptId, lineId, productId, quantityReceived, mode === "INVENTORY_NOW" ? 1 : 0, now,
  )));
  statements.push(...movementPlans.map((plan) => movementStatement(db, orderId, operationId, plan, now)));
  statements.push(db.prepare(`UPDATE special_order_details SET special_order_status=?,
    receipt_resolved_at=CASE WHEN ?=1 THEN COALESCE(receipt_resolved_at,?) ELSE receipt_resolved_at END,updated_at=?
    WHERE order_id=? AND special_order_status IN ('RECEIVED_PENDING_RESOLUTION','PARTIALLY_RECEIVED')`).bind(
    nextStatus, fullyResolved ? 1 : 0, now, now, orderId,
  ));
  statements.push(db.prepare("UPDATE orders SET version=version+1,updated_at=? WHERE id=? AND version=? AND status='DRAFT'").bind(now, orderId, version));
  statements.push(eventStatement(db, orderId, "special_order.receipt_resolved", operationId, {
    receiptId, mode, fullyResolved, lineCount: parsed.length,
  }, now));
  statements.push(completeOperationStatement(db, operationId, orderId, now));
  try { await db.batch(statements); }
  catch (error) { await abandonOperation(db, operationId); throw error; }
  return { order: await loadOrder(db, orderId), idempotent: false };
}

export async function createReturn(db: D1Database, orderId: string, payload: Record<string, unknown>) {
  const operationId = requiredOperationId(payload);
  if (await completedOperation(db, orderId, "RETURN", operationId, payload)) return { order: await loadOrder(db, orderId), idempotent: true };
  const version = requiredVersion(payload);
  const reason = cleanText(payload.reason, 1000);
  if (reason.length < 3) throw new OrderError("Indicá el motivo de la devolución. El pedido y el inventario conservaron su estado anterior.", 400, "ORDER_REASON_REQUIRED", "Motivo requerido");
  const order = await db.prepare("SELECT * FROM orders WHERE id=? LIMIT 1").bind(orderId).first<Row>();
  if (!order) throw new OrderError("No encontramos el pedido. Actualizá la lista; no se realizó ningún cambio.", 404, "ORDER_NOT_FOUND", "Pedido no encontrado");
  const status = String(order.status) as OrderStatus;
  if (!["DELIVERED", "REOPENED"].includes(status)) throw new OrderError("Solo un pedido entregado puede registrar devoluciones. No se realizó ningún cambio.", 409, "ORDER_RETURN_FORBIDDEN", "Devolución no permitida");
  const sourceLines = Array.isArray(payload.lines) ? payload.lines.map(asRow).slice(0, 500) : [];
  if (!sourceLines.length) throw new OrderError("Seleccioná al menos una línea para devolver. No se realizó ningún cambio.", 400, "ORDER_RETURN_LINES_REQUIRED", "Devolución sin productos");
  const orderLines = await db.prepare(`SELECT l.*,
    COALESCE((SELECT SUM(fl.quantity) FROM order_fulfillment_lines fl JOIN order_fulfillments f ON f.id=fl.fulfillment_id WHERE fl.order_line_id=l.id),0) AS delivered_quantity,
    COALESCE((SELECT SUM(rl.quantity) FROM order_return_lines rl JOIN order_returns r ON r.id=rl.return_id WHERE rl.order_line_id=l.id AND r.status='COMPLETED'),0) AS returned_quantity
    FROM order_lines l WHERE l.order_id=?`).bind(orderId).all<Row>();
  const byId = new Map(orderLines.results.map((line) => [String(line.id), line]));
  const parsedLines = sourceLines.map((source, index) => {
    const lineId = cleanText(source.orderLineId ?? source.lineId, 100);
    const line = byId.get(lineId);
    if (!line) throw new OrderError(`La línea ${index + 1} no pertenece al pedido. Actualizalo; no se realizó ningún cambio.`, 409, "ORDER_RETURN_LINE_NOT_FOUND", "Producto no encontrado");
    const quantity = integerValue(source.quantity, `La cantidad devuelta de “${String(line.product_name_snapshot)}”`, 1, 100_000);
    const available = Math.max(0, Number(line.delivered_quantity || 0) - Number(line.returned_quantity || 0));
    if (quantity > available) throw new OrderError(`Solo pueden devolverse ${available} unidades de “${String(line.product_name_snapshot)}”. Corregí la cantidad; no se realizó ningún cambio.`, 409, "ORDER_RETURN_EXCEEDS_DELIVERED", "Cantidad de devolución inválida", { lineId, available });
    const reenterInventory = source.reenterInventory === true || source.reenterInventory === 1;
    if (reenterInventory && line.product_id == null) throw new OrderError(`“${String(line.product_name_snapshot)}” no está vinculado al inventario y no puede reingresarse automáticamente. Desmarcá el reingreso; no se realizó ningún cambio.`, 409, "ORDER_RETURN_MANUAL_PRODUCT", "Producto manual");
    return { line, lineId, quantity, reenterInventory };
  });
  if (new Set(parsedLines.map((line) => line.lineId)).size !== parsedLines.length) throw new OrderError("La devolución contiene una línea repetida. Corregila; no se realizó ningún cambio.", 409, "ORDER_DUPLICATE_LINE", "Línea repetida");
  const products = await productsForLines(db, parsedLines.map((item) => item.line));
  const plans = assignMovementQuantities(parsedLines.flatMap(({ line, lineId, quantity, reenterInventory }) => !reenterInventory ? [] : [{
    lineId, productId: Number(line.product_id), productName: String(line.product_name_snapshot),
    barcode: line.barcode_snapshot ? String(line.barcode_snapshot) : null, movementType: "ORDER_RETURN",
    quantityChange: quantity, reason,
  }]), products);
  const claim = await beginOperation(db, orderId, "RETURN", operationId, payload);
  if (claim.replayed) return { order: await loadOrder(db, orderId), idempotent: true };
  const now = new Date().toISOString();
  const returnId = newOrderChildId("return");
  const statements: D1PreparedStatement[] = [
    guardStatement(db, operationId, orderId, version, [status]),
    db.prepare("INSERT INTO order_returns (id,order_id,reason,status,operation_id,actor_principal,created_at) VALUES (?,?,?,'COMPLETED',?,NULL,?)")
      .bind(returnId, orderId, reason, operationId, now),
    ...parsedLines.map(({ lineId, quantity, reenterInventory }) => db.prepare(`INSERT INTO order_return_lines (
      id,return_id,order_line_id,quantity,reenter_inventory,created_at
    ) VALUES (?,?,?,?,?,?)`).bind(newOrderChildId("rline"), returnId, lineId, quantity, reenterInventory ? 1 : 0, now)),
    ...plans.map((plan) => movementStatement(db, orderId, operationId, plan, now)),
    db.prepare("UPDATE orders SET version=version+1,updated_at=? WHERE id=? AND version=?").bind(now, orderId, version),
    eventStatement(db, orderId, "order.returned", operationId, { returnId, reason }, now),
    completeOperationStatement(db, operationId, orderId, now),
  ];
  try { await db.batch(statements); }
  catch (error) { await abandonOperation(db, operationId); throw error; }
  return { order: await loadOrder(db, orderId), idempotent: false };
}

export async function orderHistory(db: D1Database, orderId: string) {
  if (!await db.prepare("SELECT 1 AS found FROM orders WHERE id=? LIMIT 1").bind(orderId).first()) throw new OrderError("No encontramos el pedido. Actualizá la lista.", 404, "ORDER_NOT_FOUND", "Pedido no encontrado");
  const [statusEvents, events, movements, payments, returns, fulfillments] = await Promise.all([
    db.prepare("SELECT * FROM order_status_events WHERE order_id=? ORDER BY created_at,id").bind(orderId).all<Row>(),
    db.prepare("SELECT * FROM order_events WHERE order_id=? ORDER BY created_at,id").bind(orderId).all<Row>(),
    db.prepare("SELECT * FROM inventory_movements WHERE order_id=? ORDER BY created_at,id").bind(orderId).all<Row>(),
    db.prepare("SELECT * FROM order_payments WHERE order_id=? ORDER BY created_at,id").bind(orderId).all<Row>(),
    db.prepare("SELECT * FROM order_returns WHERE order_id=? ORDER BY created_at,id").bind(orderId).all<Row>(),
    db.prepare("SELECT * FROM order_fulfillments WHERE order_id=? ORDER BY delivered_at,id").bind(orderId).all<Row>(),
  ]);
  return { statusEvents: statusEvents.results, events: events.results, inventoryMovements: movements.results, payments: payments.results, returns: returns.results, fulfillments: fulfillments.results };
}

export async function deleteDraftOrder(db: D1Database, orderId: string, payload: Record<string, unknown>) {
  const operationId = requiredOperationId(payload);
  if (await completedOperation(db, orderId, "DELETE_DRAFT", operationId, payload)) return { deleted: true, idempotent: true };
  const version = requiredVersion(payload);
  const payment = await db.prepare("SELECT 1 AS found FROM order_payments WHERE order_id=? LIMIT 1").bind(orderId).first();
  if (payment) throw new OrderError("El borrador tiene movimientos de pago y no puede eliminarse. Conservá el historial o revertí el pago; no se realizó ningún cambio.", 409, "ORDER_DELETE_HAS_PAYMENTS", "Pedido protegido");
  const claim = await beginOperation(db, orderId, "DELETE_DRAFT", operationId, payload);
  if (claim.replayed) return { deleted: true, idempotent: true };
  const statements = [
    guardStatement(db, operationId, orderId, version, ["DRAFT"]),
    db.prepare("DELETE FROM order_status_events WHERE order_id=?").bind(orderId),
    db.prepare("DELETE FROM order_events WHERE order_id=?").bind(orderId),
    db.prepare("DELETE FROM orders WHERE id=? AND version=? AND status='DRAFT'").bind(orderId, version),
    db.prepare("UPDATE order_operations SET status='completed',response_json=?,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_id=?")
      .bind(JSON.stringify({ orderId, deleted: true }), operationId),
  ];
  try { await db.batch(statements); }
  catch (error) { await abandonOperation(db, operationId); throw error; }
  return { deleted: true, idempotent: false };
}

export async function listPayments(db: D1Database, orderId: string) {
  const order = await loadOrder(db, orderId);
  if (!order) throw new OrderError("No encontramos el pedido. Actualizá la lista.", 404, "ORDER_NOT_FOUND", "Pedido no encontrado");
  return { payments: order.payments, paidTotal: order.paidTotal, balance: order.balance, paymentStatus: order.paymentStatus };
}

export async function listDeliveryRoutes(db: D1Database, request: Request) {
  const url = new URL(request.url);
  const date = costaRicaDate(url.searchParams.get("date"), "La fecha de ruta");
  const status = cleanText(url.searchParams.get("status"), 20).toUpperCase();
  const where = [date ? "r.route_date=?" : "", status ? "r.status=?" : ""].filter(Boolean);
  const values = [date, status].filter(Boolean);
  const result = await db.prepare(`SELECT r.*,(SELECT COUNT(*) FROM route_orders ro WHERE ro.route_id=r.id AND ro.removed_at IS NULL) AS order_count
    FROM delivery_routes r ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.route_date DESC,r.created_at DESC,r.id`).bind(...values).all<Row>();
  return { routes: result.results.map((row) => ({ id: String(row.id), date: String(row.route_date), label: row.label ? String(row.label) : null, status: String(row.status), orderCount: Number(row.order_count), createdAt: String(row.created_at), closedAt: row.closed_at ? String(row.closed_at) : null })) };
}

export async function createDeliveryRoute(db: D1Database, payload: Record<string, unknown>) {
  const routeId = newOrderChildId("route");
  const date = costaRicaDate(payload.date ?? payload.routeDate, "La fecha de ruta");
  if (!date) throw new OrderError("Seleccioná la fecha de la ruta. No se realizó ningún cambio.", 400, "ROUTE_DATE_REQUIRED", "Fecha requerida");
  await db.prepare("INSERT INTO delivery_routes (id,route_date,label,status,created_at) VALUES (?,?,?,'OPEN',?)")
    .bind(routeId, date, optionalText(payload.label, 250), new Date().toISOString()).run();
  return { route: { id: routeId, date, label: optionalText(payload.label, 250), status: "OPEN" } };
}

export async function assignOrderToRoute(db: D1Database, routeId: string, payload: Record<string, unknown>) {
  const orderId = cleanText(payload.orderId, 100);
  const position = integerValue(payload.position, "La posición de entrega", 1, 100_000);
  const [route, order] = await Promise.all([
    db.prepare("SELECT * FROM delivery_routes WHERE id=? AND status='OPEN' LIMIT 1").bind(routeId).first<Row>(),
    db.prepare("SELECT * FROM orders WHERE id=? LIMIT 1").bind(orderId).first<Row>(),
  ]);
  if (!route) throw new OrderError("No encontramos una ruta abierta. Actualizá las rutas; no se realizó ningún cambio.", 404, "ROUTE_NOT_FOUND", "Ruta no encontrada");
  if (!order) throw new OrderError("No encontramos el pedido. Actualizá la lista; no se realizó ningún cambio.", 404, "ORDER_NOT_FOUND", "Pedido no encontrado");
  if (["DELIVERED", "CANCELLED"].includes(String(order.status))) throw new OrderError("El pedido ya está cerrado y no puede asignarse a una ruta activa. No se realizó ningún cambio.", 409, "ROUTE_ORDER_CLOSED", "Pedido cerrado");
  let specialDetail: Row | null = null;
  if (String(order.order_type) === "SPECIAL_ORDER") {
    specialDetail = await db.prepare("SELECT * FROM special_order_details WHERE order_id=? LIMIT 1").bind(orderId).first<Row>();
    if (!specialDetail?.receipt_resolved_at || !["RECEIVED_READY", "ADDED_TO_ROUTE"].includes(String(specialDetail.special_order_status))) {
      throw new OrderError("El Encargo todavía no tiene su recepción resuelta. Completá la vinculación de inventario antes de agregarlo a una ruta; no se realizó ningún cambio.", 409, "SPECIAL_ORDER_ROUTE_NOT_READY", "Encargo no listo");
    }
  }
  const now = new Date().toISOString();
  const occupied = await db.prepare(`SELECT id FROM route_orders
    WHERE route_id=? AND position=? AND removed_at IS NULL AND order_id<>? LIMIT 1`)
    .bind(routeId, position, orderId).first<{ id: string }>();
  const maximum = occupied
    ? await db.prepare("SELECT COALESCE(MAX(position),0) AS maximum FROM route_orders WHERE route_id=? AND removed_at IS NULL")
      .bind(routeId).first<{ maximum: number }>()
    : null;
  const statements: D1PreparedStatement[] = [
    ...(occupied ? [db.prepare("UPDATE route_orders SET position=? WHERE id=? AND removed_at IS NULL")
      .bind(Number(maximum?.maximum || 0) + 1, occupied.id)] : []),
    db.prepare("UPDATE route_orders SET removed_at=? WHERE order_id=? AND removed_at IS NULL").bind(now, orderId),
    db.prepare("INSERT INTO route_orders (id,route_id,order_id,position,assigned_at) VALUES (?,?,?,?,?)")
      .bind(newOrderChildId("routeorder"), routeId, orderId, position, now),
    db.prepare("UPDATE orders SET route_id=?,version=version+1,updated_at=? WHERE id=?").bind(routeId, now, orderId),
    ...(specialDetail && String(specialDetail.special_order_status) === "RECEIVED_READY"
      ? [db.prepare("UPDATE special_order_details SET special_order_status='ADDED_TO_ROUTE',updated_at=? WHERE order_id=? AND special_order_status='RECEIVED_READY'").bind(now, orderId)]
      : []),
  ];
  await db.batch(statements);
  return { order: await loadOrder(db, orderId) };
}

export async function loadDeliveryRoute(db: D1Database, routeId: string) {
  const route = await db.prepare("SELECT * FROM delivery_routes WHERE id=? LIMIT 1").bind(routeId).first<Row>();
  if (!route) throw new OrderError("No encontramos la ruta. Actualizá la fecha y volvé a intentarlo.", 404, "ROUTE_NOT_FOUND", "Ruta no encontrada");
  const memberships = await db.prepare(`SELECT ro.* FROM route_orders ro
    WHERE ro.route_id=? AND ro.id=(SELECT latest.id FROM route_orders latest
      WHERE latest.route_id=ro.route_id AND latest.order_id=ro.order_id ORDER BY latest.assigned_at DESC,latest.id DESC LIMIT 1)
    ORDER BY ro.removed_at IS NOT NULL,ro.position,ro.assigned_at,ro.id`).bind(routeId).all<Row>();
  const loaded = await Promise.all(memberships.results.map(async (membership) => ({
    membership,
    order: await loadOrder(db, String(membership.order_id)),
  })));
  const rows = loaded.flatMap(({ membership, order }) => order ? [{
    ...order,
    routeMembership: {
      position: Number(membership.position),
      assignedAt: String(membership.assigned_at),
      removedAt: membership.removed_at ? String(membership.removed_at) : null,
      active: !membership.removed_at,
    },
  }] : []);
  const active = rows.filter((order) => order.routeMembership.active);
  const nonCancelled = active.filter((order) => order.status !== "CANCELLED");
  const methodTotals: Record<PaymentMethod, number> = { CASH: 0, SINPE: 0, CARD: 0, OTHER: 0 };
  nonCancelled.forEach((order) => (order.payments || []).forEach((payment) => {
    const method = payment.method as PaymentMethod;
    if (!PAYMENT_METHODS.includes(method)) return;
    methodTotals[method] += payment.type === "PAYMENT" ? payment.amount : -payment.amount;
  }));
  const pending = active.filter((order) => !["DELIVERED", "CANCELLED"].includes(order.status));
  const delivered = active.filter((order) => order.status === "DELIVERED");
  const reprogrammed = rows.filter((order) => !order.routeMembership.active && order.scheduledDeliveryDate !== String(route.route_date));
  return {
    route: {
      id: String(route.id),
      date: String(route.route_date),
      label: route.label ? String(route.label) : null,
      status: String(route.status),
      createdAt: String(route.created_at),
      closedAt: route.closed_at ? String(route.closed_at) : null,
    },
    orders: rows,
    summary: {
      delivered: delivered.length,
      cancelled: active.filter((order) => order.status === "CANCELLED").length,
      reprogrammed: reprogrammed.length,
      pending: pending.length,
      totalDelivered: delivered.reduce((sum, order) => sum + order.total, 0),
      totalCollected: nonCancelled.reduce((sum, order) => sum + order.paidTotal, 0),
      balancePending: nonCancelled.reduce((sum, order) => sum + order.balance, 0),
      paymentMethods: methodTotals,
      shippingTotal: delivered.reduce((sum, order) => sum + order.deliveryFee, 0),
    },
    pendingOrders: pending.map((order) => ({ id: order.id, orderNumber: order.orderNumber, customerName: order.customerName, status: order.status, total: order.total, deliveryFee: order.deliveryFee, paidTotal: order.paidTotal, balance: order.balance })),
  };
}

export async function closeDeliveryRoute(db: D1Database, routeId: string, payload: Record<string, unknown>) {
  const operationId = requiredOperationId(payload);
  let snapshot = await loadDeliveryRoute(db, routeId);
  if (snapshot.route.status === "CLOSED") return { ...snapshot, idempotent: true };
  const decisions = asRow(payload.decisions);
  const missing = snapshot.pendingOrders.filter((order) => !["DELIVERED", "NOT_DELIVERED"].includes(cleanText(decisions[order.id], 20).toUpperCase()));
  if (missing.length) {
    throw new OrderError(`Indicá Entregado o No entregado para ${missing.length} pedido${missing.length === 1 ? "" : "s"}. La ruta, los pedidos, pagos e inventario conservaron su estado actual.`, 409, "ROUTE_DECISIONS_REQUIRED", "Decisiones incompletas", { pendingOrders: missing });
  }
  for (const pending of snapshot.pendingOrders) {
    if (cleanText(decisions[pending.id], 20).toUpperCase() !== "DELIVERED") continue;
    let order = await loadOrder(db, pending.id);
    if (!order || order.status === "DELIVERED") continue;
    if (order.status === "CONFIRMED") {
      const prepared = (await prepareOrder(db, order.id, { operationId: `${operationId}:${order.id}:prepare`, version: order.version })).order;
      if (!prepared) throw new OrderError("El pedido dejó de estar disponible durante el cierre. Actualizá la ruta; permanece abierta y no se registraron pagos ni movimientos adicionales de inventario.", 409, "ROUTE_ORDER_CHANGED", "Pedido actualizado");
      order = prepared;
    }
    if (order.status !== "PREPARED") {
      throw new OrderError(`${order.orderNumber} no está Confirmado ni Preparado. Preparalo antes de cerrar la ruta como entregado; la ruta sigue abierta y no se registraron pagos ni movimientos adicionales de inventario.`, 409, "ROUTE_ORDER_NOT_READY", "Pedido no listo");
    }
    await deliverOrder(db, order.id, { operationId: `${operationId}:${order.id}:deliver`, version: order.version });
  }
  snapshot = await loadDeliveryRoute(db, routeId);
  const now = new Date().toISOString();
  const result = await db.prepare("UPDATE delivery_routes SET status='CLOSED',closed_at=? WHERE id=? AND status='OPEN'")
    .bind(now, routeId).run();
  return { ...(await loadDeliveryRoute(db, routeId)), idempotent: Number(result.meta?.changes || 0) === 0 };
}
