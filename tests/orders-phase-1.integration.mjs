import assert from "node:assert/strict";
import { LocalD1Database } from "./helpers/local-bindings.mjs";

const DB = new LocalD1Database();
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("orders", `${Date.now()}`);
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

async function product(name, code, quantity) {
  const result = await call("/api/products", {
    method: "POST",
    body: JSON.stringify({ name, code, purchasePriceUsd: 10, weightLb: 0.5, quantityAvailable: quantity }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.product;
}

function line(productRecord, quantity, unitPriceSold = 5000, extra = {}) {
  return { productId: productRecord.id, quantity, unitPriceSold, discountAmount: 0, ...extra };
}

let operationCounter = 0;
function op(label) {
  operationCounter += 1;
  return `${label}-${String(operationCounter).padStart(4, "0")}`;
}

async function create(lines, extra = {}) {
  const operationId = op("create-order");
  const result = await call("/api/orders", {
    method: "POST",
    body: JSON.stringify({
      operationId,
      customerName: "Cliente de prueba",
      phone: "7096-2629",
      scheduledDeliveryDate: "2026-08-20",
      deliveryFee: 1000,
      source: "MANUAL",
      lines,
      ...extra,
    }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  assert.match(result.body.order.orderNumber, /^NP-\d{6}$/);
  assert.equal(result.body.order.phoneNormalized, "+50670962629");
  return result.body.order;
}

function updatePayload(order, lines, operationId = op("update-order"), extra = {}) {
  return {
    operationId,
    version: order.version,
    customerName: order.customerName,
    phone: order.phoneRaw,
    scheduledDeliveryDate: order.scheduledDeliveryDate,
    deliveryFee: order.deliveryFee,
    source: order.source,
    lines: lines.map((item) => ({
      id: item.id,
      productId: item.productId,
      productName: item.productName,
      presentation: item.presentation,
      barcode: item.barcode,
      quantity: item.quantity,
      unitPriceOriginal: item.unitPriceOriginal,
      unitPriceSold: item.unitPriceSold,
      discountAmount: item.discountAmount,
    })),
    ...extra,
  };
}

async function quantity(productId) {
  return Number((await DB.prepare("SELECT quantity_available FROM products WHERE id=?").bind(productId).first()).quantity_available);
}

await call("/api/settings");
const alpha = await product("Producto Alpha", "ORD-A", 20);
const beta = await product("Producto Beta", "ORD-B", 2);

// 1–4: draft, confirmación, idempotencia y confirmación duplicada.
let primary = await create([line(alpha, 3)]);
assert.equal(primary.status, "DRAFT");
assert.equal(await quantity(alpha.id), 20);
const confirmOperation = op("confirm-order");
let confirmed = await call(`/api/orders/${primary.id}/confirm`, {
  method: "POST",
  body: JSON.stringify({ operationId: confirmOperation, version: primary.version }),
});
assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
primary = confirmed.body.order;
assert.equal(primary.status, "CONFIRMED");
assert.equal(await quantity(alpha.id), 17);
const confirmRetry = await call(`/api/orders/${primary.id}/confirm`, {
  method: "POST",
  body: JSON.stringify({ operationId: confirmOperation, version: 1 }),
});
assert.equal(confirmRetry.response.status, 200);
assert.equal(confirmRetry.body.idempotent, true);
assert.equal(await quantity(alpha.id), 17);
const secondConfirm = await call(`/api/orders/${primary.id}/confirm`, {
  method: "POST",
  body: JSON.stringify({ operationId: op("confirm-again"), version: primary.version }),
});
assert.equal(secondConfirm.response.status, 409);
assert.equal(await quantity(alpha.id), 17);

// 5: stock insuficiente aborta todas las líneas.
const shortageDraft = await create([line(alpha, 2), line(beta, 4)]);
const alphaBeforeShortage = await quantity(alpha.id);
const betaBeforeShortage = await quantity(beta.id);
const shortage = await call(`/api/orders/${shortageDraft.id}/confirm`, {
  method: "POST",
  body: JSON.stringify({ operationId: op("confirm-shortage"), version: shortageDraft.version }),
});
assert.equal(shortage.response.status, 409);
assert.equal(shortage.body.code, "ORDER_INSUFFICIENT_STOCK");
assert.equal(shortage.body.details.shortages[0].missing, 2);
assert.equal(await quantity(alpha.id), alphaBeforeShortage);
assert.equal(await quantity(beta.id), betaBeforeShortage);
assert.equal((await call(`/api/orders/${shortageDraft.id}`)).body.order.status, "DRAFT");

// 6–8: edición confirmada por delta y eliminación lógica de línea.
let editResult = await call(`/api/orders/${primary.id}`, {
  method: "PATCH",
  body: JSON.stringify(updatePayload(primary, [{ ...primary.lines[0], quantity: 5 }])),
});
assert.equal(editResult.response.status, 200, JSON.stringify(editResult.body));
primary = editResult.body.order;
assert.equal(await quantity(alpha.id), 15);
editResult = await call(`/api/orders/${primary.id}`, {
  method: "PATCH",
  body: JSON.stringify(updatePayload(primary, [{ ...primary.lines[0], quantity: 3 }])),
});
assert.equal(editResult.response.status, 200, JSON.stringify(editResult.body));
primary = editResult.body.order;
assert.equal(await quantity(alpha.id), 17);

let twoLine = await create([line(alpha, 2), line(beta, 1)]);
let twoLineConfirm = await call(`/api/orders/${twoLine.id}/confirm`, {
  method: "POST", body: JSON.stringify({ operationId: op("confirm-two-line"), version: twoLine.version }),
});
assert.equal(twoLineConfirm.response.status, 200, JSON.stringify(twoLineConfirm.body));
twoLine = twoLineConfirm.body.order;
const betaAfterConfirm = await quantity(beta.id);
const removeLine = await call(`/api/orders/${twoLine.id}`, {
  method: "PATCH", body: JSON.stringify(updatePayload(twoLine, [twoLine.lines[0]])),
});
assert.equal(removeLine.response.status, 200, JSON.stringify(removeLine.body));
twoLine = removeLine.body.order;
assert.equal(twoLine.lines.length, 1);
assert.equal(twoLine.removedLines.length, 1);
assert.equal(await quantity(beta.id), betaAfterConfirm + 1);

// 9–10: cancelar restaura una vez; preparar y entregar no mueven stock.
const alphaBeforeCancel = await quantity(alpha.id);
const cancelOperation = op("cancel-order");
const cancelled = await call(`/api/orders/${twoLine.id}/cancel`, {
  method: "POST", body: JSON.stringify({ operationId: cancelOperation, version: twoLine.version, reason: "Cliente canceló la compra" }),
});
assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.body));
assert.equal(await quantity(alpha.id), alphaBeforeCancel + 2);
const cancelRetry = await call(`/api/orders/${twoLine.id}/cancel`, {
  method: "POST", body: JSON.stringify({ operationId: cancelOperation, version: twoLine.version, reason: "Cliente canceló la compra" }),
});
assert.equal(cancelRetry.response.status, 200);
assert.equal(cancelRetry.body.idempotent, true);
assert.equal(await quantity(alpha.id), alphaBeforeCancel + 2);

const stockBeforePrepare = await quantity(alpha.id);
const prepared = await call(`/api/orders/${primary.id}/prepare`, {
  method: "POST", body: JSON.stringify({ operationId: op("prepare-order"), version: primary.version }),
});
assert.equal(prepared.response.status, 200, JSON.stringify(prepared.body));
primary = prepared.body.order;
assert.equal(await quantity(alpha.id), stockBeforePrepare);
const delivered = await call(`/api/orders/${primary.id}/deliver`, {
  method: "POST", body: JSON.stringify({ operationId: op("deliver-order"), version: primary.version }),
});
assert.equal(delivered.response.status, 200, JSON.stringify(delivered.body));
primary = delivered.body.order;
assert.equal(primary.status, "DELIVERED");
assert.equal(primary.lines[0].deliveredQuantity, 3);
assert.equal(await quantity(alpha.id), stockBeforePrepare);

// 11–14: bloqueo de entregado, reapertura con motivo y pagos ledger/idempotentes.
const forbiddenEdit = await call(`/api/orders/${primary.id}`, {
  method: "PATCH", body: JSON.stringify(updatePayload(primary, primary.lines)),
});
assert.equal(forbiddenEdit.response.status, 409);
const reopenWithoutReason = await call(`/api/orders/${primary.id}/reopen`, {
  method: "POST", body: JSON.stringify({ operationId: op("reopen-no-reason"), version: primary.version }),
});
assert.equal(reopenWithoutReason.response.status, 400);
const reopened = await call(`/api/orders/${primary.id}/reopen`, {
  method: "POST", body: JSON.stringify({ operationId: op("reopen-order"), version: primary.version, reason: "Corregir cantidad entregada" }),
});
assert.equal(reopened.response.status, 200, JSON.stringify(reopened.body));
primary = reopened.body.order;
assert.equal(primary.status, "REOPENED");

let paymentOrder = await create([{ productName: "Producto manual", quantity: 1, unitPriceSold: 15000, discountAmount: 0 }]);
const payOneOperation = op("payment-one");
const payOne = await call(`/api/orders/${paymentOrder.id}/payments`, {
  method: "POST", body: JSON.stringify({ operationId: payOneOperation, version: paymentOrder.version, amount: 5000, method: "SINPE" }),
});
assert.equal(payOne.response.status, 200, JSON.stringify(payOne.body));
paymentOrder = payOne.body.order;
assert.equal(paymentOrder.paymentStatus, "PARTIAL");
const payRetry = await call(`/api/orders/${paymentOrder.id}/payments`, {
  method: "POST", body: JSON.stringify({ operationId: payOneOperation, version: 1, amount: 5000, method: "SINPE" }),
});
assert.equal(payRetry.response.status, 200);
assert.equal(payRetry.body.idempotent, true);
assert.equal(payRetry.body.order.paidTotal, 5000);
const payTwo = await call(`/api/orders/${paymentOrder.id}/payments`, {
  method: "POST", body: JSON.stringify({ operationId: op("payment-two"), version: paymentOrder.version, amount: 11000, method: "CASH" }),
});
assert.equal(payTwo.response.status, 200, JSON.stringify(payTwo.body));
paymentOrder = payTwo.body.order;
assert.equal(paymentOrder.paymentStatus, "PAID");
assert.deepEqual(new Set(paymentOrder.payments.filter((entry) => entry.type === "PAYMENT").map((entry) => entry.method)), new Set(["SINPE", "CASH"]));
const sinpePayment = paymentOrder.payments.find((entry) => entry.method === "SINPE" && entry.type === "PAYMENT");
assert.ok(sinpePayment);
const reversalOperation = op("payment-reversal");
const reversedPayment = await call(`/api/orders/${paymentOrder.id}/payments`, {
  method: "POST",
  body: JSON.stringify({
    operationId: reversalOperation,
    version: paymentOrder.version,
    type: "REVERSAL",
    reversesPaymentId: sinpePayment.id,
    reason: "SINPE registrado por error",
  }),
});
assert.equal(reversedPayment.response.status, 200, JSON.stringify(reversedPayment.body));
paymentOrder = reversedPayment.body.order;
assert.equal(paymentOrder.paidTotal, 11000);
assert.equal(paymentOrder.paymentStatus, "PARTIAL");
assert.ok(paymentOrder.payments.some((entry) => entry.type === "PAYMENT" && entry.id === sinpePayment.id));
assert.ok(paymentOrder.payments.some((entry) => entry.type === "REVERSAL" && entry.reversesPaymentId === sinpePayment.id));
const reversalRetry = await call(`/api/orders/${paymentOrder.id}/payments`, {
  method: "POST",
  body: JSON.stringify({
    operationId: reversalOperation,
    version: paymentOrder.version - 1,
    type: "REVERSAL",
    reversesPaymentId: sinpePayment.id,
    reason: "SINPE registrado por error",
  }),
});
assert.equal(reversalRetry.response.status, 200);
assert.equal(reversalRetry.body.idempotent, true);
assert.equal(reversalRetry.body.order.paidTotal, 11000);

// 15–16: devoluciones con y sin reingreso.
const alphaBeforeReturn = await quantity(alpha.id);
const returned = await call(`/api/orders/${primary.id}/returns`, {
  method: "POST",
  body: JSON.stringify({ operationId: op("return-stock"), version: primary.version, reason: "Producto cerrado devuelto", lines: [{ orderLineId: primary.lines[0].id, quantity: 1, reenterInventory: true }] }),
});
assert.equal(returned.response.status, 200, JSON.stringify(returned.body));
primary = returned.body.order;
assert.equal(await quantity(alpha.id), alphaBeforeReturn + 1);
const beforeNoStockReturn = await quantity(alpha.id);
const returnedWithoutStock = await call(`/api/orders/${primary.id}/returns`, {
  method: "POST",
  body: JSON.stringify({ operationId: op("return-no-stock"), version: primary.version, reason: "Producto abierto", lines: [{ orderLineId: primary.lines[0].id, quantity: 1, reenterInventory: false }] }),
});
assert.equal(returnedWithoutStock.response.status, 200, JSON.stringify(returnedWithoutStock.body));
primary = returnedWithoutStock.body.order;
assert.equal(await quantity(alpha.id), beforeNoStockReturn);

// 17: una edición obsoleta se rechaza.
let concurrentDraft = await create([line(alpha, 1)]);
const stalePayload = updatePayload(concurrentDraft, [{ ...concurrentDraft.lines[0], quantity: 2 }], op("stale-update"));
const freshUpdate = await call(`/api/orders/${concurrentDraft.id}`, {
  method: "PATCH", body: JSON.stringify(updatePayload(concurrentDraft, [{ ...concurrentDraft.lines[0], quantity: 3 }])),
});
assert.equal(freshUpdate.response.status, 200, JSON.stringify(freshUpdate.body));
const staleUpdate = await call(`/api/orders/${concurrentDraft.id}`, { method: "PATCH", body: JSON.stringify(stalePayload) });
assert.equal(staleUpdate.response.status, 409);
assert.equal(staleUpdate.body.code, "ORDER_CONCURRENT_UPDATE");

// 18: dos pedidos no pueden consumir dos veces la última unidad.
const lastUnit = await product("Última unidad", "ORD-LAST", 1);
const raceOne = await create([line(lastUnit, 1)]);
const raceTwo = await create([line(lastUnit, 1)]);
const raceResults = await Promise.all([
  call(`/api/orders/${raceOne.id}/confirm`, { method: "POST", body: JSON.stringify({ operationId: op("race-confirm-a"), version: raceOne.version }) }),
  call(`/api/orders/${raceTwo.id}/confirm`, { method: "POST", body: JSON.stringify({ operationId: op("race-confirm-b"), version: raceTwo.version }) }),
]);
assert.deepEqual(raceResults.map((result) => result.response.status).sort(), [200, 409]);
assert.equal(await quantity(lastUnit.id), 0);

// 19–21: reprogramación, snapshots históricos, NP concurrente y fecha Costa Rica.
const stockBeforeReprogram = await quantity(alpha.id);
const reprogrammed = await call(`/api/orders/${concurrentDraft.id}/reprogram`, {
  method: "POST", body: JSON.stringify({ operationId: op("reprogram-order"), version: freshUpdate.body.order.version, scheduledDeliveryDate: "2026-08-21", reason: "Cambio de ruta" }),
});
assert.equal(reprogrammed.response.status, 200, JSON.stringify(reprogrammed.body));
assert.equal(reprogrammed.body.order.scheduledDeliveryDate, "2026-08-21");
assert.equal(await quantity(alpha.id), stockBeforeReprogram);

const snapshotDraft = await create([line(alpha, 1)]);
const alphaCurrent = (await call("/api/products?code=ORD-A")).body.product;
const renamed = await call(`/api/products/${alpha.id}`, {
  method: "PUT",
  body: JSON.stringify({ ...alphaCurrent, name: "Producto Alpha Renombrado", version: alphaCurrent.version, base: alphaCurrent }),
});
assert.equal(renamed.response.status, 200);
assert.equal((await call(`/api/orders/${snapshotDraft.id}`)).body.order.lines[0].productName, "Producto Alpha");

const concurrentCreates = await Promise.all(Array.from({ length: 12 }, (_, index) => create([{ productName: `Manual ${index}`, quantity: 1, unitPriceSold: 1000 }])));
assert.equal(new Set(concurrentCreates.map((order) => order.orderNumber)).size, concurrentCreates.length);
assert.ok(concurrentCreates.every((order) => order.scheduledDeliveryDate === "2026-08-20"));

// 22–25: producto manual, historial, rutas, filtros y tablas de entrega separadas.
const manualProductCountBefore = Number((await DB.prepare("SELECT COUNT(*) AS total FROM inventory_movements WHERE order_id=?").bind(paymentOrder.id).first()).total);
assert.equal(manualProductCountBefore, 0);

// Un borrador sin movimientos puede eliminarse físicamente e idempotentemente.
const disposableDraft = await create([{ productName: "Borrador descartable", quantity: 1, unitPriceSold: 1000 }]);
const deleteOperation = op("delete-draft");
const deletedDraft = await call(`/api/orders/${disposableDraft.id}`, {
  method: "DELETE",
  body: JSON.stringify({ operationId: deleteOperation, version: disposableDraft.version }),
});
assert.equal(deletedDraft.response.status, 200, JSON.stringify(deletedDraft.body));
assert.equal(deletedDraft.body.deleted, true);
assert.equal((await call(`/api/orders/${disposableDraft.id}`)).response.status, 404);
const deleteRetry = await call(`/api/orders/${disposableDraft.id}`, {
  method: "DELETE",
  body: JSON.stringify({ operationId: deleteOperation, version: disposableDraft.version }),
});
assert.equal(deleteRetry.response.status, 200);
assert.equal(deleteRetry.body.idempotent, true);
const history = await call(`/api/orders/${primary.id}/history`);
assert.equal(history.response.status, 200);
assert.ok(history.body.statusEvents.length >= 4);
assert.ok(history.body.inventoryMovements.some((movement) => movement.movement_type === "ORDER_RETURN"));
assert.ok(history.body.fulfillments.length >= 1);

const route = await call("/api/delivery-routes", { method: "POST", body: JSON.stringify({ date: "2026-08-21", label: "GAM" }) });
assert.equal(route.response.status, 201, JSON.stringify(route.body));
const assigned = await call(`/api/delivery-routes/${route.body.route.id}/orders`, {
  method: "POST", body: JSON.stringify({ orderId: snapshotDraft.id, position: 1 }),
});
assert.equal(assigned.response.status, 200, JSON.stringify(assigned.body));
assert.equal(assigned.body.order.route.position, 1);
const routeList = await call("/api/delivery-routes?date=2026-08-21");
assert.equal(routeList.body.routes[0].orderCount, 1);
const filtered = await call("/api/orders?date=2026-08-21&status=DRAFT&limit=10&page=1");
assert.equal(filtered.response.status, 200);
assert.ok(filtered.body.orders.some((order) => order.id === concurrentDraft.id));
assert.ok(filtered.body.limit <= 100);

assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM order_operations WHERE status='pending'").first()).total), 0);
assert.ok(Number((await DB.prepare("SELECT COUNT(*) AS total FROM order_fulfillment_lines").first()).total) >= 1);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM products WHERE quantity_available<0").first()).total), 0);

DB.close();
console.log("Orders Phase 1: state machine, inventory deltas, payments, returns, routes, idempotency, concurrency, snapshots, NP numbers, and Costa Rica dates passed");
