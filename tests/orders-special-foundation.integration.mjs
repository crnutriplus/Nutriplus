import assert from "node:assert/strict";
import { LocalD1Database } from "./helpers/local-bindings.mjs";

const DB = new LocalD1Database();
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("orders-special", `${Date.now()}`);
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

let counter = 0;
function op(label) {
  counter += 1;
  return `${label}-${String(counter).padStart(4, "0")}`;
}

async function product(name, code, quantity) {
  const result = await call("/api/products", {
    method: "POST",
    body: JSON.stringify({ name, code, purchasePriceUsd: 10, weightLb: 0.5, quantityAvailable: quantity }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.product;
}

async function quantity(productId) {
  return Number((await DB.prepare("SELECT quantity_available FROM products WHERE id=?").bind(productId).first()).quantity_available);
}

async function createOrder({ lines, orderType = "STANDARD", expectedPaymentMethod = null, extra = {} }) {
  const result = await call("/api/orders", {
    method: "POST",
    body: JSON.stringify({
      operationId: op("create"),
      orderType,
      customerName: "Cliente Encargo",
      phone: "7096-2629",
      scheduledDeliveryDate: orderType === "SPECIAL_ORDER" ? null : "2026-08-25",
      expectedPaymentMethod,
      deliveryFee: 1000,
      source: "MANUAL",
      lines,
      ...extra,
    }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.order;
}

function editablePayload(order, extra = {}) {
  return {
    operationId: op("update"),
    version: order.version,
    orderType: order.orderType,
    customerName: order.customerName,
    phone: order.phoneRaw,
    deliveryAddress: order.deliveryAddress,
    deliveryInstructions: order.deliveryInstructions,
    scheduledDeliveryDate: order.scheduledDeliveryDate,
    estimatedArrivalDate: order.specialOrder?.estimatedArrivalDate,
    expectedPaymentMethod: order.expectedPaymentMethod,
    deliveryFee: order.deliveryFee,
    source: order.source,
    internalNotes: order.internalNotes,
    deliveryNotes: order.deliveryNotes,
    lines: order.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      productName: line.productName,
      quantity: line.quantity,
      unitPriceOriginal: line.unitPriceOriginal,
      unitPriceSold: line.unitPriceSold,
      discountAmount: line.discountAmount,
    })),
    ...extra,
  };
}

async function transition(order, status) {
  const result = await call(`/api/orders/${order.id}/special-order/transition`, {
    method: "POST",
    body: JSON.stringify({ operationId: op(`special-${status.toLowerCase()}`), version: order.version, status }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.order;
}

async function readyForReceipt(order) {
  order = await transition(order, "ORDERED_FROM_SUPPLIER");
  order = await transition(order, "IN_TRANSIT");
  return transition(order, "RECEIVED_PENDING_RESOLUTION");
}

async function resolveReceipt(order, mode, lines, operationId = op("special-receipt")) {
  return call(`/api/orders/${order.id}/special-order/receipts`, {
    method: "POST",
    body: JSON.stringify({ operationId, version: order.version, mode, lines }),
  });
}

await call("/api/settings");

// expected_payment_method es operativo y nunca fabrica ni altera pagos reales.
let expected = await createOrder({
  expectedPaymentMethod: "SINPE",
  lines: [{ productName: "Producto manual esperado", quantity: 1, unitPriceSold: 10000 }],
});
assert.equal(expected.expectedPaymentMethod, "SINPE");
assert.equal(expected.payments.length, 0);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM order_payments WHERE order_id=?").bind(expected.id).first()).total), 0);

const paid = await call(`/api/orders/${expected.id}/payments`, {
  method: "POST",
  body: JSON.stringify({ operationId: op("expected-payment"), version: expected.version, amount: 2000, method: "CASH" }),
});
assert.equal(paid.response.status, 200, JSON.stringify(paid.body));
expected = paid.body.order;
const changedExpected = await call(`/api/orders/${expected.id}`, {
  method: "PATCH",
  body: JSON.stringify(editablePayload(expected, { expectedPaymentMethod: "CARD" })),
});
assert.equal(changedExpected.response.status, 200, JSON.stringify(changedExpected.body));
expected = changedExpected.body.order;
assert.equal(expected.expectedPaymentMethod, "CARD");
assert.equal(expected.paidTotal, 2000);
assert.equal(expected.payments.length, 1);
assert.equal(expected.payments[0].method, "CASH");

// Crear Encargo y avanzar por proveedor no mueve inventario; transiciones inválidas se bloquean.
const receiptProduct = await product("Producto recepción A", "SPECIAL-A", 0);
let special = await createOrder({
  orderType: "SPECIAL_ORDER",
  expectedPaymentMethod: "SINPE",
  extra: { estimatedArrivalDate: "2026-09-10" },
  lines: [{ productName: "Producto por encargo A", quantity: 2, unitPriceSold: 12000 }],
});
assert.equal(special.status, "DRAFT");
assert.equal(special.specialOrder.status, "REQUESTED");
assert.equal(special.specialOrder.estimatedArrivalDate, "2026-09-10");
assert.equal(await quantity(receiptProduct.id), 0);
const invalidTransition = await call(`/api/orders/${special.id}/special-order/transition`, {
  method: "POST",
  body: JSON.stringify({ operationId: op("invalid-special-transition"), version: special.version, status: "IN_TRANSIT" }),
});
assert.equal(invalidTransition.response.status, 409);
assert.equal(invalidTransition.body.code, "SPECIAL_ORDER_INVALID_TRANSITION");
special = await transition(special, "ORDERED_FROM_SUPPLIER");
assert.equal(await quantity(receiptProduct.id), 0);
special = await transition(special, "IN_TRANSIT");
assert.equal(await quantity(receiptProduct.id), 0);
const confirmBeforeReceipt = await call(`/api/orders/${special.id}/confirm`, {
  method: "POST", body: JSON.stringify({ operationId: op("confirm-before-receipt"), version: special.version }),
});
assert.equal(confirmBeforeReceipt.response.status, 409);
assert.equal(confirmBeforeReceipt.body.code, "SPECIAL_ORDER_RECEIPT_UNRESOLVED");
special = await transition(special, "RECEIVED_PENDING_RESOLUTION");
assert.equal(special.specialOrder.status, "RECEIVED_PENDING_RESOLUTION");
assert.equal(await quantity(receiptProduct.id), 0);

// Camino A incrementa exactamente una vez; confirmar descuenta una vez; cancelar restaura una vez.
const receiptOperation = op("receipt-inventory-now");
let resolvedA = await resolveReceipt(special, "INVENTORY_NOW", [{
  orderLineId: special.lines[0].id, productId: receiptProduct.id, quantityReceived: 2,
}], receiptOperation);
assert.equal(resolvedA.response.status, 200, JSON.stringify(resolvedA.body));
special = resolvedA.body.order;
assert.equal(special.specialOrder.status, "RECEIVED_READY");
assert.ok(special.specialOrder.receiptResolvedAt);
assert.equal(special.lines[0].productId, receiptProduct.id);
assert.equal(special.lines[0].receivedQuantity, 2);
assert.equal(await quantity(receiptProduct.id), 2);
const receiptRetry = await resolveReceipt({ ...special, version: special.version - 1 }, "INVENTORY_NOW", [{
  orderLineId: special.lines[0].id, productId: receiptProduct.id, quantityReceived: 2,
}], receiptOperation);
assert.equal(receiptRetry.response.status, 200, JSON.stringify(receiptRetry.body));
assert.equal(receiptRetry.body.idempotent, true);
assert.equal(await quantity(receiptProduct.id), 2);
const confirmAOperation = op("confirm-special-a");
const confirmedA = await call(`/api/orders/${special.id}/confirm`, {
  method: "POST", body: JSON.stringify({ operationId: confirmAOperation, version: special.version }),
});
assert.equal(confirmedA.response.status, 200, JSON.stringify(confirmedA.body));
special = confirmedA.body.order;
assert.equal(await quantity(receiptProduct.id), 0);
const confirmARetry = await call(`/api/orders/${special.id}/confirm`, {
  method: "POST", body: JSON.stringify({ operationId: confirmAOperation, version: special.version - 1 }),
});
assert.equal(confirmARetry.response.status, 200);
assert.equal(confirmARetry.body.idempotent, true);
assert.equal(await quantity(receiptProduct.id), 0);
const cancelledA = await call(`/api/orders/${special.id}/cancel`, {
  method: "POST", body: JSON.stringify({ operationId: op("cancel-special-a"), version: special.version, reason: "Cliente canceló el Encargo" }),
});
assert.equal(cancelledA.response.status, 200, JSON.stringify(cancelledA.body));
assert.equal(cancelledA.body.order.specialOrder.status, "CANCELLED");
assert.equal(await quantity(receiptProduct.id), 2);

// Cancelar antes de confirmar no devuelve stock inexistente.
const untouchedProduct = await product("Producto encargo sin confirmar", "SPECIAL-NO-CONFIRM", 4);
const unconfirmedSpecial = await createOrder({
  orderType: "SPECIAL_ORDER",
  lines: [{ productId: untouchedProduct.id, quantity: 1, unitPriceSold: 5000 }],
});
const beforeUnconfirmedCancel = await quantity(untouchedProduct.id);
const cancelledUnconfirmed = await call(`/api/orders/${unconfirmedSpecial.id}/cancel`, {
  method: "POST", body: JSON.stringify({ operationId: op("cancel-unconfirmed-special"), version: unconfirmedSpecial.version, reason: "Proveedor sin disponibilidad" }),
});
assert.equal(cancelledUnconfirmed.response.status, 200, JSON.stringify(cancelledUnconfirmed.body));
assert.equal(await quantity(untouchedProduct.id), beforeUnconfirmedCancel);

// Camino B solo vincula; exige producto existente y confirmar vuelve a validar stock real.
const missingAlreadyProduct = await product("Producto no ingresado todavía", "SPECIAL-B-ZERO", 0);
let missingAlready = await createOrder({
  orderType: "SPECIAL_ORDER",
  lines: [{ productName: "Producto físico sin entrada registrada", quantity: 1, unitPriceSold: 8000 }],
});
missingAlready = await readyForReceipt(missingAlready);
const missingAlreadyResolution = await resolveReceipt(missingAlready, "ALREADY_INVENTORY", [{
  orderLineId: missingAlready.lines[0].id, productId: missingAlreadyProduct.id, quantityReceived: 1,
}]);
assert.equal(missingAlreadyResolution.response.status, 409, JSON.stringify(missingAlreadyResolution.body));
assert.equal(missingAlreadyResolution.body.code, "SPECIAL_ORDER_ALREADY_INVENTORY_SHORTAGE");
assert.equal(await quantity(missingAlreadyProduct.id), 0);

const alreadyProduct = await product("Producto ya ingresado", "SPECIAL-B", 1);
let already = await createOrder({
  orderType: "SPECIAL_ORDER",
  lines: [{ productName: "Producto ya ingresado desde factura", quantity: 1, unitPriceSold: 9000 }],
});
already = await readyForReceipt(already);
const beforeInvalidLink = await quantity(alreadyProduct.id);
const invalidLink = await resolveReceipt(already, "ALREADY_INVENTORY", [{
  orderLineId: already.lines[0].id, productId: 2147483000, quantityReceived: 1,
}]);
assert.equal(invalidLink.response.status, 409);
assert.equal(invalidLink.body.code, "ORDER_PRODUCT_NOT_FOUND");
assert.equal(await quantity(alreadyProduct.id), beforeInvalidLink);
const resolvedB = await resolveReceipt(already, "ALREADY_INVENTORY", [{
  orderLineId: already.lines[0].id, productId: alreadyProduct.id, quantityReceived: 1,
}]);
assert.equal(resolvedB.response.status, 200, JSON.stringify(resolvedB.body));
already = resolvedB.body.order;
assert.equal(await quantity(alreadyProduct.id), 1);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM inventory_movements WHERE order_id=? AND movement_type='SPECIAL_ORDER_RECEIPT'").bind(already.id).first()).total), 0);
const competing = await createOrder({ lines: [{ productId: alreadyProduct.id, quantity: 1, unitPriceSold: 1000 }] });
const competingConfirm = await call(`/api/orders/${competing.id}/confirm`, {
  method: "POST", body: JSON.stringify({ operationId: op("consume-already-stock"), version: competing.version }),
});
assert.equal(competingConfirm.response.status, 200, JSON.stringify(competingConfirm.body));
assert.equal(await quantity(alreadyProduct.id), 0);
const revalidated = await call(`/api/orders/${already.id}/confirm`, {
  method: "POST", body: JSON.stringify({ operationId: op("confirm-already-no-stock"), version: already.version }),
});
assert.equal(revalidated.response.status, 409);
assert.equal(revalidated.body.code, "ORDER_INSUFFICIENT_STOCK");
assert.equal(await quantity(alreadyProduct.id), 0);

// Dos resoluciones concurrentes no pueden duplicar la unidad física.
const raceProduct = await product("Producto recepción concurrente", "SPECIAL-RACE", 0);
let race = await createOrder({
  orderType: "SPECIAL_ORDER",
  lines: [{ productName: "Producto concurrente", quantity: 1, unitPriceSold: 7000 }],
});
race = await readyForReceipt(race);
const racePayload = (operationId) => ({
  method: "POST",
  body: JSON.stringify({
    operationId,
    version: race.version,
    mode: "INVENTORY_NOW",
    lines: [{ orderLineId: race.lines[0].id, productId: raceProduct.id, quantityReceived: 1 }],
  }),
});
const raceResults = await Promise.all([
  call(`/api/orders/${race.id}/special-order/receipts`, racePayload(op("receipt-race-a"))),
  call(`/api/orders/${race.id}/special-order/receipts`, racePayload(op("receipt-race-b"))),
]);
assert.deepEqual(raceResults.map((result) => result.response.status).sort(), [200, 409]);
assert.equal(await quantity(raceProduct.id), 1);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM special_order_receipts WHERE order_id=?").bind(race.id).first()).total), 1);

// La estructura admite recepción parcial sin afirmar que llegó todo.
const partialProduct = await product("Producto recepción parcial", "SPECIAL-PARTIAL", 0);
let partial = await createOrder({
  orderType: "SPECIAL_ORDER",
  lines: [{ productName: "Producto parcial", quantity: 3, unitPriceSold: 6000 }],
});
partial = await readyForReceipt(partial);
let partialResult = await resolveReceipt(partial, "INVENTORY_NOW", [{
  orderLineId: partial.lines[0].id, productId: partialProduct.id, quantityReceived: 2,
}]);
assert.equal(partialResult.response.status, 200, JSON.stringify(partialResult.body));
partial = partialResult.body.order;
assert.equal(partial.specialOrder.status, "PARTIALLY_RECEIVED");
assert.equal(partial.specialOrder.receiptResolvedAt, null);
assert.equal(partial.lines[0].receivedQuantity, 2);
assert.equal(partial.lines[0].pendingReceiptQuantity, 1);
assert.equal(await quantity(partialProduct.id), 2);
partialResult = await resolveReceipt(partial, "INVENTORY_NOW", [{
  orderLineId: partial.lines[0].id, productId: partialProduct.id, quantityReceived: 1,
}]);
assert.equal(partialResult.response.status, 200, JSON.stringify(partialResult.body));
partial = partialResult.body.order;
assert.equal(partial.specialOrder.status, "RECEIVED_READY");
assert.ok(partial.specialOrder.receiptResolvedAt);
assert.equal(partial.lines[0].receivedQuantity, 3);
assert.equal(partial.lines[0].pendingReceiptQuantity, 0);
assert.equal(await quantity(partialProduct.id), 3);

assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM products WHERE quantity_available<0").first()).total), 0);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM order_operations WHERE status='pending'").first()).total), 0);

DB.close();
console.log("Orders special foundation: expected payment, normalized special-order states, both receipt paths, partial receipts, idempotency, stock restoration, and concurrency passed");
