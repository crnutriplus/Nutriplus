import { addCustomerIdentity, createCustomer, CrmError, linkChatwootContact, linkChatwootConversationOrder, resolveCustomer } from "./crm";
import { ChatwootClient } from "./chatwoot-client";
import type { ChatwootWebhookJob } from "./chatwoot-webhook-outbox";

type Data = Record<string, unknown>;
const object = (value: unknown): Data => value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const string = (value: unknown) => typeof value === "string" ? value.trim() : "";
const integer = (value: unknown) => Number.isInteger(Number(value)) ? Number(value) : null;
const attrs = (value: Data) => object(value.custom_attributes);
const same = (left: Data, right: Data) => Object.keys(right).every((key) => (left[key] ?? null) === (right[key] ?? null));
const chatwootStatus: Record<string,string> = { PROSPECT: "Prospecto", CUSTOMER: "Cliente", RECURRING: "Cliente recurrente", INACTIVE: "Inactivo" };
const chatwootPayment: Record<string,string> = { CASH: "Efectivo", SINPE: "SINPE", CARD: "Tarjeta", OTHER: "Otro" };

function providerFor(contact: Data) {
  const raw = [contact.channel_type, object(contact.inbox).channel_type, object(contact.contact_inbox).channel_type].map(string).join(" ").toLowerCase();
  if (raw.includes("instagram")) return "instagram";
  if (raw.includes("facebook") || raw.includes("messenger")) return "messenger";
  return "";
}
function externalIdFor(contact: Data) { return string(contact.identifier) || string(contact.source_id) || string(object(contact.contact_inbox).source_id); }

export async function syncContact(db: D1Database, client: ChatwootClient, accountId: number, input: Data) {
  const contact = object(input.contact).id ? object(input.contact) : input;
  const contactId = integer(contact.id); if (!contactId) throw new CrmError("Contacto Chatwoot inválido.", 400, "CHATWOOT_CONTACT_INVALID");
  const custom = attrs(contact); const explicit = string(custom.nutriplus_customer_id); const provider = providerFor(contact); const externalId = externalIdFor(contact);
  const identity = provider && externalId ? { externalProvider: provider, externalAccount: String(accountId), externalId } : {};
  let resolved = await resolveCustomer(db, { customerId: explicit || undefined, ...identity, phone: contact.phone_number });
  if (!resolved) {
    if (!string(contact.phone_number) && !externalId) return { skipped: true, reason: "INSUFFICIENT_IDENTITY" };
    resolved = await createCustomer(db, { name: string(contact.name) || `Cliente Chatwoot ${contactId}`, phone: contact.phone_number, customerStatus: "PROSPECT" });
  }
  if (!resolved) throw new CrmError("No fue posible resolver el cliente.", 500, "CRM_CUSTOMER_RESOLUTION_FAILED");
  if (provider && externalId) await addCustomerIdentity(db, { customerId: resolved.id, ...identity, phone: contact.phone_number });
  await linkChatwootContact(db, { customerId: resolved.id, accountId, contactId });
  const orders = await db.prepare("SELECT count(*) AS count, max(created_at) AS last_order_date FROM orders WHERE customer_id=?").bind(resolved.id).first<{count:number;last_order_date:string|null}>();
  const desired: Data = { nutriplus_customer_id: resolved.id, customer_status: chatwootStatus[String(resolved.customerStatus)] ?? null, province: resolved.province, canton: resolved.canton, district: resolved.district, default_delivery_address: resolved.defaultDeliveryAddress, location_url: resolved.locationUrl, preferred_payment_method: chatwootPayment[String(resolved.preferredPaymentMethod)] ?? null, orders_count: orders?.count ?? 0, last_order_date: orders?.last_order_date ?? null, first_touch_ad_id: custom.first_touch_ad_id ?? null, first_touch_campaign_id: custom.first_touch_campaign_id ?? null };
  if (!same(custom, desired)) await client.patchContactAttributes(accountId, contactId, desired);
  return { customerId: resolved.id, patched: !same(custom, desired) };
}

export async function syncConversation(db: D1Database, client: ChatwootClient, accountId: number, input: Data) {
  const conversation = object(input.conversation).id ? object(input.conversation) : input; const conversationId = integer(conversation.id); if (!conversationId) throw new CrmError("Conversación Chatwoot inválida.", 400, "CHATWOOT_CONVERSATION_INVALID");
  const custom = attrs(conversation); const orderId = string(custom.nutriplus_order_id); if (!orderId) return { skipped: true, reason: "NO_ORDER" };
  await linkChatwootConversationOrder(db, { accountId, conversationId, orderId, linkRole: "PRIMARY" });
  const order = await db.prepare("SELECT id,status,expected_payment_method,scheduled_delivery_date,total FROM orders WHERE id=?").bind(orderId).first<Data>(); if (!order) throw new CrmError("Pedido no encontrado.", 404, "CRM_ORDER_NOT_FOUND");
  const paid = await db.prepare("SELECT COALESCE(sum(CASE WHEN payment_type='PAYMENT' THEN amount ELSE -amount END),0) AS total FROM order_payments WHERE order_id=? AND status='POSTED'").bind(orderId).first<{total:number}>();
  const paymentStatus = Number(paid?.total ?? 0) >= Number(order.total ?? 0) && Number(order.total ?? 0) > 0 ? "PAID" : Number(paid?.total ?? 0) > 0 ? "PARTIAL" : "PENDING";
  const desired: Data = { nutriplus_order_id: order.id, order_status: order.status, payment_status: paymentStatus, delivery_method: null, delivery_date: order.scheduled_delivery_date };
  if (!same(custom, desired)) await client.patchConversationAttributes(accountId, conversationId, desired);
  return { orderId, patched: !same(custom, desired) };
}

export async function syncConversationOrder(db: D1Database, client: ChatwootClient, accountId: number, conversationId: number, orderId: string) {
  await db.prepare("UPDATE chatwoot_conversation_order_links SET link_role='RELATED',updated_at=CURRENT_TIMESTAMP WHERE chatwoot_account_id=? AND chatwoot_conversation_id=? AND link_role='PRIMARY' AND order_id<>?").bind(accountId, conversationId, orderId).run();
  await linkChatwootConversationOrder(db, { accountId, conversationId, orderId, linkRole: "PRIMARY" });
  const conversation = await client.getConversation(accountId, conversationId);
  const custom = attrs(conversation); const order = await db.prepare("SELECT id,status,order_type,expected_payment_method,scheduled_delivery_date,total FROM orders WHERE id=?").bind(orderId).first<Data>();
  if (!order) throw new CrmError("Pedido no encontrado.", 404, "CRM_ORDER_NOT_FOUND");
  const paid = await db.prepare("SELECT COALESCE(sum(CASE WHEN payment_type='PAYMENT' THEN amount ELSE -amount END),0) AS total FROM order_payments WHERE order_id=? AND status='POSTED'").bind(orderId).first<{ total: number }>();
  const paidTotal = Number(paid?.total ?? 0), total = Number(order.total ?? 0);
  const desired: Data = { nutriplus_order_id: order.id, order_status: order.status, payment_status: paidTotal >= total && total > 0 ? "PAID" : paidTotal > 0 ? "PARTIAL" : "PENDING", delivery_method: order.order_type === "SPECIAL_ORDER" ? "ENCARGO" : "ENTREGA", delivery_date: order.scheduled_delivery_date };
  if (!same(custom, desired)) await client.patchConversationAttributes(accountId, conversationId, desired);
  return { orderId, patched: !same(custom, desired) };
}

export async function processChatwootEvent(db: D1Database, client: ChatwootClient, event: string, payload: Data) {
  const accountId = integer(object(payload.account).id); if (!accountId) throw new CrmError("Cuenta Chatwoot inválida.", 400, "CHATWOOT_ACCOUNT_INVALID");
  if (event === "contact_created" || event === "contact_updated") return syncContact(db, client, accountId, object(payload.contact).id ? object(payload.contact) : payload);
  if (event === "conversation_created" || event === "conversation_updated") return syncConversation(db, client, accountId, object(payload.conversation).id ? object(payload.conversation) : payload);
  return { skipped: true, reason: "UNSUPPORTED_EVENT" };
}

/** Fetches the canonical Chatwoot resource after the signed webhook has been durably queued. */
export async function processChatwootWebhookJob(db: D1Database, client: ChatwootClient, job: ChatwootWebhookJob) {
  if (job.eventType === "contact_created" || job.eventType === "contact_updated") {
    if (!job.contactId) throw new CrmError("Contacto Chatwoot inválido.", 400, "CHATWOOT_CONTACT_INVALID");
    return syncContact(db, client, job.accountId, await client.getContact(job.accountId, job.contactId));
  }
  if (job.eventType === "conversation_created" || job.eventType === "conversation_updated") {
    if (!job.conversationId) throw new CrmError("Conversación Chatwoot inválida.", 400, "CHATWOOT_CONVERSATION_INVALID");
    return syncConversation(db, client, job.accountId, await client.getConversation(job.accountId, job.conversationId));
  }
  return { skipped: true, reason: "UNSUPPORTED_EVENT" };
}
