import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import { LocalD1Database } from "./helpers/local-bindings.mjs";

const DB = new LocalD1Database();
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("finance", `${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
const env = {
  DB,
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  IMAGES: { input() { throw new Error("Images are not used in finance tests."); } },
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
const FINANCE_TEST_FROM = "2026-01-01";
const FINANCE_TEST_TO = "2099-12-31";
function op(label) {
  sequence += 1;
  return `finance-${label}-${String(sequence).padStart(6, "0")}`;
}

async function product(name, code, quantity = 50) {
  const result = await call("/api/products", {
    method: "POST",
    body: JSON.stringify({ name, code, purchasePriceUsd: 10, weightLb: 0.5, quantityAvailable: quantity }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.product;
}

async function createOrder(item, extra = {}) {
  const result = await call("/api/orders", {
    method: "POST",
    body: JSON.stringify({
      operationId: op("create"),
      customerName: extra.customerName || "Cliente Finanzas",
      phone: extra.phone || `88${String(sequence).padStart(6, "0")}`,
      deliveryAddress: "San José centro",
      scheduledDeliveryDate: extra.scheduledDeliveryDate || "2026-08-29",
      expectedPaymentMethod: extra.expectedPaymentMethod || "SINPE",
      deliveryFee: extra.deliveryFee || 0,
      source: "MANUAL",
      lines: [{ productId: item.id, quantity: extra.quantity || 1, unitPriceSold: extra.unitPriceSold, discountAmount: extra.discountAmount || 0 }],
    }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.order;
}

async function action(order, path, body = {}, operation = op(path.replaceAll("/", "-"))) {
  const result = await call(`/api/orders/${order.id}/${path}`, {
    method: "POST",
    body: JSON.stringify({ operationId: operation, version: order.version, ...body }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function snapshot() {
  const result = await call(`/api/finance?from=${FINANCE_TEST_FROM}&to=${FINANCE_TEST_TO}`);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body;
}

await call("/api/settings");
const catalogProduct = await product("Omega histórico Finanzas", "FIN-OMEGA");

// Caja y venta son hechos distintos: un abono previo entra a Caja, pero el pedido no es venta hasta DELIVERED.
let paidOrder = await createOrder(catalogProduct, { unitPriceSold: 20000, phone: "8800-0001", scheduledDeliveryDate: "2026-08-27" });
DB.sqlite.prepare("UPDATE order_lines SET historical_cost_snapshot=12000 WHERE order_id=?").run(paidOrder.id);
paidOrder = (await action(paidOrder, "payments", { amount: 5000, method: "SINPE" })).order;
let finance = await snapshot();
assert.equal(finance.metrics.sales, 0);
assert.equal(finance.cash.incoming, 5000);
assert.equal(finance.receivables.length, 0);

paidOrder = (await action(paidOrder, "confirm")).order;
paidOrder = (await action(paidOrder, "prepare")).order;
const deliveryOperation = op("deliver-idempotent");
const deliveryPayload = JSON.stringify({ operationId: deliveryOperation, version: paidOrder.version });
const [deliveryOne, deliveryTwo] = await Promise.all([
  call(`/api/orders/${paidOrder.id}/deliver`, { method: "POST", body: deliveryPayload }),
  call(`/api/orders/${paidOrder.id}/deliver`, { method: "POST", body: deliveryPayload }),
]);
assert.deepEqual([deliveryOne.response.status, deliveryTwo.response.status], [200, 200]);
paidOrder = deliveryOne.body.order;
assert.equal(Number(DB.sqlite.prepare("SELECT COUNT(*) AS total FROM finance_sales WHERE order_id=? AND status='RECOGNIZED'").get(paidOrder.id).total), 1);
assert.equal(Number(DB.sqlite.prepare("SELECT COUNT(*) AS total FROM order_fulfillments WHERE order_id=?").get(paidOrder.id).total), 1);

finance = await snapshot();
assert.equal(finance.metrics.sales, 20000);
assert.equal(finance.metrics.cogs, 12000);
assert.equal(finance.metrics.grossProfit, 8000);
assert.equal(finance.cash.incoming, 5000);
assert.equal(finance.receivables.find((item) => item.orderId === paidOrder.id).balance, 15000);
paidOrder = (await action(paidOrder, "payments", { amount: 15000, method: "CASH" })).order;
finance = await snapshot();
assert.equal(finance.cash.incoming, 20000);
assert.ok(!finance.receivables.some((item) => item.orderId === paidOrder.id));

// Descuento y envío permanecen separados; la rentabilidad usa el costo histórico de la entrega.
let discounted = await createOrder(catalogProduct, { unitPriceSold: 20000, discountAmount: 2000, deliveryFee: 1000, phone: "8800-0002" });
DB.sqlite.prepare("UPDATE order_lines SET historical_cost_snapshot=10000 WHERE order_id=?").run(discounted.id);
discounted = (await action(discounted, "confirm")).order;
const routeId = discounted.routeId;
discounted = (await action(discounted, "prepare")).order;
const concurrentOperation = op("discount-deliver");
const concurrentBody = JSON.stringify({ operationId: concurrentOperation, version: discounted.version });
const concurrent = await Promise.all([
  call(`/api/orders/${discounted.id}/deliver`, { method: "POST", body: concurrentBody }),
  call(`/api/orders/${discounted.id}/deliver`, { method: "POST", body: concurrentBody }),
]);
assert.equal(concurrent.filter((result) => result.response.status === 200).length, 2);
discounted = concurrent[0].body.order;
finance = await snapshot();
const discountedSale = finance.sales.find((sale) => sale.orderId === discounted.id);
assert.deepEqual({ gross: discountedSale.productGross, discount: discountedSale.discount, net: discountedSale.productNet, delivery: discountedSale.deliveryIncome, total: discountedSale.totalIncome, cogs: discountedSale.cogs, profit: discountedSale.grossProfit }, {
  gross: 20000, discount: 2000, net: 18000, delivery: 1000, total: 19000, cogs: 10000, profit: 8000,
});

// Un pedido preparado pero no entregado no aparece en ventas ni en rentabilidad.
let pending = await createOrder(catalogProduct, { unitPriceSold: 30000, phone: "8800-0003" });
DB.sqlite.prepare("UPDATE order_lines SET historical_cost_snapshot=5000 WHERE order_id=?").run(pending.id);
pending = (await action(pending, "confirm")).order;
pending = (await action(pending, "prepare")).order;
finance = await snapshot();
assert.ok(!finance.sales.some((sale) => sale.orderId === pending.id));
assert.ok(!finance.profitability.orders.some((sale) => sale.orderId === pending.id));

// Venta por debajo del costo: resultado negativo sin sustituir el snapshot por costo actual.
let lossOrder = await createOrder(catalogProduct, { unitPriceSold: 5000, phone: "8800-0004", scheduledDeliveryDate: "2026-08-28" });
DB.sqlite.prepare("UPDATE order_lines SET historical_cost_snapshot=7000 WHERE order_id=?").run(lossOrder.id);
lossOrder = (await action(lossOrder, "confirm")).order;
lossOrder = (await action(lossOrder, "prepare")).order;
lossOrder = (await action(lossOrder, "deliver")).order;
finance = await snapshot();
assert.equal(finance.sales.find((sale) => sale.orderId === lossOrder.id).grossProfit, -2000);
assert.equal(finance.profitability.products.find((item) => item.productId === catalogProduct.id).cogs, 29000);

// Gastos: doble submit, posible duplicado, ruta, personal excluido y reversa append-only.
const operatingBody = {
  operationId: op("expense-operating"), date: "2026-08-29", category: "FUEL", description: "Combustible operación",
  originalAmountMinor: 3000, currency: "CRC", paymentMethod: "CASH",
};
const [expenseOne, expenseRetry] = await Promise.all([
  call("/api/finance/expenses", { method: "POST", body: JSON.stringify(operatingBody) }),
  call("/api/finance/expenses", { method: "POST", body: JSON.stringify(operatingBody) }),
]);
assert.deepEqual([expenseOne.response.status, expenseRetry.response.status], [200, 200]);
assert.equal(Number(DB.sqlite.prepare("SELECT COUNT(*) AS total FROM finance_expenses WHERE idempotency_key=?").get(operatingBody.operationId).total), 1);
const duplicate = await call("/api/finance/expenses", { method: "POST", body: JSON.stringify({ ...operatingBody, operationId: op("expense-duplicate") }) });
assert.equal(duplicate.response.status, 409);
assert.equal(duplicate.body.code, "FINANCE_POSSIBLE_DUPLICATE");
const routeExpense = await call("/api/finance/expenses", { method: "POST", body: JSON.stringify({
  operationId: op("route-expense"), date: "2026-08-29", category: "TOLLS", description: "Peajes ruta entregada",
  originalAmountMinor: 500, currency: "CRC", paymentMethod: "CASH", routeId, orderId: discounted.id,
}) });
assert.equal(routeExpense.response.status, 200, JSON.stringify(routeExpense.body));
const personal = await call("/api/finance/expenses", { method: "POST", body: JSON.stringify({
  operationId: op("personal-expense"), date: "2026-08-29", category: "OTHER", description: "Compra personal excluida",
  originalAmountMinor: 1000, currency: "CRC", paymentMethod: "CASH", personal: true,
}) });
assert.equal(personal.response.status, 200, JSON.stringify(personal.body));
finance = await snapshot();
assert.equal(finance.metrics.operatingExpenses, 3500);
assert.equal(finance.cash.outgoing, 3500);
assert.equal(finance.profitability.routes.find((route) => route.routeId === routeId).expenses, 500);
assert.equal(finance.profitability.routes.find((route) => route.routeId === routeId).result, 8500);
assert.equal(finance.profitability.orders.find((order) => order.orderId === discounted.id).directExpenses, 500);
assert.equal(finance.profitability.orders.find((order) => order.orderId === discounted.id).result, 8500);

const reversed = await call(`/api/finance/expenses/${expenseOne.body.expense.id}/reverse`, { method: "POST", body: JSON.stringify({ operationId: op("expense-reversal"), reason: "Registro corregido" }) });
assert.equal(reversed.response.status, 200, JSON.stringify(reversed.body));
const reversedAgain = await call(`/api/finance/expenses/${expenseOne.body.expense.id}/reverse`, { method: "POST", body: JSON.stringify({ operationId: op("expense-reversal-retry"), reason: "Registro corregido" }) });
assert.equal(reversedAgain.response.status, 200, JSON.stringify(reversedAgain.body));
assert.equal(Number(DB.sqlite.prepare("SELECT COUNT(*) AS total FROM finance_expenses WHERE reverses_expense_id=?").get(expenseOne.body.expense.id).total), 1);
finance = await snapshot();
assert.equal(finance.metrics.operatingExpenses, 500);

for (const amount of ["30000", "30000.01", "29999.01"]) {
  const exact = await call("/api/finance/expenses", { method: "POST", body: JSON.stringify({
    operationId: op(`exact-${amount.replace(".", "-")}`), date: "2026-08-28", category: "OTHER", description: `Monto exacto ${amount}`,
    amount, currency: "CRC", paymentMethod: "CASH", personal: true,
  }) });
  assert.equal(exact.response.status, 200, JSON.stringify(exact.body));
  assert.equal(exact.body.expense.exactOriginalAmount, Number(amount));
}

// Factura confirmada solo se vuelve salida de caja mediante evidencia explícita; no duplica COGS.
DB.sqlite.prepare(`INSERT INTO inventory_documents (
  id,file_fingerprint,file_name,mime_types_json,provider,page_count,file_count,processing_mode,analysis_status,
  field_evidence_json,status,warnings_json,confirmed_at,confirmed_by
) VALUES ('invoice-finance-1','fingerprint-finance-1','factura.pdf','["application/pdf"]','Proveedor prueba',1,1,'manual','not_requested','{}','completed','[]','2026-08-29T10:00:00.000Z','owner')`).run();
const unconfirmedCash = await call("/api/finance/expenses", { method: "POST", body: JSON.stringify({
  operationId: op("invoice-unconfirmed"), date: "2026-08-29", category: "INVENTORY_PURCHASE", description: "Factura inventario pagada",
  originalAmountMinor: 100000, currency: "CRC", paymentMethod: "SINPE", invoiceId: "invoice-finance-1", paidConfirmed: false,
}) });
assert.equal(unconfirmedCash.response.status, 409);
const invoiceExpense = await call("/api/finance/expenses", { method: "POST", body: JSON.stringify({
  operationId: op("invoice-paid"), date: "2026-08-29", category: "INVENTORY_PURCHASE", description: "Factura inventario pagada",
  originalAmountMinor: 100000, currency: "CRC", paymentMethod: "SINPE", invoiceId: "invoice-finance-1", paidConfirmed: true,
}) });
assert.equal(invoiceExpense.response.status, 200, JSON.stringify(invoiceExpense.body));
const invoiceRetry = await call("/api/finance/expenses", { method: "POST", body: JSON.stringify({
  operationId: op("invoice-paid-retry"), date: "2026-08-29", category: "INVENTORY_PURCHASE", description: "Factura inventario pagada",
  originalAmountMinor: 100000, currency: "CRC", paymentMethod: "SINPE", invoiceId: "invoice-finance-1", paidConfirmed: true,
}) });
assert.equal(invoiceRetry.response.status, 200);
assert.equal(invoiceRetry.body.idempotent, true);
finance = await snapshot();
assert.equal(finance.metrics.operatingExpenses, 500, "inventory purchases must not be counted again beyond historical COGS");
assert.equal(finance.cash.outgoing, 100500);

// Plantillas no generan gastos solas y presupuestos muestran gasto real.
const recurring = await call("/api/finance/recurring", { method: "POST", body: JSON.stringify({
  name: "Software mensual", category: "SOFTWARE", amountCrc: 1200, paymentMethod: "CARD", frequency: "MONTHLY", nextDueDate: "2026-08-29",
}) });
assert.equal(recurring.response.status, 200, JSON.stringify(recurring.body));
finance = await snapshot();
assert.ok(!finance.expenses.some((item) => item.sourceType === "RECURRING_TEMPLATE"));
const generated = await call(`/api/finance/recurring/${recurring.body.templateId}/generate`, { method: "POST", body: JSON.stringify({ operationId: op("recurring-generate"), date: "2026-08-29" }) });
assert.equal(generated.response.status, 200, JSON.stringify(generated.body));
const budget = await call("/api/finance/budgets", { method: "POST", body: JSON.stringify({ operationId: op("budget"), category: "TOLLS", yearMonth: "2026-08", amountCrc: 10000 }) });
assert.equal(budget.response.status, 200, JSON.stringify(budget.body));
finance = await snapshot();
assert.equal(finance.budgets.find((item) => item.category === "TOLLS").spent, 500);
assert.equal(finance.metrics.operatingExpenses, 1700);
assert.equal(finance.metrics.netProfit, 13300);
assert.equal(finance.cash.outgoing, 101700);
assert.deepEqual(finance.payables, []);

// Una devolución compensa la venta reconocida sin borrar la entrega original.
// Inventario, COGS, venta neta y Caja mantienen ledgers independientes.
let returnedOrder = await createOrder(catalogProduct, {
  quantity: 2, unitPriceSold: 10000, discountAmount: 2000, deliveryFee: 1000,
  phone: "8800-0099", scheduledDeliveryDate: "2026-08-29",
});
DB.sqlite.prepare("UPDATE order_lines SET historical_cost_snapshot=4000 WHERE order_id=?").run(returnedOrder.id);
returnedOrder = (await action(returnedOrder, "payments", { amount: 19000, method: "SINPE" })).order;
const returnedOrderPaymentId = returnedOrder.payments.find((payment) => payment.type === "PAYMENT").id;
returnedOrder = (await action(returnedOrder, "confirm")).order;
returnedOrder = (await action(returnedOrder, "prepare")).order;
returnedOrder = (await action(returnedOrder, "deliver")).order;
DB.sqlite.prepare("UPDATE delivery_routes SET status='CLOSED',closed_at='2026-08-29T20:00:00.000Z' WHERE id=?").run(returnedOrder.routeId);
const returnLineId = returnedOrder.lines[0].id;
const stockBeforePartialReturn = Number(DB.sqlite.prepare("SELECT quantity_available FROM products WHERE id=?").get(catalogProduct.id).quantity_available);
const cashBeforeReturn = (await snapshot()).cash.incoming;
const partialOperation = op("partial-return");
const partialPayload = JSON.stringify({
  operationId: partialOperation, version: returnedOrder.version, reason: "Una unidad devuelta",
  lines: [{ orderLineId: returnLineId, quantity: 1, reenterInventory: true }],
});
const partialReturn = await call(`/api/orders/${returnedOrder.id}/returns`, { method: "POST", body: partialPayload });
assert.equal(partialReturn.response.status, 200, JSON.stringify(partialReturn.body));
const partialRetry = await call(`/api/orders/${returnedOrder.id}/returns`, { method: "POST", body: partialPayload });
assert.equal(partialRetry.response.status, 200, JSON.stringify(partialRetry.body));
assert.equal(partialRetry.body.idempotent, true);
returnedOrder = partialReturn.body.order;
assert.equal(Number(DB.sqlite.prepare("SELECT quantity_available FROM products WHERE id=?").get(catalogProduct.id).quantity_available), stockBeforePartialReturn + 1);
assert.equal(Number(DB.sqlite.prepare("SELECT COUNT(*) AS total FROM inventory_movements WHERE order_id=? AND movement_type='ORDER_RETURN'").get(returnedOrder.id).total), 1);
finance = await snapshot();
let returnedSale = finance.sales.find((sale) => sale.orderId === returnedOrder.id);
assert.deepEqual({ status: returnedSale.returnStatus, net: returnedSale.productNet, delivery: returnedSale.deliveryIncome, total: returnedSale.totalIncome, returns: returnedSale.returns, cogs: returnedSale.cogs }, {
  status: "PARTIALLY_RETURNED", net: 9000, delivery: 1000, total: 10000, returns: 9000, cogs: 4000,
});
assert.equal(finance.cash.incoming, cashBeforeReturn, "product return without a refund must not invent a cash movement");

const totalReturn = await action(returnedOrder, "returns", {
  reason: "Segunda unidad devuelta", lines: [{ orderLineId: returnLineId, quantity: 1, reenterInventory: true }],
});
returnedOrder = totalReturn.order;
finance = await snapshot();
returnedSale = finance.sales.find((sale) => sale.orderId === returnedOrder.id);
assert.deepEqual({ status: returnedSale.returnStatus, net: returnedSale.productNet, delivery: returnedSale.deliveryIncome, total: returnedSale.totalIncome, cogs: returnedSale.cogs }, {
  status: "RETURNED", net: 0, delivery: 0, total: 0, cogs: 0,
});
assert.equal(Number(DB.sqlite.prepare("SELECT COUNT(*) AS total FROM order_returns WHERE order_id=? AND status='COMPLETED'").get(returnedOrder.id).total), 2);
assert.equal(String(DB.sqlite.prepare("SELECT status FROM delivery_routes WHERE id=?").get(returnedOrder.routeId).status), "CLOSED");
const refundOperation = op("returned-order-refund");
const refundPayload = JSON.stringify({
  operationId: refundOperation, version: returnedOrder.version, type: "REFUND",
  reversesPaymentId: returnedOrderPaymentId, reason: "Reembolso real confirmado",
});
const refund = await call(`/api/orders/${returnedOrder.id}/payments`, { method: "POST", body: refundPayload });
assert.equal(refund.response.status, 200, JSON.stringify(refund.body));
const refundRetry = await call(`/api/orders/${returnedOrder.id}/payments`, { method: "POST", body: refundPayload });
assert.equal(refundRetry.response.status, 200, JSON.stringify(refundRetry.body));
assert.equal(refundRetry.body.idempotent, true);
finance = await snapshot();
assert.equal(finance.cash.incoming, cashBeforeReturn - 19000, "a confirmed refund affects cash exactly once");
assert.equal(Number(DB.sqlite.prepare("SELECT COUNT(*) AS total FROM order_payments WHERE reverses_payment_id=?").get(returnedOrderPaymentId).total), 1);

// Exportaciones contienen datos reales y las secciones mínimas de Finanzas v1.
const excelExport = await call(`/api/finance/export?from=${FINANCE_TEST_FROM}&to=${FINANCE_TEST_TO}&format=excel`);
assert.equal(excelExport.response.status, 200);
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(excelExport.body);
assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Resumen", "Ventas", "Gastos", "Caja", "Rentabilidad", "Cuentas por cobrar"]);
assert.ok(workbook.getWorksheet("Ventas").getSheetValues().flat().some((value) => value === paidOrder.orderNumber));
const pdfExport = await call(`/api/finance/export?from=${FINANCE_TEST_FROM}&to=${FINANCE_TEST_TO}&format=pdf`);
assert.equal(pdfExport.response.status, 200);
assert.equal(pdfExport.response.headers.get("content-type"), "application/pdf");
if (process.env.SAVE_FINANCE_PDF === "1") {
  await mkdir(new URL("../tmp/pdfs/", import.meta.url), { recursive: true });
  await writeFile(new URL("../tmp/pdfs/finance-v1.pdf", import.meta.url), pdfExport.body);
}
assert.ok((await PDFDocument.load(pdfExport.body)).getPageCount() >= 1);

DB.close();
console.log("Finance v1 preserves delivered-sales semantics, historical costs, cash separation, idempotency, reversals, budgets and exports");
