import { CrmError } from "./crm";
import type { ChatwootClient } from "./chatwoot-client";

type Row = Record<string, unknown>;

function integer(value: string | null, field: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new CrmError(`${field} inválido.`, 400, "CRM_PANEL_CONTEXT_INVALID");
  return parsed;
}
async function one(db: D1Database, sql: string, ...bind: unknown[]) { return (await db.prepare(sql).bind(...bind).first<Row>()) ?? null; }
async function rows(db: D1Database, sql: string, ...bind: unknown[]) { return (await db.prepare(sql).bind(...bind).all<Row>()).results; }

const paymentSql = `COALESCE((SELECT SUM(CASE payment_type WHEN 'PAYMENT' THEN amount WHEN 'REVERSAL' THEN -amount WHEN 'REFUND' THEN -amount WHEN 'VOID' THEN -amount ELSE 0 END) FROM order_payments p WHERE p.order_id=o.id AND p.status='POSTED'),0)`;

export type CrmPanelContext = { accountId: number; contactId: number; conversationId: number | null };
export function parseCrmPanelContext(url: URL): CrmPanelContext {
  const conversation = url.searchParams.get("conversation_id");
  return { accountId: integer(url.searchParams.get("account_id"), "account_id"), contactId: integer(url.searchParams.get("contact_id"), "contact_id"), conversationId: conversation ? integer(conversation, "conversation_id") : null };
}

export async function linkedCrmPanelCustomer(db: D1Database, context: CrmPanelContext) {
  const customer = await one(db, `SELECT c.* FROM chatwoot_contact_links l JOIN customers c ON c.id=l.customer_id WHERE l.chatwoot_account_id=? AND l.chatwoot_contact_id=?`, context.accountId, context.contactId);
  if (!customer) throw new CrmError("El contacto aún no está asociado a un cliente NutriPlus.", 404, "CRM_PANEL_CUSTOMER_NOT_LINKED");
  return customer;
}
type ConversationClient = Pick<ChatwootClient, "getConversation">;
type OriginatingAdClient = Pick<ChatwootClient, "getConversation" | "getContact">;

export type CrmOriginatingAd = {
  adId: string;
  adName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  creativeId: string | null;
  creativeName: string | null;
  thumbnailUrl: string | null;
  referralSource: string | null;
  firstTouchAdId: string | null;
};

function customAttributes(value: Row) {
  const item = value.custom_attributes;
  return item && typeof item === "object" && !Array.isArray(item) ? item as Row : {};
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function originatingAdFromChatwoot(
  conversation: Row,
  contact: Row | null = null,
): CrmOriginatingAd | null {
  const c = customAttributes(conversation);
  const customer = contact ? customAttributes(contact) : {};
  const adId = optionalText(c.meta_ad_id);
  if (!adId) return null;

  return {
    adId,
    adName: optionalText(c.meta_ad_name),
    adsetId: optionalText(c.meta_adset_id),
    adsetName: optionalText(c.meta_adset_name),
    campaignId: optionalText(c.meta_campaign_id),
    campaignName: optionalText(c.meta_campaign_name),
    creativeId: optionalText(c.meta_creative_id),
    creativeName: optionalText(c.meta_creative_name),
    thumbnailUrl: optionalText(c.meta_ad_thumbnail_url),
    referralSource: optionalText(c.meta_referral_source),
    firstTouchAdId: optionalText(customer.first_touch_ad_id),
  };
}

export async function getCrmOriginatingAd(
  client: OriginatingAdClient,
  context: CrmPanelContext,
  conversationSnapshot?: Row,
) {
  if (context.conversationId == null) return null;

  const conversation =
    conversationSnapshot ??
    (await client.getConversation(
      context.accountId,
      context.conversationId,
    ));

  const snapshot = originatingAdFromChatwoot(conversation);
  if (!snapshot) return null;

  try {
    const contact = await client.getContact(
      context.accountId,
      context.contactId,
    );
    return originatingAdFromChatwoot(conversation, contact);
  } catch {
    return snapshot;
  }
}

function conversationContactId(conversation: Row) {
  const meta = conversation.meta && typeof conversation.meta === "object" ? conversation.meta as Row : {};
  const sender = meta.sender && typeof meta.sender === "object" ? meta.sender as Row : {};
  const contact = conversation.contact && typeof conversation.contact === "object" ? conversation.contact as Row : {};
  const value = sender.id ?? contact.id;
  return typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
}

/**
 * Browser query parameters are only lookup keys. A conversation context is
 * accepted only after Chatwoot confirms that it is scoped to the same account
 * and contact that are canonically linked in NutriPlus.
 */
export async function validateCrmPanelContext(
  db: D1Database,
  context: CrmPanelContext,
  client?: ConversationClient,
  recoverCustomer?: () => Promise<Row>,
) {
  if (context.conversationId == null) return linkedCrmPanelCustomer(db, context);

  if (!client) {
    await linkedCrmPanelCustomer(db, context);
    throw new CrmError("No se puede validar la conversación de Chatwoot en este momento.", 503, "CRM_PANEL_CHATWOOT_NOT_CONFIGURED");
  }

  const [customerResult, conversationResult] = await Promise.allSettled([
    linkedCrmPanelCustomer(db, context),
    client.getConversation(context.accountId, context.conversationId),
  ]);

  if (customerResult.status === "rejected") {
    if (conversationResult.status === "rejected") throw customerResult.reason;

    const conversation = conversationResult.value;
    const account = Number(conversation.account_id ?? context.accountId);
    if (!Number.isSafeInteger(account) || account !== context.accountId || conversationContactId(conversation) !== context.contactId) {
      throw new CrmError("La conversación no corresponde al contacto seleccionado.", 404, "CRM_PANEL_CONTEXT_MISMATCH");
    }

    if (
      recoverCustomer &&
      customerResult.reason instanceof CrmError &&
      customerResult.reason.code === "CRM_PANEL_CUSTOMER_NOT_LINKED"
    ) {
      return recoverCustomer();
    }

    throw customerResult.reason;
  }

  if (conversationResult.status === "rejected") throw conversationResult.reason;

  const customer = customerResult.value;
  const conversation = conversationResult.value;
  const account = Number(conversation.account_id ?? context.accountId);

  if (!Number.isSafeInteger(account) || account !== context.accountId || conversationContactId(conversation) !== context.contactId) {
    throw new CrmError("La conversación no corresponde al contacto seleccionado.", 404, "CRM_PANEL_CONTEXT_MISMATCH");
  }

  return customer;
}
function orderSummary(row: Row) {
  const total = Number(row.total || 0), paidTotal = Math.max(0, Number(row.paid_total || 0));
  return { id: row.id, orderNumber: row.order_number, orderType: row.order_type, status: row.status, total, paidTotal, balance: Math.max(0, total - paidTotal), paymentStatus: paidTotal >= total ? "PAID" : paidTotal > 0 ? "PARTIAL" : "PENDING", deliveryMethod: row.order_type === "SPECIAL_ORDER" ? "ENCARGO" : "ENTREGA", deliveryDate: row.scheduled_delivery_date ?? null, createdAt: row.created_at };
}
const orderSelect = `SELECT o.*, ${paymentSql} AS paid_total,
  (SELECT sd.special_order_status FROM special_order_details sd WHERE sd.order_id=o.id) AS special_order_status
  FROM orders o`;

export async function getCrmPanelForCustomer(db: D1Database, context: CrmPanelContext, customer: Row) {
  const [customerStats, recentRows, conversationRows] = await Promise.all([
    one(db, "SELECT COUNT(*) AS orders_count, MAX(created_at) AS last_order_date FROM orders WHERE customer_id=?", customer.id),
    rows(db, `${orderSelect} WHERE o.customer_id=? ORDER BY o.created_at DESC LIMIT 12`, customer.id),
    context.conversationId == null
      ? Promise.resolve([])
      : rows(db, `${orderSelect} JOIN chatwoot_conversation_order_links l ON l.order_id=o.id WHERE l.chatwoot_account_id=? AND l.chatwoot_conversation_id=? AND o.customer_id=? ORDER BY CASE l.link_role WHEN 'PRIMARY' THEN 0 ELSE 1 END, o.updated_at DESC`, context.accountId, context.conversationId, customer.id),
  ]);
  const recent = recentRows.map(orderSummary);
  const activeOrders = recent.filter((order) => !["DELIVERED", "CANCELLED", "RETURNED"].includes(String(order.status)));
  const conversationOrders = conversationRows.map(orderSummary);
  return { customer: { id: customer.id, name: customer.name, phone: customer.phone_normalized || customer.phone_raw, customerStatus: customer.customer_status, province: customer.province, canton: customer.canton, district: customer.district, defaultDeliveryAddress: customer.default_delivery_address, locationUrl: customer.location_url, locationReference: customer.location_reference, latitude: customer.latitude, longitude: customer.longitude, preferredPaymentMethod: customer.preferred_payment_method, ordersCount: Number(customerStats?.orders_count || 0), lastOrderDate: customerStats?.last_order_date ?? null }, activeOrders, recentOrders: recent, conversationOrders };
}


export async function getCrmPanel(db: D1Database, context: CrmPanelContext, client?: OriginatingAdClient) {
  const customer = await validateCrmPanelContext(db, context, client);
  const panel = await getCrmPanelForCustomer(db, context, customer);
  const originatingAd = client ? await getCrmOriginatingAd(client, context) : null;
  return { ...panel, originatingAd };
}

export async function getCrmPanelOrder(db: D1Database, context: CrmPanelContext, orderId: string, client?: ConversationClient) {
  if (!/^order-[0-9a-f-]{36}$/i.test(orderId)) throw new CrmError("Pedido inválido.", 400, "CRM_PANEL_ORDER_INVALID");
  const customer = await validateCrmPanelContext(db, context, client);
  const order = await one(db, `${orderSelect} WHERE o.id=? AND o.customer_id=?`, orderId, customer.id);
  if (!order) throw new CrmError("Ese pedido no pertenece al cliente asociado.", 404, "CRM_PANEL_ORDER_NOT_FOUND");
  const lines = await rows(db, "SELECT product_name_snapshot,presentation_snapshot,quantity,unit_price_original,unit_price_sold,discount_amount,line_total FROM order_lines WHERE order_id=? AND removed_at IS NULL ORDER BY position", orderId);
  const payments = await rows(db, "SELECT amount,method,payment_type,reference,created_at FROM order_payments WHERE order_id=? AND status='POSTED' ORDER BY created_at DESC,id DESC", orderId);
  return { order: { ...orderSummary(order), deliveryAddress: order.delivery_address, deliveryInstructions: order.delivery_instructions, province: order.province, canton: order.canton, district: order.district, locationUrl: null, latitude: order.latitude, longitude: order.longitude, expectedPaymentMethod: order.expected_payment_method, deliveryNotes: order.delivery_notes, specialOrderStatus: order.special_order_status ?? null, lines, payments } };
}
