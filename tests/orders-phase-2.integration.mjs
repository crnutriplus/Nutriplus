import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { LocalD1Database } from "./helpers/local-bindings.mjs";

const DB = new LocalD1Database();
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("ordersPhase2", `${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
const env = {
  DB,
  NUTRIPLUS_APP_AUTH_MODE: "disabled",
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  IMAGES: { input() { throw new Error("Images are not used in order tests."); } },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function call(path, init = {}) {
  const response = await worker.fetch(new Request(`http://local.test${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) },
  }), env, ctx);
  const body = await response.json();
  return { response, body };
}

let sequence = 0;
function op(label) {
  sequence += 1;
  return `${label}-${String(sequence).padStart(5, "0")}`;
}

async function createProduct(name, code, quantity) {
  const result = await call("/api/products", {
    method: "POST",
    body: JSON.stringify({ name, code, purchasePriceUsd: 10, weightLb: 0.5, quantityAvailable: quantity }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.product;
}

async function stock(id) {
  return Number((await DB.prepare("SELECT quantity_available FROM products WHERE id=?").bind(id).first()).quantity_available);
}

async function createOrder(lines, extra = {}) {
  const result = await call("/api/orders", {
    method: "POST",
    body: JSON.stringify({
      operationId: op("phase2-create"),
      customerName: "Cliente Fase Dos",
      phone: "7096-2629",
      deliveryAddress: "San José",
      scheduledDeliveryDate: "2026-08-20",
      expectedPaymentMethod: "CASH",
      deliveryFee: 1000,
      source: "MANUAL",
      lines,
      ...extra,
    }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.order;
}

function editable(order, lines, extra = {}) {
  return {
    operationId: op("phase2-update"),
    version: order.version,
    orderType: order.orderType,
    customerName: order.customerName,
    phone: order.phoneRaw,
    deliveryAddress: order.deliveryAddress,
    scheduledDeliveryDate: order.scheduledDeliveryDate,
    expectedPaymentMethod: order.expectedPaymentMethod,
    deliveryFee: order.deliveryFee,
    source: order.source,
    lines: lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      productName: line.productName,
      presentation: line.presentation,
      barcode: line.barcode,
      quantity: line.quantity,
      unitPriceOriginal: line.unitPriceOriginal,
      unitPriceSold: line.unitPriceSold,
      discountAmount: line.discountAmount,
    })),
    ...extra,
  };
}

await call("/api/settings");
const alpha = await createProduct("Omega operativo", "PHASE2-A", 12);
const lastUnit = await createProduct("Última unidad UI", "PHASE2-LAST", 1);

// Crear y editar un borrador no mueve inventario; lista diaria expone unidades y resumen.
let primary = await createOrder([
  { productId: alpha.id, quantity: 2, unitPriceSold: 6000, discountAmount: 500 },
  { productName: "Producto manual", quantity: 1, unitPriceSold: 2000, discountAmount: 0 },
]);
assert.equal(primary.status, "DRAFT");
assert.equal(primary.expectedPaymentMethod, "CASH");
assert.equal(await stock(alpha.id), 12);
const daily = await call("/api/orders?date=2026-08-20&orderType=STANDARD&limit=100&page=1");
assert.equal(daily.response.status, 200);
const dailyPrimary = daily.body.orders.find((order) => order.id === primary.id);
assert.equal(dailyPrimary.lineCount, 2);
assert.equal(dailyPrimary.unitTotal, 3);
assert.match(dailyPrimary.productSummary, /Omega operativo × 2/);

const duplicates = await call("/api/orders?date=2026-08-20&phone=7096-2629&limit=10");
assert.ok(duplicates.body.orders.some((order) => order.id === primary.id));

const draftUpdate = await call(`/api/orders/${primary.id}`, {
  method: "PATCH",
  body: JSON.stringify(editable(primary, [{ ...primary.lines[0], quantity: 3 }, primary.lines[1]], { expectedPaymentMethod: "SINPE" })),
});
assert.equal(draftUpdate.response.status, 200, JSON.stringify(draftUpdate.body));
primary = draftUpdate.body.order;
assert.equal(primary.expectedPaymentMethod, "SINPE");
assert.equal(primary.payments.length, 0);
assert.equal(await stock(alpha.id), 12);

// Confirmar descuenta una vez y la reejecución conserva stock.
const confirmBody = { operationId: op("phase2-confirm"), version: primary.version };
const confirmed = await call(`/api/orders/${primary.id}/confirm`, { method: "POST", body: JSON.stringify(confirmBody) });
assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
primary = confirmed.body.order;
assert.equal(await stock(alpha.id), 9);
const confirmRetry = await call(`/api/orders/${primary.id}/confirm`, { method: "POST", body: JSON.stringify(confirmBody) });
assert.equal(confirmRetry.response.status, 200);
assert.equal(confirmRetry.body.idempotent, true);
assert.equal(await stock(alpha.id), 9);

// Edición confirmada aplica delta, cambia expectativa y no altera el ledger.
const confirmedUpdate = await call(`/api/orders/${primary.id}`, {
  method: "PATCH",
  body: JSON.stringify(editable(primary, [{ ...primary.lines[0], quantity: 4 }, primary.lines[1]], { expectedPaymentMethod: "CARD" })),
});
assert.equal(confirmedUpdate.response.status, 200, JSON.stringify(confirmedUpdate.body));
primary = confirmedUpdate.body.order;
assert.equal(await stock(alpha.id), 8);
assert.equal(primary.expectedPaymentMethod, "CARD");
assert.equal(primary.payments.length, 0);

// Abonos mixtos e idempotencia de doble toque.
const paymentBody = { operationId: op("phase2-payment"), version: primary.version, amount: 1000, method: "SINPE" };
const payment = await call(`/api/orders/${primary.id}/payments`, { method: "POST", body: JSON.stringify(paymentBody) });
assert.equal(payment.response.status, 200, JSON.stringify(payment.body));
primary = payment.body.order;
const paymentRetry = await call(`/api/orders/${primary.id}/payments`, { method: "POST", body: JSON.stringify(paymentBody) });
assert.equal(paymentRetry.response.status, 200);
assert.equal(paymentRetry.body.idempotent, true);
assert.equal(paymentRetry.body.order.paidTotal, 1000);
const cash = await call(`/api/orders/${primary.id}/payments`, {
  method: "POST",
  body: JSON.stringify({ operationId: op("phase2-payment-cash"), version: primary.version, amount: 2000, method: "CASH" }),
});
assert.equal(cash.response.status, 200, JSON.stringify(cash.body));
primary = cash.body.order;
assert.equal(primary.paidTotal, 3000);
assert.equal(primary.expectedPaymentMethod, "CARD");
assert.deepEqual(new Set(primary.payments.map((entry) => entry.method)), new Set(["SINPE", "CASH"]));

// Preparar y entregar no vuelven a tocar inventario.
const beforePrepare = await stock(alpha.id);
const prepared = await call(`/api/orders/${primary.id}/prepare`, {
  method: "POST", body: JSON.stringify({ operationId: op("phase2-prepare"), version: primary.version }),
});
assert.equal(prepared.response.status, 200, JSON.stringify(prepared.body));
primary = prepared.body.order;
assert.equal(await stock(alpha.id), beforePrepare);
const delivered = await call(`/api/orders/${primary.id}/deliver`, {
  method: "POST", body: JSON.stringify({ operationId: op("phase2-deliver"), version: primary.version }),
});
assert.equal(delivered.response.status, 200, JSON.stringify(delivered.body));
assert.equal(delivered.body.order.status, "DELIVERED");
assert.equal(await stock(alpha.id), beforePrepare);

// Cancelar confirmado restaura; reprogramar conserva historial y stock.
let cancellable = await createOrder([{ productId: alpha.id, quantity: 2, unitPriceSold: 5000 }], { phone: "7000-0001" });
const cancellableConfirmed = await call(`/api/orders/${cancellable.id}/confirm`, {
  method: "POST", body: JSON.stringify({ operationId: op("phase2-confirm-cancel"), version: cancellable.version }),
});
assert.equal(cancellableConfirmed.response.status, 200, JSON.stringify(cancellableConfirmed.body));
cancellable = cancellableConfirmed.body.order;
const beforeCancel = await stock(alpha.id);
const cancelled = await call(`/api/orders/${cancellable.id}/cancel`, {
  method: "POST", body: JSON.stringify({ operationId: op("phase2-cancel"), version: cancellable.version, reason: "Cliente cambió de opinión" }),
});
assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.body));
assert.equal(await stock(alpha.id), beforeCancel + 2);

let routeOne = await createOrder([{ productName: "Ruta uno", quantity: 1, unitPriceSold: 1000 }], { phone: "7000-0101" });
let routeTwo = await createOrder([{ productName: "Ruta dos", quantity: 1, unitPriceSold: 1000 }], { phone: "7000-0102" });
const routeThree = await createOrder([{ productName: "Ruta tres", quantity: 1, unitPriceSold: 1000 }], { phone: "7000-0103" });
const reprogrammed = await call(`/api/orders/${routeOne.id}/reprogram`, {
  method: "POST",
  body: JSON.stringify({ operationId: op("phase2-reprogram"), version: routeOne.version, scheduledDeliveryDate: "2026-08-21", reason: "Cambio de ruta" }),
});
assert.equal(reprogrammed.response.status, 200, JSON.stringify(reprogrammed.body));
routeOne = reprogrammed.body.order;
assert.equal(routeOne.scheduledDeliveryDate, "2026-08-21");
const reprogramHistory = await call(`/api/orders/${routeOne.id}/history`);
assert.ok(reprogramHistory.body.events.some((event) => event.event_type === "order.reprogrammed"));

// Orden de ruta persistente y filtros/paginación disponibles para la UI.
const route = await call("/api/delivery-routes", { method: "POST", body: JSON.stringify({ date: "2026-08-20", label: "Fase 2" }) });
assert.equal(route.response.status, 201, JSON.stringify(route.body));
for (const [position, order] of [routeTwo, routeThree].entries()) {
  const assigned = await call(`/api/delivery-routes/${route.body.route.id}/orders`, {
    method: "POST", body: JSON.stringify({ orderId: order.id, position: position + 1 }),
  });
  assert.equal(assigned.response.status, 200, JSON.stringify(assigned.body));
}
const routed = await call("/api/orders?date=2026-08-20&orderType=STANDARD&limit=100&page=1");
const routedRows = routed.body.orders.filter((order) => order.routeId === route.body.route.id);
assert.deepEqual(routedRows.map((order) => order.routePosition), [1, 2]);
for (const [position, order] of [routeThree, routeTwo].entries()) {
  const reordered = await call(`/api/delivery-routes/${route.body.route.id}/orders`, {
    method: "POST", body: JSON.stringify({ orderId: order.id, position: position + 1 }),
  });
  assert.equal(reordered.response.status, 200, JSON.stringify(reordered.body));
}
const swapped = await call("/api/orders?date=2026-08-20&orderType=STANDARD&limit=100&page=1");
const swappedRows = swapped.body.orders.filter((order) => order.routeId === route.body.route.id);
assert.deepEqual(swappedRows.map((order) => order.id), [routeThree.id, routeTwo.id]);
assert.deepEqual(swappedRows.map((order) => order.routePosition), [1, 2]);
const productSearch = await call("/api/orders?product=Omega&limit=5&page=1");
assert.ok(productSearch.body.total >= 2);
assert.equal(productSearch.body.limit, 5);

// Concurrencia de la última unidad: solo un pedido confirma.
const raceA = await createOrder([{ productId: lastUnit.id, quantity: 1, unitPriceSold: 1000 }], { phone: "7000-0201" });
const raceB = await createOrder([{ productId: lastUnit.id, quantity: 1, unitPriceSold: 1000 }], { phone: "7000-0202" });
const race = await Promise.all([
  call(`/api/orders/${raceA.id}/confirm`, { method: "POST", body: JSON.stringify({ operationId: op("phase2-race-a"), version: raceA.version }) }),
  call(`/api/orders/${raceB.id}/confirm`, { method: "POST", body: JSON.stringify({ operationId: op("phase2-race-b"), version: raceB.version }) }),
]);
assert.deepEqual(race.map((entry) => entry.response.status).sort(), [200, 409]);
assert.equal(await stock(lastUnit.id), 0);

// Contrato estático de la interfaz: navegación, escáner, duplicados y respuesta móvil.
const [clientSource, ordersSource, cssSource] = await Promise.all([
  readFile(new URL("../app/client-app.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/orders-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);
assert.match(clientSource, /\["orders", "Pedidos", Truck\]/);
assert.match(clientSource, /openScanner\("orders"\)/);
assert.match(ordersSource, /Posible pedido duplicado/);
assert.match(ordersSource, /Método esperado de pago/);
assert.match(ordersSource, /Pagos reales/);
assert.match(ordersSource, /Lista de preparación/);
assert.match(ordersSource, /Guardar borrador/);
assert.match(cssSource, /@media \(max-width: 520px\)/);
assert.match(cssSource, /grid-template-columns: repeat\(5, 1fr\)/);

assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM order_operations WHERE status='pending'").first()).total), 0);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM products WHERE quantity_available<0").first()).total), 0);
DB.close();
console.log("Orders Phase 2: operational UI contract, daily summaries, duplicate detection, state actions, payments, routes, idempotency, concurrency, and responsive navigation passed");
