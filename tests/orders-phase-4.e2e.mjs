import assert from "node:assert/strict";
import { LocalD1Database } from "./helpers/local-bindings.mjs";

const DB = new LocalD1Database();
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("ordersPhase4", `${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
const env = {
  DB,
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  IMAGES: { input() { throw new Error("Images are not used in order tests."); } },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function call(path, init = {}) {
  const response = await worker.fetch(new Request(`http://local.test${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) },
  }), env, ctx);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : new Uint8Array(await response.arrayBuffer());
  return { response, body };
}

let sequence = 0;
function operationId(label) {
  sequence += 1;
  return `phase4-${label}-${String(sequence).padStart(6, "0")}`;
}

async function createProduct(name, code, quantityAvailable) {
  const result = await call("/api/products", {
    method: "POST",
    body: JSON.stringify({ name, code, purchasePriceUsd: 12, weightLb: 0.5, quantityAvailable }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.product;
}

async function stock(productId) {
  return Number((await DB.prepare("SELECT quantity_available FROM products WHERE id=?").bind(productId).first()).quantity_available);
}

async function createOrder(lines, extra = {}) {
  const result = await call("/api/orders", {
    method: "POST",
    body: JSON.stringify({
      operationId: operationId("create"),
      customerName: "Cliente E2E",
      phone: `88${String(sequence).padStart(6, "0")}`,
      deliveryAddress: "San José, Costa Rica",
      scheduledDeliveryDate: "2026-10-01",
      expectedPaymentMethod: "CASH",
      deliveryFee: 0,
      source: "MANUAL",
      lines,
      ...extra,
    }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.order;
}

async function mutate(order, path, body = {}) {
  const result = await call(`/api/orders/${order.id}/${path}`, {
    method: "POST",
    body: JSON.stringify({ operationId: operationId(path.replaceAll("/", "-")), version: order.version, ...body }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.order;
}

function updatePayload(order, quantity) {
  return {
    operationId: operationId("update"),
    version: order.version,
    orderType: order.orderType,
    customerName: order.customerName,
    phone: order.phoneRaw,
    deliveryAddress: order.deliveryAddress,
    scheduledDeliveryDate: order.scheduledDeliveryDate,
    expectedPaymentMethod: order.expectedPaymentMethod,
    deliveryFee: order.deliveryFee,
    source: order.source,
    lines: order.lines.map((line, index) => ({
      id: line.id,
      productId: line.productId,
      productName: line.productName,
      presentation: line.presentation,
      barcode: line.barcode,
      quantity: index === 0 ? quantity : line.quantity,
      unitPriceOriginal: line.unitPriceOriginal,
      unitPriceSold: line.unitPriceSold,
      discountAmount: line.discountAmount,
    })),
  };
}

async function updateQuantity(order, quantity) {
  const result = await call(`/api/orders/${order.id}`, { method: "PATCH", body: JSON.stringify(updatePayload(order, quantity)) });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.order;
}

async function createRoute(date, label) {
  const result = await call("/api/delivery-routes", { method: "POST", body: JSON.stringify({ date, label }) });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.route;
}

async function assignRoute(routeId, order, position) {
  const result = await call(`/api/delivery-routes/${routeId}/orders`, {
    method: "POST",
    body: JSON.stringify({ orderId: order.id, position }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.order;
}

await call("/api/settings");

// Escenario principal: 10 → 7 → 5, pagos, entrega, corrección 5 → 4 y devolución apta.
const mainProduct = await createProduct("Producto E2E diez unidades", "P4-MAIN-10", 10);
let mainOrder = await createOrder([{ productId: mainProduct.id, quantity: 3, unitPriceSold: 1000 }], {
  customerName: "Cliente flujo completo",
  phone: "8800-4001",
});
const mainNumber = mainOrder.orderNumber;
assert.equal(mainOrder.status, "DRAFT");
assert.equal(await stock(mainProduct.id), 10);
mainOrder = await mutate(mainOrder, "confirm");
assert.equal(await stock(mainProduct.id), 7);
mainOrder = await updateQuantity(mainOrder, 5);
assert.equal(mainOrder.lines[0].quantity, 5);
assert.equal(await stock(mainProduct.id), 5);
mainOrder = await mutate(mainOrder, "payments", { amount: 2000, method: "SINPE", reference: "Abono inicial E2E" });
assert.equal(mainOrder.paymentStatus, "PARTIAL");
assert.equal(mainOrder.balance, 3000);
mainOrder = await mutate(mainOrder, "prepare");
mainOrder = await mutate(mainOrder, "payments", { amount: 3000, method: "CASH", reference: "Cierre E2E" });
assert.equal(mainOrder.balance, 0);
assert.equal(mainOrder.paymentStatus, "PAID");
mainOrder = await mutate(mainOrder, "deliver");
assert.equal(mainOrder.status, "DELIVERED");
assert.equal(await stock(mainProduct.id), 5);
mainOrder = await mutate(mainOrder, "reopen", { reason: "Corregir una unidad cobrada de más" });
mainOrder = await updateQuantity(mainOrder, 4);
assert.equal(await stock(mainProduct.id), 6);
mainOrder = await mutate(mainOrder, "confirm");
mainOrder = await mutate(mainOrder, "prepare");
mainOrder = await mutate(mainOrder, "deliver");
assert.equal(mainOrder.status, "DELIVERED");
assert.equal(await stock(mainProduct.id), 6);
mainOrder = await mutate(mainOrder, "returns", {
  reason: "Unidad cerrada apta para reingreso",
  lines: [{ orderLineId: mainOrder.lines[0].id, quantity: 1, reenterInventory: true }],
});
assert.equal(await stock(mainProduct.id), 7);
assert.equal(mainOrder.orderNumber, mainNumber);
const mainHistory = await call(`/api/orders/${mainOrder.id}/history`);
assert.equal(mainHistory.response.status, 200, JSON.stringify(mainHistory.body));
assert.equal(mainHistory.body.payments.length, 2);
assert.equal(mainHistory.body.returns.length, 1);
assert.ok(mainHistory.body.fulfillments.length >= 2);
assert.ok(mainHistory.body.events.some((event) => event.event_type === "order.reopened"));
assert.ok(mainHistory.body.inventoryMovements.some((movement) => movement.movement_type === "ORDER_EDIT_INCREASE"));
assert.ok(mainHistory.body.inventoryMovements.some((movement) => movement.movement_type === "ORDER_EDIT_DECREASE"));
assert.ok(mainHistory.body.inventoryMovements.some((movement) => movement.movement_type === "ORDER_RETURN"));

// Dos confirmaciones concurrentes compiten por una sola unidad; únicamente una puede ganar.
const scarceProduct = await createProduct("Producto E2E última unidad", "P4-LAST-1", 1);
const contenderA = await createOrder([{ productId: scarceProduct.id, quantity: 1, unitPriceSold: 2500 }], { phone: "8800-4101" });
const contenderB = await createOrder([{ productId: scarceProduct.id, quantity: 1, unitPriceSold: 2500 }], { phone: "8800-4102" });
const confirmations = await Promise.all([contenderA, contenderB].map((order, index) => call(`/api/orders/${order.id}/confirm`, {
  method: "POST",
  body: JSON.stringify({ operationId: operationId(`race-${index}`), version: order.version }),
})));
assert.equal(confirmations.filter((result) => result.response.status === 200).length, 1, confirmations.map((result) => JSON.stringify(result.body)).join("\n"));
assert.equal(confirmations.filter((result) => result.response.status === 409).length, 1, confirmations.map((result) => result.response.status).join(","));
assert.equal(await stock(scarceProduct.id), 0);
const raceOrders = await Promise.all([contenderA, contenderB].map((order) => call(`/api/orders/${order.id}`)));
assert.deepEqual(raceOrders.map((result) => result.body.order.status).sort(), ["CONFIRMED", "DRAFT"]);

// Encargo E2E: abono, proveedor, recepción trazable, ruta, impresión y entrega bajo el mismo NP.
const specialProduct = await createProduct("Producto E2E Encargo", "P4-SPECIAL", 0);
let specialOrder = await createOrder([{ productName: "Producto E2E Encargo", quantity: 2, unitPriceSold: 5000 }], {
  orderType: "SPECIAL_ORDER",
  customerName: "Cliente Encargo E2E",
  phone: "8800-4201",
  scheduledDeliveryDate: "2026-10-03",
  estimatedArrivalDate: "2026-09-30",
  expectedPaymentMethod: "SINPE",
  deliveryFee: 1000,
});
const specialNumber = specialOrder.orderNumber;
specialOrder = await mutate(specialOrder, "payments", { amount: 2000, method: "SINPE", reference: "Abono Encargo E2E" });
assert.equal(specialOrder.balance, 9000);
specialOrder = await mutate(specialOrder, "special-order/transition", { targetStatus: "ORDERED_FROM_SUPPLIER" });
specialOrder = await mutate(specialOrder, "special-order/transition", { targetStatus: "IN_TRANSIT" });
specialOrder = await mutate(specialOrder, "special-order/transition", { targetStatus: "RECEIVED_PENDING_RESOLUTION" });
assert.equal(await stock(specialProduct.id), 0);
specialOrder = await mutate(specialOrder, "special-order/receipts", {
  mode: "INVENTORY_NOW",
  lines: [{ orderLineId: specialOrder.lines[0].id, productId: specialProduct.id, quantityReceived: 2 }],
});
assert.equal(specialOrder.specialOrder.status, "RECEIVED_READY");
assert.equal(await stock(specialProduct.id), 2);
const specialRoute = await createRoute("2026-10-03", "Encargo E2E");
specialOrder = await assignRoute(specialRoute.id, specialOrder, 1);
specialOrder = await assignRoute(specialRoute.id, specialOrder, 1);
assert.equal(specialOrder.specialOrder.status, "ADDED_TO_ROUTE");
const activeMemberships = await DB.prepare("SELECT COUNT(*) AS total FROM route_orders WHERE order_id=? AND removed_at IS NULL").bind(specialOrder.id).first();
assert.equal(Number(activeMemberships.total), 1);
specialOrder = await mutate(specialOrder, "confirm");
assert.equal(await stock(specialProduct.id), 0);
const specialPrint = await call("/api/orders/print?date=2026-10-03&format=json");
assert.equal(specialPrint.response.status, 200, JSON.stringify(specialPrint.body));
const specialPrintRow = specialPrint.body.rows.find((row) => row.phone === "8800-4201");
assert.ok(specialPrintRow);
assert.equal(specialPrintRow.amountToCollect, 9000);
assert.equal(specialPrintRow.sinpe, true);
specialOrder = await mutate(specialOrder, "prepare");
specialOrder = await mutate(specialOrder, "deliver");
assert.equal(specialOrder.status, "DELIVERED");
assert.equal(specialOrder.specialOrder.status, "DELIVERED");
assert.equal(specialOrder.orderNumber, specialNumber);
assert.equal(specialOrder.payments.length, 1);
assert.equal(specialOrder.paidTotal, 2000);
assert.equal(specialOrder.balance, 9000);
assert.equal(await stock(specialProduct.id), 0);
const specialHistory = await call(`/api/orders/${specialOrder.id}/history`);
assert.equal(specialHistory.response.status, 200, JSON.stringify(specialHistory.body));
assert.equal(specialHistory.body.payments.length, 1);
assert.equal(specialHistory.body.fulfillments.length, 1);
assert.ok(specialHistory.body.events.some((event) => event.event_type === "special_order.receipt_resolved"));
assert.ok(specialHistory.body.inventoryMovements.some((movement) => movement.movement_type === "SPECIAL_ORDER_RECEIPT" && Number(movement.quantity_change) === 2));
assert.ok(specialHistory.body.inventoryMovements.some((movement) => movement.movement_type === "ORDER_CONFIRM" && Number(movement.quantity_change) === -2));
const specialActive = await call("/api/orders?orderType=SPECIAL_ORDER&active=1&limit=100");
assert.equal(specialActive.response.status, 200, JSON.stringify(specialActive.body));
assert.ok(!specialActive.body.orders.some((order) => order.id === specialOrder.id));

console.log("Orders Phase 4 E2E: stock deltas, full payment, correction, return, last-unit concurrency, and complete special-order flow passed");
