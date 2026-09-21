import { addCustomerIdentity, createCustomer, CrmError, linkChatwootContact, linkChatwootConversationOrder, resolveCustomer, updateCustomer } from "./crm";
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
const CRM_PANEL_ORIGIN = "https://nutriplus-precios.ever1822.chatgpt.site";
const SHARED_LOCATION_SOURCES = new Set(["instagram", "whatsapp"]);

function coordinate(value: unknown, min: number, max: number) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function sharedLocationFor(custom: Data) {
  const locationUrl = string(custom.location_url);
  const source = string(custom.last_shared_location_source).toLowerCase();
  const sharedAt = string(custom.last_shared_location_at);
  const latitude = coordinate(custom.last_shared_latitude, -90, 90);
  const longitude = coordinate(custom.last_shared_longitude, -180, 180);

  if (
    !locationUrl ||
    !SHARED_LOCATION_SOURCES.has(source) ||
    !sharedAt ||
    !Number.isFinite(Date.parse(sharedAt)) ||
    latitude == null ||
    longitude == null
  ) return null;

  return { locationUrl, latitude, longitude };
}


function providerForChannel(value: unknown) {
  const raw = string(value).toLowerCase();
  if (raw.includes("instagram")) return "instagram";
  if (raw.includes("facebook") || raw.includes("messenger")) return "messenger";
  return "";
}
function externalIdentityFor(contact: Data) {
  const directProvider = providerForChannel(contact.channel_type) || providerForChannel(object(contact.inbox).channel_type);
  const directExternalId = string(contact.identifier) || string(contact.source_id);
  if (directProvider && directExternalId) return { provider: directProvider, externalId: directExternalId };

  const singular = object(contact.contact_inbox);
  const singularProvider = providerForChannel(singular.channel_type) || providerForChannel(object(singular.inbox).channel_type);
  const singularExternalId = string(singular.source_id);
  if (singularProvider && singularExternalId) return { provider: singularProvider, externalId: singularExternalId };

  const contactInboxes = Array.isArray(contact.contact_inboxes) ? contact.contact_inboxes : [];
  for (const value of contactInboxes) {
    const contactInbox = object(value);
    const provider = providerForChannel(contactInbox.channel_type) || providerForChannel(object(contactInbox.inbox).channel_type);
    const externalId = string(contactInbox.source_id);
    if (provider && externalId) return { provider, externalId };
  }

  return { provider: "", externalId: directExternalId || singularExternalId };
}
function conversationContactId(conversation: Data) { return integer(object(object(conversation.meta).sender).id) ?? integer(object(conversation.contact).id); }
function crmPanelUrl(accountId: number, contactId: number, conversationId: number) {
  const query = new URLSearchParams({ account_id: String(accountId), contact_id: String(contactId), conversation_id: String(conversationId) });
  return `${CRM_PANEL_ORIGIN}/operations/crm-panel?${query}`;
}

export async function syncContact(db: D1Database, client: ChatwootClient, accountId: number, input: Data) {
  const contact = object(input.contact).id ? object(input.contact) : input;
  const contactId = integer(contact.id); if (!contactId) throw new CrmError("Contacto Chatwoot inválido.", 400, "CHATWOOT_CONTACT_INVALID");
  const custom = attrs(contact); const explicit = string(custom.nutriplus_customer_id); const { provider, externalId } = externalIdentityFor(contact);
  const identity = provider && externalId ? { externalProvider: provider, externalAccount: String(accountId), externalId } : {};
  let resolved = await resolveCustomer(db, { customerId: explicit || undefined, ...identity, phone: contact.phone_number });
  if (!resolved) {
    if (!string(contact.phone_number) && !externalId) return { skipped: true, reason: "INSUFFICIENT_IDENTITY" };
    resolved = await createCustomer(db, { name: string(contact.name) || `Cliente Chatwoot ${contactId}`, phone: contact.phone_number, customerStatus: "PROSPECT" });
  }
  if (!resolved) throw new CrmError("No fue posible resolver el cliente.", 500, "CRM_CUSTOMER_RESOLUTION_FAILED");

  const sharedLocation = sharedLocationFor(custom);
  if (
    sharedLocation &&
    (
      resolved.locationUrl !== sharedLocation.locationUrl ||
      resolved.latitude !== sharedLocation.latitude ||
      resolved.longitude !== sharedLocation.longitude
    )
  ) {
    const updatedCustomer = await updateCustomer(db, String(resolved.id), {
      version: resolved.version,
      locationUrl: sharedLocation.locationUrl,
      latitude: sharedLocation.latitude,
      longitude: sharedLocation.longitude,
    });
    if (!updatedCustomer) throw new CrmError("No fue posible actualizar la ubicación del cliente.", 500, "CRM_CUSTOMER_LOCATION_UPDATE_FAILED");
    resolved = updatedCustomer;
  }
  if (provider && externalId) await addCustomerIdentity(db, { customerId: resolved.id, ...identity, phone: contact.phone_number });
  await linkChatwootContact(db, { customerId: resolved.id, accountId, contactId });
  const orders = await db.prepare("SELECT count(*) AS count, max(created_at) AS last_order_date FROM orders WHERE customer_id=?").bind(resolved.id).first<{count:number;last_order_date:string|null}>();
  const desired: Data = { nutriplus_customer_id: resolved.id, customer_status: chatwootStatus[String(resolved.customerStatus)] ?? null, province: resolved.province, canton: resolved.canton, district: resolved.district, default_delivery_address: resolved.defaultDeliveryAddress, location_url: resolved.locationUrl, preferred_payment_method: chatwootPayment[String(resolved.preferredPaymentMethod)] ?? null, orders_count: orders?.count ?? 0, last_order_date: orders?.last_order_date ?? null, first_touch_ad_id: custom.first_touch_ad_id ?? null, first_touch_campaign_id: custom.first_touch_campaign_id ?? null };
  if (!same(custom, desired)) await client.patchContactAttributes(accountId, contactId, desired);
  return { customerId: resolved.id, patched: !same(custom, desired) };
}

export async function syncConversation(db: D1Database, client: ChatwootClient, accountId: number, input: Data) {
  const conversation = object(input.conversation).id ? object(input.conversation) : input; const conversationId = integer(conversation.id); if (!conversationId) throw new CrmError("Conversación Chatwoot inválida.", 400, "CHATWOOT_CONVERSATION_INVALID");
  const custom = attrs(conversation); const contactId = conversationContactId(conversation);
  const linked = contactId ? await db.prepare("SELECT 1 FROM chatwoot_contact_links WHERE chatwoot_account_id=? AND chatwoot_contact_id=?").bind(accountId, contactId).first() : null;
  const panelUrl = contactId && linked ? crmPanelUrl(accountId, contactId, conversationId) : null;
  const orderId = string(custom.nutriplus_order_id);
  if (!orderId) {
    const desired = panelUrl ? { nutriplus_crm_url: panelUrl } : {};
    if (!same(custom, desired)) await client.patchConversationAttributes(accountId, conversationId, desired);
    return { skipped: true, reason: "NO_ORDER", patched: !same(custom, desired) };
  }
  await linkChatwootConversationOrder(db, { accountId, conversationId, orderId, linkRole: "PRIMARY" });
  const order = await db.prepare("SELECT id,status,expected_payment_method,scheduled_delivery_date,total FROM orders WHERE id=?").bind(orderId).first<Data>(); if (!order) throw new CrmError("Pedido no encontrado.", 404, "CRM_ORDER_NOT_FOUND");
  const paid = await db.prepare("SELECT COALESCE(sum(CASE WHEN payment_type='PAYMENT' THEN amount ELSE -amount END),0) AS total FROM order_payments WHERE order_id=? AND status='POSTED'").bind(orderId).first<{total:number}>();
  const paymentStatus = Number(paid?.total ?? 0) >= Number(order.total ?? 0) && Number(order.total ?? 0) > 0 ? "PAID" : Number(paid?.total ?? 0) > 0 ? "PARTIAL" : "PENDING";
  const desired: Data = { nutriplus_order_id: order.id, order_status: order.status, payment_status: paymentStatus, delivery_method: null, delivery_date: order.scheduled_delivery_date, ...(panelUrl ? { nutriplus_crm_url: panelUrl } : {}) };
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
