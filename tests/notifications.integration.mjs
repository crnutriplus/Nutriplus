import assert from "node:assert/strict";
import { LocalD1Database } from "./helpers/local-bindings.mjs";

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function testPushConfiguration() {
  const vapidKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const vapidPublic = new Uint8Array(await crypto.subtle.exportKey("raw", vapidKeys.publicKey));
  const vapidPrivate = await crypto.subtle.exportKey("jwk", vapidKeys.privateKey);
  const receiverKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const receiverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", receiverKeys.publicKey));
  return {
    env: {
      VAPID_PUBLIC_KEY: base64Url(vapidPublic),
      VAPID_PRIVATE_KEY: vapidPrivate.d,
      VAPID_SUBJECT: "mailto:admin@nutriplus.test",
    },
    subscription: {
      endpoint: "https://push.example.test/subscriptions/android-owner",
      expirationTime: null,
      keys: {
        p256dh: base64Url(receiverPublic),
        auth: base64Url(crypto.getRandomValues(new Uint8Array(16))),
      },
      deviceLabel: "Android de prueba",
    },
  };
}

const DB = new LocalD1Database();
const push = await testPushConfiguration();
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("notifications", `${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
let pushStatus = 503;
const pushRequests = [];
globalThis.__NUTRIPLUS_PUSH_TEST_FETCH__ = async (input, init) => {
  pushRequests.push({ input: String(input), init });
  return new Response(pushStatus === 201 ? null : "push unavailable", { status: pushStatus });
};

const pending = [];
const ctx = {
  waitUntil(promise) { pending.push(Promise.resolve(promise)); },
  passThroughOnException() {},
};
const env = {
  DB,
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  IMAGES: { input() { throw new Error("Images are not used in notification tests."); } },
  ...push.env,
};

async function drain() {
  while (pending.length) await Promise.allSettled(pending.splice(0));
}

async function call(path, init = {}) {
  const response = await worker.fetch(new Request(`http://local.test${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  }), env, ctx);
  const body = await response.json();
  await drain();
  return { response, body };
}

let operation = 0;
function mutationId(label) {
  operation += 1;
  return `notifications-${label}-${String(operation).padStart(4, "0")}`;
}

async function createProduct(name, code, quantityAvailable, minimumStock, minimumStockEnabled = true) {
  const result = await call("/api/products", {
    method: "POST",
    headers: { "x-mutation-id": mutationId("create-product") },
    body: JSON.stringify({ name, code, purchasePriceUsd: 10, weightLb: 0.5, quantityAvailable, minimumStock, minimumStockEnabled }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.product;
}

async function updateProduct(product, quantityAvailable, id = mutationId("update-product")) {
  const payload = {
    name: product.name,
    code: product.code,
    purchasePriceUsd: product.purchasePriceUsd,
    weightLb: product.weightLb,
    quantityAvailable,
    minimumStock: product.minimumStock,
    minimumStockEnabled: product.minimumStockEnabled,
    version: product.version,
  };
  const result = await call(`/api/products/${product.id}`, {
    method: "PUT",
    headers: { "x-mutation-id": id },
    body: JSON.stringify(payload),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return { product: result.body.product, payload, mutationId: id, result };
}

function costaRicaDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(key, days) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
}

async function createOrder(scheduledDeliveryDate, extra = {}) {
  const result = await call("/api/orders", {
    method: "POST",
    body: JSON.stringify({
      operationId: mutationId("create-order"),
      customerName: "Cliente de notificaciones",
      phone: "7096-2629",
      scheduledDeliveryDate,
      deliveryFee: 0,
      source: "MANUAL",
      lines: [{ productName: "Producto manual de alerta", quantity: 1, unitPriceSold: 5000, discountAmount: 0 }],
      ...extra,
    }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.order;
}

await call("/api/settings");

// La API pública solo expone la clave VAPID pública.
const publicKey = await call("/api/notifications/push/public-key");
assert.equal(publicKey.response.status, 200);
assert.equal(publicKey.body.publicKey, push.env.VAPID_PUBLIC_KEY);
assert.equal("privateKey" in publicKey.body, false);

// Una misma subscription se actualiza, no se duplica, y habilita push explícitamente.
const subscriptionOne = await call("/api/notifications/push/subscriptions", { method: "POST", body: JSON.stringify(push.subscription) });
assert.equal(subscriptionOne.response.status, 201, JSON.stringify(subscriptionOne.body));
assert.equal(subscriptionOne.body.activeDevices, 1);
assert.equal(subscriptionOne.body.preferences.pushEnabled, true);
const subscriptionTwo = await call("/api/notifications/push/subscriptions", { method: "POST", body: JSON.stringify(push.subscription) });
assert.equal(subscriptionTwo.response.status, 201, JSON.stringify(subscriptionTwo.body));
assert.equal(subscriptionTwo.body.activeDevices, 1);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM push_subscriptions").first()).total), 1);

// 1–9: umbral, no-spam, agotado, rearmado, idempotencia y fallo push aislado.
let stock = await createProduct("Omega 3 notificaciones", "NOTIFY-OMEGA", 4, 2);
stock = (await updateProduct(stock, 3)).product;
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM notification_events WHERE entity_type='product' AND entity_id=?").bind(String(stock.id)).first()).total), 0, "stock above minimum must not alert");

const beforeLow = stock;
const lowOperation = mutationId("low-stock-retry");
const lowUpdate = await updateProduct(beforeLow, 2, lowOperation);
stock = lowUpdate.product;
assert.equal(stock.quantityAvailable, 2, "business mutation must persist even when push returns 503");
assert.equal(Number((await DB.prepare("SELECT quantity_available FROM products WHERE id=?").bind(stock.id).first()).quantity_available), 2);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM notification_events WHERE event_type='inventory.low_stock' AND entity_id=?").bind(String(stock.id)).first()).total), 1);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM notifications WHERE event_type='inventory.low_stock' AND entity_id=?").bind(String(stock.id)).first()).total), 1, "internal alert must remain when external push fails");
assert.equal((await DB.prepare("SELECT target_url FROM notifications WHERE event_type='inventory.low_stock' AND entity_id=?").bind(String(stock.id)).first()).target_url, `/?tab=products&product=${stock.id}`);
assert.deepEqual(JSON.parse((await DB.prepare("SELECT metadata_json FROM notifications WHERE event_type='inventory.low_stock' AND entity_id=?").bind(String(stock.id)).first()).metadata_json).destination, { type: "PRODUCT", id: String(stock.id) });
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM notification_deliveries WHERE state='FAILED' AND response_status=503").first()).total), 1);
assert.equal(pushRequests.length, 1);
assert.equal(pushRequests[0].input, push.subscription.endpoint);
assert.ok(pushRequests[0].init.body.byteLength > 20, "push payload must be encrypted before delivery");

const retry = await call(`/api/products/${beforeLow.id}`, {
  method: "PUT",
  headers: { "x-mutation-id": lowOperation },
  body: JSON.stringify(lowUpdate.payload),
});
assert.equal(retry.response.status, 200);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM notification_events WHERE event_type='inventory.low_stock' AND entity_id=?").bind(String(stock.id)).first()).total), 1, "same mutation retry must not duplicate the event");

stock = (await updateProduct(stock, 1)).product;
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM notification_events WHERE event_type='inventory.low_stock' AND entity_id=?").bind(String(stock.id)).first()).total), 1, "lowering further inside LOW_STOCK must not repeat it");
stock = (await updateProduct(stock, 0)).product;
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM notification_events WHERE event_type='inventory.out_of_stock' AND entity_id=?").bind(String(stock.id)).first()).total), 1, "zero can create a distinct OUT_OF_STOCK event");
stock = (await updateProduct(stock, 10)).product;
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM notification_events WHERE event_type='inventory.back_in_stock' AND entity_id=?").bind(String(stock.id)).first()).total), 1, "replenishment must record BACK_IN_STOCK and rearm the cycle");
stock = (await updateProduct(stock, 2)).product;
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM notification_events WHERE event_type='inventory.low_stock' AND entity_id=?").bind(String(stock.id)).first()).total), 2, "a later threshold crossing must alert again");
assert.deepEqual({ ...await DB.prepare("SELECT state_value,cycle FROM notification_resource_states WHERE entity_type='product' AND entity_id=? AND state_key='stock'").bind(String(stock.id)).first() }, { state_value: "LOW_STOCK", cycle: 3 });

// Leer, descartar y leer todas modifican solo el estado de las alertas.
let listed = await call("/api/notifications?includeDismissed=1&limit=100");
const lowItem = listed.body.notifications.find((item) => item.eventType === "inventory.low_stock");
const outItem = listed.body.notifications.find((item) => item.eventType === "inventory.out_of_stock");
assert.ok(lowItem && outItem);
assert.deepEqual(lowItem.destination, { type: "PRODUCT", id: String(stock.id) });
const read = await call(`/api/notifications/${lowItem.id}`, { method: "PATCH", body: JSON.stringify({ action: "READ" }) });
assert.ok(read.body.notification.readAt);
const dismissed = await call(`/api/notifications/${outItem.id}`, { method: "PATCH", body: JSON.stringify({ action: "DISMISS" }) });
assert.ok(dismissed.body.notification.dismissedAt);
const readAll = await call("/api/notifications/read-all", { method: "POST" });
assert.ok(readAll.body.updated >= 0);
listed = await call("/api/notifications?limit=100");
assert.equal(listed.body.unreadCount, 0);
assert.equal(listed.body.notifications.some((item) => item.id === outItem.id), false, "dismissed alerts must leave the active list");

// Preferencias desactivadas conservan el evento durable pero no crean una alerta visible.
const disableLow = await call("/api/notifications/preferences", { method: "PUT", body: JSON.stringify({ lowStockEnabled: false }) });
assert.equal(disableLow.body.preferences.lowStockEnabled, false);
let muted = await createProduct("Producto silenciado", "NOTIFY-MUTED", 3, 2);
muted = (await updateProduct(muted, 2)).product;
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM notification_events WHERE event_type='inventory.low_stock' AND entity_id=? AND processing_state='SKIPPED'").bind(String(muted.id)).first()).total), 1);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM notifications WHERE entity_type='product' AND entity_id=?").bind(String(muted.id)).first()).total), 0);
await call("/api/notifications/preferences", { method: "PUT", body: JSON.stringify({ lowStockEnabled: true }) });

// Un endpoint 410 se desactiva; el agotado y su operación de inventario permanecen.
pushStatus = 410;
let gone = await createProduct("Producto subscription inválida", "NOTIFY-GONE", 1, 0);
gone = (await updateProduct(gone, 0)).product;
assert.equal(gone.quantityAvailable, 0);
assert.ok((await DB.prepare("SELECT disabled_at FROM push_subscriptions WHERE endpoint=?").bind(push.subscription.endpoint).first()).disabled_at);
assert.equal((await DB.prepare("SELECT disabled_reason FROM push_subscriptions WHERE endpoint=?").bind(push.subscription.endpoint).first()).disabled_reason, "PUSH_SUBSCRIPTION_GONE");
assert.equal(Number((await DB.prepare("SELECT push_enabled FROM notification_preferences WHERE id=1").first()).push_enabled), 0);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM notifications WHERE event_type='inventory.out_of_stock' AND entity_id=?").bind(String(gone.id)).first()).total), 1);

// Pedidos se consolidan por fecha; dos reconciliaciones no repiten el resumen.
const today = costaRicaDateKey();
const tomorrow = addDays(today, 1);
await createOrder(tomorrow);
await createOrder(tomorrow);
const reconcileOrders = await call("/api/notifications/reconcile", { method: "POST" });
assert.equal(reconcileOrders.body.timeZone, "America/Costa_Rica");
assert.equal(reconcileOrders.body.schedulingMode, "ON_OPEN_RECONCILIATION");
await call("/api/notifications/reconcile", { method: "POST" });
const orderEvents = await DB.prepare("SELECT payload_json FROM notification_events WHERE event_type='order.tomorrow' AND entity_id=?").bind(tomorrow).all();
assert.equal(orderEvents.results.length, 1, "tomorrow orders must be one daily summary");
assert.equal(JSON.parse(orderEvents.results[0].payload_json).count, 2);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM notifications WHERE event_type='order.tomorrow' AND entity_id=?").bind(tomorrow).first()).total), 1);
assert.deepEqual(JSON.parse((await DB.prepare("SELECT metadata_json FROM notifications WHERE event_type='order.tomorrow' AND entity_id=?").bind(tomorrow).first()).metadata_json).destination, { type: "ORDER_SUMMARY", date: tomorrow });
await createOrder(tomorrow);
await call("/api/notifications/reconcile", { method: "POST" });
const refreshedSummary = await DB.prepare("SELECT payload_json FROM notification_events WHERE event_type='order.tomorrow' AND entity_id=?").bind(tomorrow).first();
assert.equal(JSON.parse(refreshedSummary.payload_json).count, 3, "the existing consolidated summary must refresh without creating another alert");
assert.match((await DB.prepare("SELECT message FROM notifications WHERE event_type='order.tomorrow' AND entity_id=?").bind(tomorrow).first()).message, /3 pedidos programados/);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM notification_events WHERE event_type='order.tomorrow' AND entity_id=?").bind(tomorrow).first()).total), 1);

// Encargos alertan en hitos D-3/D-1/D0 y solo una vez por atraso/fecha estimada.
const estimated = addDays(today, 3);
const special = await createOrder(null, { orderType: "SPECIAL_ORDER", estimatedArrivalDate: estimated });
await call("/api/notifications/reconcile", { method: "POST" });
await call("/api/notifications/reconcile", { method: "POST" });
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM notification_events WHERE event_type='special_order.arrival_soon' AND entity_id=?").bind(special.id).first()).total), 1);
assert.deepEqual(JSON.parse((await DB.prepare("SELECT metadata_json FROM notifications WHERE event_type='special_order.arrival_soon' AND entity_id=?").bind(special.id).first()).metadata_json).destination, { type: "ORDER", id: special.id, section: "special" });
const overdueDate = addDays(today, -2);
await DB.prepare("UPDATE special_order_details SET estimated_arrival_date=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE order_id=?").bind(overdueDate, special.id).run();
await call("/api/notifications/reconcile", { method: "POST" });
await call("/api/notifications/reconcile", { method: "POST" });
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM notification_events WHERE event_type='special_order.overdue' AND entity_id=?").bind(special.id).first()).total), 1, "overdue must not repeat daily for the same estimated date");

// Los cambios de stock originados dentro del trigger transaccional de Pedidos también alimentan el sistema central.
const orderStock = await createProduct("Producto confirmado desde pedido", "NOTIFY-ORDER-STOCK", 4, 2);
const stockOrder = await createOrder(addDays(today, 10), {
  lines: [{ productId: orderStock.id, quantity: 2, unitPriceSold: 5000, discountAmount: 0 }],
});
const confirmed = await call(`/api/orders/${stockOrder.id}/confirm`, {
  method: "POST",
  body: JSON.stringify({ operationId: mutationId("confirm-order-stock"), version: stockOrder.version }),
});
assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
assert.equal(Number((await DB.prepare("SELECT quantity_available FROM products WHERE id=?").bind(orderStock.id).first()).quantity_available), 2);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM notification_events WHERE event_type='inventory.low_stock' AND entity_id=?").bind(String(orderStock.id)).first()).total), 1, "order inventory trigger must cascade into one LOW_STOCK event");

delete globalThis.__NUTRIPLUS_PUSH_TEST_FETCH__;
DB.close();
console.log("Notifications integration validates inventory cycles, preferences, Web Push isolation, subscriptions, consolidated orders, special-order cadence, and Costa Rica time");
