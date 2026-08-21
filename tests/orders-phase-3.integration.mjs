import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { LocalD1Database } from "./helpers/local-bindings.mjs";

const DB = new LocalD1Database();
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("ordersPhase3", `${Date.now()}`);
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

let counter = 0;
function op(label) {
  counter += 1;
  return `${label}-${String(counter).padStart(6, "0")}`;
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

async function createOrder(lines, extra = {}) {
  const result = await call("/api/orders", {
    method: "POST",
    body: JSON.stringify({
      operationId: op("phase3-create"),
      customerName: "Cliente Operación Completa",
      phone: `70${String(counter).padStart(6, "0")}`,
      deliveryAddress: "San José centro",
      scheduledDeliveryDate: "2026-09-10",
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

async function action(order, path, body = {}) {
  const result = await call(`/api/orders/${order.id}/${path}`, {
    method: "POST",
    body: JSON.stringify({ operationId: op(`phase3-${path.replaceAll("/", "-")}`), version: order.version, ...body }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.order;
}

function updatePayload(order, lines, extra = {}) {
  return {
    operationId: op("phase3-update"),
    version: order.version,
    orderType: order.orderType,
    customerName: order.customerName,
    phone: order.phoneRaw,
    deliveryAddress: order.deliveryAddress,
    scheduledDeliveryDate: order.scheduledDeliveryDate,
    estimatedArrivalDate: order.estimatedArrivalDate,
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

async function createRoute(date, label) {
  const result = await call("/api/delivery-routes", { method: "POST", body: JSON.stringify({ date, label }) });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.route;
}

async function assign(routeId, order, position) {
  const result = await call(`/api/delivery-routes/${routeId}/orders`, {
    method: "POST",
    body: JSON.stringify({ orderId: order.id, position }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.order;
}

async function specialTransition(order, targetStatus) {
  return action(order, "special-order/transition", { targetStatus });
}

await call("/api/settings");
const alpha = await product("Omega impresión", "P3-OMEGA", 30);
const beta = await product("Magnesio parcial", "P3-MAG", 10);

// Impresión: un pedido, varios, totales, envío, E/S/T, orden de ruta y consolidado.
let cashOrder = await createOrder([{ productId: alpha.id, quantity: 2, unitPriceSold: 5000 }], {
  phone: "7000-1001", expectedPaymentMethod: "CASH", deliveryFee: 1000,
});
let sinpeOrder = await createOrder([{ productName: "Producto manual físico", quantity: 3, unitPriceSold: 2000 }], {
  phone: "7000-1002", expectedPaymentMethod: "SINPE", deliveryFee: 500,
});
const cardOrder = await createOrder([{ productName: "Producto tarjeta", quantity: 1, unitPriceSold: 8000 }], {
  phone: "7000-1003", expectedPaymentMethod: "CARD", deliveryFee: 0,
});
cashOrder = await action(cashOrder, "confirm");
cashOrder = await action(cashOrder, "payments", { amount: 1000, method: "SINPE", reference: "Abono previo" });
cashOrder = await action(cashOrder, "prepare");
sinpeOrder = await action(sinpeOrder, "confirm");
sinpeOrder = await action(sinpeOrder, "prepare");
const printRoute = await createRoute("2026-09-10", "Impresión");
const routedCard = await assign(printRoute.id, cardOrder, 1);
cashOrder = await assign(printRoute.id, cashOrder, 2);
sinpeOrder = await assign(printRoute.id, sinpeOrder, 3);
assert.equal(routedCard.orderNumber, cardOrder.orderNumber);

const printModelResult = await call("/api/orders/print?date=2026-09-10&format=json");
assert.equal(printModelResult.response.status, 200, JSON.stringify(printModelResult.body));
const printModel = printModelResult.body;
assert.equal(printModel.rows.length, 3);
assert.deepEqual(printModel.rows.map((row) => row.phone), ["7000-1003", "7000-1001", "7000-1002"]);
assert.equal(printModel.orderTotal, cardOrder.total + cashOrder.total + sinpeOrder.total);
assert.equal(printModel.shippingTotal, 1500);
assert.equal(printModel.amountToCollectTotal, cardOrder.balance + cashOrder.balance + sinpeOrder.balance);
assert.equal(printModel.rows.find((row) => row.phone === "7000-1001").cash, true);
assert.equal(printModel.rows.find((row) => row.phone === "7000-1002").sinpe, true);
assert.equal(printModel.rows.find((row) => row.phone === "7000-1003").card, true);
assert.ok(printModel.rows.find((row) => row.phone === "7000-1001").products.some((line) => line.replace(/\s/g, "") === "Envío₡1000"));
assert.ok(printModel.productsToLoad.some((line) => line.productId === alpha.id && line.quantity === 2 && !line.manual));
assert.ok(printModel.productsToLoad.some((line) => line.productName === "Producto manual físico" && line.quantity === 3 && line.manual));

// La misma salida crece a varias páginas sin depender de un tamaño fijo.
await Promise.all(Array.from({ length: 48 }, (_, index) => createOrder([{
  productName: `Producto extenso para impresión multipágina ${index + 1}`,
  quantity: 1,
  unitPriceSold: 1000,
}], {
  customerName: `Cliente multipágina ${index + 1}`,
  phone: `71${String(index).padStart(6, "0")}`,
  deliveryAddress: `Dirección extensa número ${index + 1} con referencia operativa para validar salto de fila`,
  scheduledDeliveryDate: "2026-09-11",
  expectedPaymentMethod: index % 3 === 0 ? "CASH" : index % 3 === 1 ? "SINPE" : "CARD",
  deliveryFee: index % 2 ? 500 : 0,
})));
const multiPdf = await call("/api/orders/print?date=2026-09-11");
assert.equal(multiPdf.response.status, 200, JSON.stringify(multiPdf.body));
assert.equal(multiPdf.response.headers.get("content-type"), "application/pdf");
const pdf = await PDFDocument.load(multiPdf.body);
assert.ok(pdf.getPageCount() >= 3, `expected at least 3 pages, received ${pdf.getPageCount()}`);

// Entrega parcial conserva pendientes, no mueve stock y permite completar después.
let partial = await createOrder([
  { productId: alpha.id, quantity: 2, unitPriceSold: 5000 },
  { productId: beta.id, quantity: 1, unitPriceSold: 4000 },
], { phone: "7000-2001", scheduledDeliveryDate: "2026-09-13" });
partial = await action(partial, "confirm");
const stockAfterPartialConfirm = { alpha: await quantity(alpha.id), beta: await quantity(beta.id) };
partial = await action(partial, "prepare");
const partialRoute = await createRoute("2026-09-13", "Entrega parcial");
partial = await assign(partialRoute.id, partial, 1);
const firstFulfillmentBody = {
  operationId: op("phase3-partial"),
  version: partial.version,
  lines: [{ orderLineId: partial.lines[0].id, quantity: 2 }],
  pendingDeliveryDate: "2026-09-14",
};
const firstFulfillment = await call(`/api/orders/${partial.id}/fulfillments`, { method: "POST", body: JSON.stringify(firstFulfillmentBody) });
assert.equal(firstFulfillment.response.status, 200, JSON.stringify(firstFulfillment.body));
partial = firstFulfillment.body.order;
assert.equal(partial.status, "PREPARED");
assert.equal(partial.lines[0].deliveredQuantity, 2);
assert.equal(partial.lines[1].pendingDeliveryQuantity, 1);
assert.equal(partial.scheduledDeliveryDate, "2026-09-14");
assert.equal(partial.routeId, null);
assert.deepEqual({ alpha: await quantity(alpha.id), beta: await quantity(beta.id) }, stockAfterPartialConfirm);
const fulfillmentRetry = await call(`/api/orders/${partial.id}/fulfillments`, { method: "POST", body: JSON.stringify(firstFulfillmentBody) });
assert.equal(fulfillmentRetry.response.status, 200);
assert.equal(fulfillmentRetry.body.idempotent, true);
assert.deepEqual({ alpha: await quantity(alpha.id), beta: await quantity(beta.id) }, stockAfterPartialConfirm);
const pendingLoad = await call("/api/orders/print?date=2026-09-14&format=json");
assert.equal(pendingLoad.response.status, 200, JSON.stringify(pendingLoad.body));
assert.ok(!pendingLoad.body.productsToLoad.some((line) => line.productId === alpha.id), "already delivered units must not return to the load list");
assert.ok(pendingLoad.body.productsToLoad.some((line) => line.productId === beta.id && line.quantity === 1), "only pending units belong in the load list");
partial = await action(partial, "fulfillments", { lines: [{ orderLineId: partial.lines[1].id, quantity: 1 }] });
assert.equal(partial.status, "DELIVERED");
assert.deepEqual({ alpha: await quantity(alpha.id), beta: await quantity(beta.id) }, stockAfterPartialConfirm);

// Devolución con y sin reingreso; reapertura y corrección por delta.
const alphaBeforeReturn = await quantity(alpha.id);
partial = await action(partial, "returns", { reason: "Producto cerrado apto", lines: [{ orderLineId: partial.lines[0].id, quantity: 1, reenterInventory: true }] });
assert.equal(await quantity(alpha.id), alphaBeforeReturn + 1);
const betaBeforeReturn = await quantity(beta.id);
partial = await action(partial, "returns", { reason: "Producto abierto no apto", lines: [{ orderLineId: partial.lines[1].id, quantity: 1, reenterInventory: false }] });
assert.equal(await quantity(beta.id), betaBeforeReturn);
partial = await action(partial, "reopen", { reason: "Corregir cantidad facturada" });
const alphaBeforeCorrection = await quantity(alpha.id);
const corrected = await call(`/api/orders/${partial.id}`, {
  method: "PATCH",
  body: JSON.stringify(updatePayload(partial, [{ ...partial.lines[0], quantity: 1 }, partial.lines[1]])),
});
assert.equal(corrected.response.status, 200, JSON.stringify(corrected.body));
partial = corrected.body.order;
assert.equal(await quantity(alpha.id), alphaBeforeCorrection + 1);
partial = await action(partial, "confirm");
partial = await action(partial, "prepare");
partial = await action(partial, "deliver");
assert.equal(partial.status, "DELIVERED");
assert.equal(await quantity(alpha.id), alphaBeforeCorrection + 1);
const partialHistory = await call(`/api/orders/${partial.id}/history`);
assert.ok(partialHistory.body.events.some((event) => event.event_type === "order.partially_delivered"));
assert.equal(partialHistory.body.returns.length, 2);
assert.ok(partialHistory.body.statusEvents.some((event) => event.to_status === "REOPENED"));

// Resumen y cierre de ruta derivados de estados y ledger, con pendientes advertidos.
const routeDate = "2026-09-15";
const closingRoute = await createRoute(routeDate, "Cierre completo");
let routeDelivered = await createOrder([{ productName: "Entregado ruta", quantity: 1, unitPriceSold: 9000 }], { phone: "7000-3001", scheduledDeliveryDate: routeDate, deliveryFee: 1000 });
routeDelivered = await assign(closingRoute.id, routeDelivered, 1);
routeDelivered = await action(routeDelivered, "confirm");
routeDelivered = await action(routeDelivered, "payments", { amount: 4000, method: "CASH" });
routeDelivered = await action(routeDelivered, "payments", { amount: 2000, method: "SINPE" });
routeDelivered = await action(routeDelivered, "prepare");
routeDelivered = await action(routeDelivered, "fulfillments", { lines: [{ orderLineId: routeDelivered.lines[0].id, quantity: 1 }] });
let routeCancelled = await createOrder([{ productName: "Cancelado ruta", quantity: 1, unitPriceSold: 1000 }], { phone: "7000-3002", scheduledDeliveryDate: routeDate });
routeCancelled = await assign(closingRoute.id, routeCancelled, 2);
routeCancelled = await action(routeCancelled, "cancel", { reason: "Cliente canceló" });
assert.equal(routeCancelled.status, "CANCELLED");
let routeReprogrammed = await createOrder([{ productName: "Reprogramado ruta", quantity: 1, unitPriceSold: 1000 }], { phone: "7000-3003", scheduledDeliveryDate: routeDate });
routeReprogrammed = await assign(closingRoute.id, routeReprogrammed, 3);
routeReprogrammed = await action(routeReprogrammed, "reprogram", { scheduledDeliveryDate: "2026-09-16", reason: "Cliente no estaba" });
assert.equal(routeReprogrammed.scheduledDeliveryDate, "2026-09-16");
let routePending = await createOrder([{ productName: "Pendiente ruta", quantity: 1, unitPriceSold: 2000 }], { phone: "7000-3004", scheduledDeliveryDate: routeDate, deliveryFee: 500 });
routePending = await assign(closingRoute.id, routePending, 4);
const routeSnapshot = await call(`/api/delivery-routes/${closingRoute.id}`);
assert.equal(routeSnapshot.response.status, 200, JSON.stringify(routeSnapshot.body));
assert.deepEqual({
  delivered: routeSnapshot.body.summary.delivered,
  cancelled: routeSnapshot.body.summary.cancelled,
  reprogrammed: routeSnapshot.body.summary.reprogrammed,
  pending: routeSnapshot.body.summary.pending,
}, { delivered: 1, cancelled: 1, reprogrammed: 1, pending: 1 });
assert.equal(routeSnapshot.body.summary.totalDelivered, routeDelivered.total);
assert.equal(routeSnapshot.body.summary.totalCollected, 6000);
assert.equal(routeSnapshot.body.summary.paymentMethods.CASH, 4000);
assert.equal(routeSnapshot.body.summary.paymentMethods.SINPE, 2000);
assert.equal(routeSnapshot.body.summary.shippingTotal, routeDelivered.deliveryFee + routePending.deliveryFee);
const blockedClose = await call(`/api/delivery-routes/${closingRoute.id}/close`, {
  method: "POST", body: JSON.stringify({ operationId: op("phase3-close-blocked"), acknowledgePending: false }),
});
assert.equal(blockedClose.response.status, 409);
assert.equal(blockedClose.body.code, "ROUTE_PENDING_ORDERS");
const closed = await call(`/api/delivery-routes/${closingRoute.id}/close`, {
  method: "POST", body: JSON.stringify({ operationId: op("phase3-close"), acknowledgePending: true }),
});
assert.equal(closed.response.status, 200, JSON.stringify(closed.body));
assert.equal(closed.body.route.status, "CLOSED");

// Encargo iniciado desde No inventario, abonos mixtos, Camino A, misma NP/ruta e impresión por saldo.
const quoteMutation = op("phase3-quote");
const quote = await call("/api/quotes", {
  method: "POST",
  headers: { "x-mutation-id": quoteMutation },
  body: JSON.stringify({ name: "Encargo desde No inventario", code: "P3-SPECIAL-A", purchasePriceUsd: 15, weightLb: .4, mutationId: quoteMutation }),
});
assert.equal(quote.response.status, 201, JSON.stringify(quote.body));
let special = await createOrder([{ productName: quote.body.quote.name, barcode: quote.body.quote.code, quantity: 1, unitPriceSold: 20000 }], {
  orderType: "SPECIAL_ORDER",
  phone: "7000-4001",
  scheduledDeliveryDate: null,
  estimatedArrivalDate: "2026-09-20",
  expectedPaymentMethod: "SINPE",
  deliveryFee: 1000,
});
const specialNumber = special.orderNumber;
assert.equal(special.payments.length, 0);
special = await action(special, "payments", { amount: 5000, method: "SINPE" });
special = await action(special, "payments", { amount: 2000, method: "CASH" });
assert.equal(special.paidTotal, 7000);
special = await specialTransition(special, "ORDERED_FROM_SUPPLIER");
special = await specialTransition(special, "IN_TRANSIT");
special = await specialTransition(special, "RECEIVED_PENDING_RESOLUTION");
const moveMutation = op("phase3-move-quote");
const moved = await call(`/api/quotes/${quote.body.quote.id}/move-to-inventory`, {
  method: "POST",
  headers: { "x-mutation-id": moveMutation },
  body: JSON.stringify({ name: quote.body.quote.name, code: quote.body.quote.code, purchasePriceUsd: 15, weightLb: .4, quantityAvailable: 0, minimumStock: 0, minimumStockEnabled: false, mutationId: moveMutation }),
});
assert.equal(moved.response.status, 201, JSON.stringify(moved.body));
const specialProduct = moved.body.product;
assert.equal(await quantity(specialProduct.id), 0);
special = await action(special, "special-order/receipts", {
  mode: "INVENTORY_NOW",
  lines: [{ orderLineId: special.lines[0].id, productId: specialProduct.id, quantityReceived: 1 }],
});
assert.equal(await quantity(specialProduct.id), 1);
assert.equal(special.specialOrder.status, "RECEIVED_READY");
special = await action(special, "reprogram", { scheduledDeliveryDate: "2026-09-21", reason: "Encargo recibido y listo" });
const specialRoute = await createRoute("2026-09-21", "Encargos");
special = await assign(specialRoute.id, special, 1);
assert.equal(special.orderNumber, specialNumber);
assert.equal(special.specialOrder.status, "ADDED_TO_ROUTE");
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM route_orders WHERE order_id=? AND removed_at IS NULL").bind(special.id).first()).total), 1);
special = await action(special, "confirm");
assert.equal(await quantity(specialProduct.id), 0);
special = await action(special, "prepare");
const specialPrint = await call("/api/orders/print?date=2026-09-21&format=json");
const specialRow = specialPrint.body.rows.find((row) => row.phone === "7000-4001");
assert.ok(specialRow);
assert.equal(specialRow.orderTotal, 21000);
assert.equal(specialRow.paidTotal, 7000);
assert.equal(specialRow.amountToCollect, 14000);
assert.equal(specialRow.sinpe, true);
special = await action(special, "fulfillments", { lines: [{ orderLineId: special.lines[0].id, quantity: 1 }] });
assert.equal(special.status, "DELIVERED");
assert.equal(special.specialOrder.status, "DELIVERED");
assert.equal(special.orderNumber, specialNumber);
const activeSpecial = await call("/api/orders?orderType=SPECIAL_ORDER&active=1&limit=100&page=1");
assert.equal(activeSpecial.body.orders.some((order) => order.id === special.id), false);
const specialHistory = await call(`/api/orders/${special.id}/history`);
assert.ok(specialHistory.body.events.some((event) => event.event_type === "special_order.receipt_resolved"));
assert.ok(specialHistory.body.events.some((event) => event.event_type === "order.delivered"));

// Camino B vincula stock existente sin entrada duplicada y confirma contra el saldo real.
const existingSpecialProduct = await product("Encargo ya ingresado", "P3-SPECIAL-B", 1);
let already = await createOrder([{ productName: "Encargo ya ingresado", quantity: 1, unitPriceSold: 9000 }], {
  orderType: "SPECIAL_ORDER", phone: "7000-4002", scheduledDeliveryDate: null, deliveryFee: 0,
});
already = await specialTransition(already, "ORDERED_FROM_SUPPLIER");
already = await specialTransition(already, "IN_TRANSIT");
already = await specialTransition(already, "RECEIVED_PENDING_RESOLUTION");
already = await action(already, "special-order/receipts", {
  mode: "ALREADY_INVENTORY",
  lines: [{ orderLineId: already.lines[0].id, productId: existingSpecialProduct.id, quantityReceived: 1 }],
});
assert.equal(await quantity(existingSpecialProduct.id), 1);
already = await action(already, "confirm");
assert.equal(already.status, "CONFIRMED");
assert.equal(await quantity(existingSpecialProduct.id), 0);

// Historial general busca en servidor y pagina sin cargar todo.
const searchByNp = await call(`/api/orders?search=${encodeURIComponent(specialNumber)}&limit=5&page=1`);
assert.equal(searchByNp.body.orders[0].id, special.id);
const searchByCustomer = await call("/api/orders?search=Operación%20Completa&limit=5&page=1");
assert.ok(searchByCustomer.body.total > 5);
assert.equal(searchByCustomer.body.limit, 5);
const searchByProduct = await call("/api/orders?search=No%20inventario&orderType=SPECIAL_ORDER&limit=5&page=1");
assert.ok(searchByProduct.body.orders.some((order) => order.id === special.id));

// Contrato de interfaz responsive para impresión, rutas, correcciones, parciales y Encargos.
const [viewSource, printSource, css] = await Promise.all([
  readFile(new URL("../app/orders-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/orders-print.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);
const source = `${viewSource}\n${printSource}`;
for (const label of [
  "Imprimir hoja", "Ruta del día", "Reabrir/Corregir", "Registrar devolución", "Registrar entrega parcial",
  "Ingresar estas unidades al inventario ahora", "Ya fue ingresado mediante Facturas/Inventario", "Agregar a lista de entrega",
  "Productos para cargar", "Cerrar y conservar pendientes",
]) assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
assert.match(css, /@media \(max-width: 620px\)/);
assert.match(css, /\.receipt-mode-picker/);
assert.match(css, /\.route-summary-grid/);

assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM order_operations WHERE status='pending'").first()).total), 0);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM products WHERE quantity_available<0").first()).total), 0);
DB.close();
console.log("Orders Phase 3: printing, multipage layout, route closure, partial fulfillments, corrections, returns, special orders, balances, history, and mobile contract passed");
