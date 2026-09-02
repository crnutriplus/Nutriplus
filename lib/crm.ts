import { createOrder, loadOrder } from "./orders-service";

type Row = Record<string, unknown>;
export class CrmError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "CRM_INVALID_REQUEST") { super(message); }
}

const text = (value: unknown, max = 500) => typeof value === "string" ? value.trim().slice(0, max) : "";
const optional = (value: unknown, max?: number) => { const result = text(value, max); return result || null; };
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const allowedStatus = new Set(["PROSPECT", "CUSTOMER", "RECURRING", "INACTIVE"]);
const allowedPayment = new Set(["CASH", "SINPE", "CARD", "OTHER"]);

export function normalizeCrmPhone(value: unknown) {
  const raw = optional(value, 80);
  if (!raw) return { raw: null, normalized: null };
  const compact = raw.replace(/[\s().-]/g, "");
  if (/^\d{8}$/.test(compact)) return { raw, normalized: `+506${compact}` };
  const withPlus = compact.startsWith("+") ? compact : compact.startsWith("506") && compact.length === 11 ? `+${compact}` : "";
  if (!/^\+[1-9]\d{7,14}$/.test(withPlus)) throw new CrmError("El teléfono debe ser E.164 o un número costarricense de 8 dígitos.", 400, "CRM_PHONE_INVALID");
  return { raw, normalized: withPlus };
}

function number(value: unknown, field: string) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new CrmError(`${field} debe ser numérico.`, 400, "CRM_FIELD_INVALID");
  return parsed;
}
function customer(row: Row | null) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, phoneRaw: row.phone_raw, phoneNormalized: row.phone_normalized,
    customerStatus: row.customer_status, province: row.province, canton: row.canton, district: row.district,
    defaultDeliveryAddress: row.default_delivery_address, locationUrl: row.location_url, locationReference: row.location_reference,
    latitude: row.latitude, longitude: row.longitude, preferredPaymentMethod: row.preferred_payment_method,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
async function one(db: D1Database, sql: string, ...bind: unknown[]) { return (await db.prepare(sql).bind(...bind).first<Row>()) ?? null; }
async function mustCustomer(db: D1Database, customerId: string) {
  const result = await one(db, "SELECT * FROM customers WHERE id = ?", customerId);
  if (!result) throw new CrmError("Cliente no encontrado.", 404, "CRM_CUSTOMER_NOT_FOUND");
  return result;
}
function identityParts(input: Record<string, unknown>) {
  const provider = text(input.externalProvider, 50).toLowerCase(); const externalId = text(input.externalId, 200); const externalAccount = text(input.externalAccount, 200);
  if ((provider || externalId || externalAccount) && (!provider || !externalId)) throw new CrmError("La identidad externa requiere provider y externalId.", 400, "CRM_IDENTITY_INVALID");
  return { provider, externalId, externalAccount };
}

export async function getCustomer(db: D1Database, customerId: string) { return customer(await one(db, "SELECT * FROM customers WHERE id = ?", customerId)); }
export async function resolveCustomer(db: D1Database, input: Record<string, unknown>) {
  const explicit = optional(input.customerId, 100); const identity = identityParts(input); const phone = input.phone == null ? { raw: null, normalized: null } : normalizeCrmPhone(input.phone);
  const candidates: Row[] = [];
  if (explicit) { const row = await one(db, "SELECT * FROM customers WHERE id = ?", explicit); if (!row) throw new CrmError("Cliente no encontrado.", 404, "CRM_CUSTOMER_NOT_FOUND"); candidates.push(row); }
  if (identity.provider) { const row = await one(db, `SELECT c.* FROM customer_external_identities i JOIN customers c ON c.id=i.customer_id WHERE i.provider=? AND i.external_account=? AND i.external_id=?`, identity.provider, identity.externalAccount, identity.externalId); if (row) candidates.push(row); }
  if (phone.normalized) { const row = await one(db, "SELECT * FROM customers WHERE phone_normalized = ?", phone.normalized); if (row) candidates.push(row); }
  const unique = [...new Map(candidates.map((item) => [String(item.id), item])).values()];
  if (unique.length > 1) throw new CrmError("Las señales de identidad apuntan a clientes distintos.", 409, "CRM_IDENTITY_CONFLICT");
  return customer(unique[0] ?? null);
}

export async function createCustomer(db: D1Database, input: Record<string, unknown>) {
  const name = text(input.name, 200); if (!name) throw new CrmError("El nombre del cliente es obligatorio.", 400, "CRM_CUSTOMER_NAME_REQUIRED");
  const phone = normalizeCrmPhone(input.phone); const status = text(input.customerStatus || "PROSPECT", 30).toUpperCase(); if (!allowedStatus.has(status)) throw new CrmError("Estado de cliente inválido.", 400, "CRM_CUSTOMER_STATUS_INVALID");
  const payment = optional(input.preferredPaymentMethod, 20)?.toUpperCase() ?? null; if (payment && !allowedPayment.has(payment)) throw new CrmError("Método de pago inválido.", 400, "CRM_PAYMENT_METHOD_INVALID");
  if (phone.normalized && await one(db, "SELECT id FROM customers WHERE phone_normalized = ?", phone.normalized)) throw new CrmError("Ya existe un cliente con este teléfono.", 409, "CRM_PHONE_CONFLICT");
  const record = { id: id("customer"), name, ...phone, status, province: optional(input.province, 100), canton: optional(input.canton, 100), district: optional(input.district, 100), address: optional(input.defaultDeliveryAddress, 1000), locationUrl: optional(input.locationUrl, 1000), reference: optional(input.locationReference, 1000), latitude: number(input.latitude, "latitude"), longitude: number(input.longitude, "longitude"), payment };
  await db.prepare(`INSERT INTO customers (id,name,phone_raw,phone_normalized,customer_status,province,canton,district,default_delivery_address,location_url,location_reference,latitude,longitude,preferred_payment_method) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(record.id,record.name,record.raw,record.normalized,record.status,record.province,record.canton,record.district,record.address,record.locationUrl,record.reference,record.latitude,record.longitude,record.payment).run();
  return getCustomer(db, record.id);
}

export async function updateCustomer(db: D1Database, customerId: string, input: Record<string, unknown>) {
  const current = await mustCustomer(db, customerId); const version = Number(input.version); if (!Number.isInteger(version) || version !== Number(current.version)) throw new CrmError("La versión del cliente no coincide; recargá antes de guardar.", 409, "CRM_CUSTOMER_VERSION_CONFLICT");
  const phone = Object.hasOwn(input, "phone") ? normalizeCrmPhone(input.phone) : { raw: current.phone_raw as string | null, normalized: current.phone_normalized as string | null };
  if (phone.normalized && phone.normalized !== current.phone_normalized) { const other = await one(db, "SELECT id FROM customers WHERE phone_normalized=?", phone.normalized); if (other) throw new CrmError("Ya existe un cliente con este teléfono.", 409, "CRM_PHONE_CONFLICT"); }
  const next = (key: string, currentKey: string, max = 1000) => Object.hasOwn(input,key) ? optional(input[key],max) : current[currentKey] as string | null;
  const status = Object.hasOwn(input,"customerStatus") ? text(input.customerStatus,30).toUpperCase() : String(current.customer_status); if (!allowedStatus.has(status)) throw new CrmError("Estado de cliente inválido.",400,"CRM_CUSTOMER_STATUS_INVALID");
  const payment = Object.hasOwn(input,"preferredPaymentMethod") ? optional(input.preferredPaymentMethod,20)?.toUpperCase() ?? null : current.preferred_payment_method as string | null; if (payment && !allowedPayment.has(payment)) throw new CrmError("Método de pago inválido.",400,"CRM_PAYMENT_METHOD_INVALID");
  const result = await db.prepare(`UPDATE customers SET name=?,phone_raw=?,phone_normalized=?,customer_status=?,province=?,canton=?,district=?,default_delivery_address=?,location_url=?,location_reference=?,latitude=?,longitude=?,preferred_payment_method=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND version=?`).bind(Object.hasOwn(input,"name") ? text(input.name,200) : current.name,phone.raw,phone.normalized,status,next("province","province",100),next("canton","canton",100),next("district","district",100),next("defaultDeliveryAddress","default_delivery_address"),next("locationUrl","location_url"),next("locationReference","location_reference"),Object.hasOwn(input,"latitude")?number(input.latitude,"latitude"):current.latitude,Object.hasOwn(input,"longitude")?number(input.longitude,"longitude"):current.longitude,payment,customerId,version).run();
  if (!result.meta.changes) throw new CrmError("La versión del cliente cambió; recargá antes de guardar.",409,"CRM_CUSTOMER_VERSION_CONFLICT"); return getCustomer(db, customerId);
}

export async function addCustomerIdentity(db: D1Database, input: Record<string, unknown>) {
  const customerId = text(input.customerId,100); if (!customerId) throw new CrmError("customerId es obligatorio.",400,"CRM_CUSTOMER_ID_REQUIRED"); await mustCustomer(db,customerId); const identity=identityParts(input); if(!identity.provider) throw new CrmError("La identidad externa es obligatoria.",400,"CRM_IDENTITY_REQUIRED"); const phone=normalizeCrmPhone(input.phone);
  const found=await one(db,"SELECT * FROM customer_external_identities WHERE provider=? AND external_account=? AND external_id=?",identity.provider,identity.externalAccount,identity.externalId); if(found){if(found.customer_id!==customerId) throw new CrmError("La identidad externa ya pertenece a otro cliente.",409,"CRM_IDENTITY_CONFLICT"); return found;}
  const result={id:id("identity"),customerId,...identity,phone:phone.normalized}; await db.prepare("INSERT INTO customer_external_identities (id,customer_id,provider,external_account,external_id,phone_normalized) VALUES (?,?,?,?,?,?)").bind(result.id,result.customerId,result.provider,result.externalAccount,result.externalId,result.phone).run(); return result;
}

export async function linkChatwootContact(db:D1Database,input:Record<string,unknown>) { const customerId=text(input.customerId,100); await mustCustomer(db,customerId); const account=Number(input.accountId), contact=Number(input.contactId); if(!Number.isInteger(account)||!Number.isInteger(contact)) throw new CrmError("accountId y contactId deben ser enteros.",400,"CRM_CHATWOOT_LINK_INVALID"); const old=await one(db,"SELECT * FROM chatwoot_contact_links WHERE chatwoot_account_id=? AND chatwoot_contact_id=?",account,contact); if(old){if(old.customer_id!==customerId) throw new CrmError("El contacto Chatwoot ya está vinculado a otro cliente.",409,"CRM_CHATWOOT_CONTACT_CONFLICT"); return old;} const result={id:id("chatwoot-contact"),account,contact,customerId}; await db.prepare("INSERT INTO chatwoot_contact_links (id,chatwoot_account_id,chatwoot_contact_id,customer_id) VALUES (?,?,?,?)").bind(result.id,account,contact,customerId).run(); return result; }
export async function linkChatwootConversationOrder(db:D1Database,input:Record<string,unknown>) { const orderId=text(input.orderId,100); if(!await loadOrder(db,orderId)) throw new CrmError("Pedido no encontrado.",404,"CRM_ORDER_NOT_FOUND"); const account=Number(input.accountId), conversation=Number(input.conversationId), role=text(input.linkRole||"RELATED",50).toUpperCase(); if(!Number.isInteger(account)||!Number.isInteger(conversation)) throw new CrmError("accountId y conversationId deben ser enteros.",400,"CRM_CHATWOOT_LINK_INVALID"); const old=await one(db,"SELECT * FROM chatwoot_conversation_order_links WHERE chatwoot_account_id=? AND chatwoot_conversation_id=? AND order_id=? AND link_role=?",account,conversation,orderId,role); if(old)return old; const result={id:id("chatwoot-conversation"),account,conversation,orderId,role}; await db.prepare("INSERT INTO chatwoot_conversation_order_links (id,chatwoot_account_id,chatwoot_conversation_id,order_id,link_role) VALUES (?,?,?,?,?)").bind(result.id,account,conversation,orderId,role).run(); return result; }
export async function customerOrders(db:D1Database, customerId:string, active=false) { await mustCustomer(db,customerId); const suffix=active?" AND status NOT IN ('DELIVERED','CANCELLED','RETURNED')":""; return (await db.prepare(`SELECT id,order_number,status,payment_status,total,scheduled_delivery_date,created_at,updated_at FROM orders WHERE customer_id=?${suffix} ORDER BY created_at DESC`).bind(customerId).all<Row>()).results; }
export async function searchCrmProducts(db:D1Database, query:string) { const term=text(query,200).toLowerCase(); if(!term) throw new CrmError("q es obligatorio.",400,"CRM_PRODUCT_QUERY_REQUIRED"); return (await db.prepare("SELECT id,name,code,brand,presentation,quantity_available,minimum_stock,minimum_stock_enabled FROM products WHERE normalized_name LIKE ? OR lower(COALESCE(code,'')) LIKE ? ORDER BY name LIMIT 30").bind(`%${term}%`,`%${term}%`).all<Row>()).results.map((r)=>({...r, inventoryCondition:Number(r.quantity_available)>0?"IN_STOCK":"SPECIAL_ORDER_OR_OUT_OF_STOCK"})); }
export async function createCrmOrder(db:D1Database,input:Record<string,unknown>) { const resolved=await resolveCustomer(db,{customerId:input.customerId,phone:input.phone,externalProvider:input.externalProvider,externalId:input.externalId,externalAccount:input.externalAccount}); if(!resolved) throw new CrmError("No existe una coincidencia segura de cliente.",404,"CRM_CUSTOMER_NOT_FOUND"); const payload={...input,customerId:resolved.id,customerName:resolved.name,phone:resolved.phoneRaw,deliveryAddress:input.deliveryAddress??resolved.defaultDeliveryAddress,province:input.province??resolved.province,canton:input.canton??resolved.canton,district:input.district??resolved.district,latitude:input.latitude??resolved.latitude,longitude:input.longitude??resolved.longitude,source:"CRM"}; return createOrder(db,payload); }
