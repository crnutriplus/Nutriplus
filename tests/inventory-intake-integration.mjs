import assert from "node:assert/strict";
import { Miniflare } from "miniflare";

const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('ok') } }",
  d1Databases: { DB: "nutriplus-inventory-intake-test" },
});
const DB = await mf.getD1Database("DB");
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("inventory-intake", `${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
const env = {
  DB,
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  IMAGES: { input() { throw new Error("Images are not used in API tests."); } },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function call(path, init = {}) {
  const response = await worker.fetch(new Request(`http://local.test${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "oai-authenticated-user-email": "inventario@nutriplus.test",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  }), env, ctx);
  const body = await response.json();
  return { response, body };
}

function fingerprint(value) {
  return value.toString(16).padStart(64, "0");
}

function page(text) {
  return [{ pageNumber: 1, text, confidence: 100, source: "pdf_text" }];
}

async function analyze({ id, fileName, text }) {
  return call("/api/inventory-intake", {
    method: "POST",
    body: JSON.stringify({ fingerprint: fingerprint(id), fileName, mimeTypes: ["application/pdf"], pages: page(text), warnings: [] }),
  });
}

await call("/api/settings");

const baseProduct = (await call("/api/products", {
  method: "POST",
  body: JSON.stringify({
    name: "NOW Foods Magnesium Citrate 120 Veg Capsules 200 mg",
    code: "036000291452",
    purchasePriceUsd: 12.75,
    weightLb: 0.42,
    quantityAvailable: 10,
    minimumStock: 2,
    minimumStockEnabled: true,
  }),
})).body.product;

const amazon = await analyze({
  id: 1,
  fileName: "amazon-invoice.pdf",
  text: `Amazon Invoice
Order #: 114-1234567-1234567
Invoice #: INV-AMZ-001
Shipment #: SHIP-001
ASIN: B000123456
UPC: 036000291452
2 x NOW Foods Magnesium Citrate 120 Veg Capsules 200 mg`,
});
assert.equal(amazon.response.status, 201);
assert.equal(amazon.body.document.provider, "amazon");
assert.equal(amazon.body.lines.length, 1);
assert.equal(amazon.body.lines[0].secondaryType, "asin");
assert.equal(amazon.body.lines[0].secondaryId, "B000123456");
assert.equal(amazon.body.lines[0].status, "confirmed");
assert.equal(amazon.body.lines[0].matchProductId, baseProduct.id);

const amazonLine = { ...amazon.body.lines[0], receivedQuantity: 5, totalToAdd: 5, unitsPerPackage: 1, barcodeLevel: "unit", selected: true };
const confirmId = "ingress-amazon-0001";
const [firstConfirm, retriedConfirm] = await Promise.all([
  call(`/api/inventory-intake/${amazon.body.document.id}/confirm`, {
    method: "POST",
    headers: { "x-mutation-id": confirmId },
    body: JSON.stringify({ operationId: confirmId, lines: [amazonLine] }),
  }),
  call(`/api/inventory-intake/${amazon.body.document.id}/confirm`, {
    method: "POST",
    headers: { "x-mutation-id": confirmId },
    body: JSON.stringify({ operationId: confirmId, lines: [amazonLine] }),
  }),
]);
assert.ok([200, 202].includes(firstConfirm.response.status));
assert.ok([200, 202].includes(retriedConfirm.response.status));
const afterAmazon = (await call("/api/products?code=036000291452")).body.product;
assert.equal(afterAmazon.quantityAvailable, 15);
assert.equal(afterAmazon.purchasePriceUsd, 12.75);
assert.equal(afterAmazon.weightLb, 0.42);

const operationCheck = await call(`/api/inventory-intake/operations/${confirmId}`);
assert.equal(operationCheck.response.status, 200);
assert.equal(operationCheck.body.operation.status, "completed");
assert.equal(operationCheck.body.movements[0].previousQuantity, 10);
assert.equal(operationCheck.body.movements[0].quantityAdded, 5);
assert.equal(operationCheck.body.movements[0].resultingQuantity, 15);

const exactDuplicate = await analyze({ id: 1, fileName: "amazon-copy.pdf", text: "ignored because fingerprint wins" });
assert.equal(exactDuplicate.response.status, 200);
assert.equal(exactDuplicate.body.exactDuplicate, true);
assert.equal(exactDuplicate.body.lines[0].status, "processed");

const secondFileSameInvoice = await analyze({
  id: 2,
  fileName: "amazon-duplicate.pdf",
  text: `Amazon Invoice
Order #: 114-1234567-1234567
Invoice #: INV-AMZ-001
Shipment #: SHIP-001
ASIN: B000123456
UPC: 036000291452
2 x NOW Foods Magnesium Citrate 120 Veg Capsules 200 mg`,
});
assert.equal(secondFileSameInvoice.response.status, 201);
assert.equal(secondFileSameInvoice.body.duplicate, true);
const duplicateConfirm = await call(`/api/inventory-intake/${secondFileSameInvoice.body.document.id}/confirm`, {
  method: "POST",
  body: JSON.stringify({ operationId: "ingress-amazon-duplicate", lines: [{ ...secondFileSameInvoice.body.lines[0], receivedQuantity: 2, totalToAdd: 2, unitsPerPackage: 1, barcodeLevel: "unit", selected: true }] }),
});
assert.equal(duplicateConfirm.response.status, 409);
assert.equal((await call("/api/products?code=036000291452")).body.product.quantityAvailable, 15);

const partialShipment = await analyze({
  id: 3,
  fileName: "amazon-partial-2.pdf",
  text: `Amazon Invoice
Order #: 114-1234567-1234567
Invoice #: INV-AMZ-002
Shipment #: SHIP-002
ASIN: B000123456
UPC: 036000291452
1 x NOW Foods Magnesium Citrate 120 Veg Capsules 200 mg`,
});
assert.equal(partialShipment.response.status, 201);
assert.equal(partialShipment.body.document.duplicateOf, "");

const quote = (await call("/api/quotes", {
  method: "POST",
  body: JSON.stringify({ name: "California Gold Nutrition Vitamin D3 90 Softgels 125 mcg", code: "4006381333931", purchasePriceUsd: 8.5, weightLb: 0.2 }),
})).body.quote;
const iherb = await analyze({
  id: 4,
  fileName: "iherb-invoice.pdf",
  text: `iHerb Invoice
Order #: IHB-001
Invoice #: IHB-INV-001
Shipment #: IHB-SHIP-1
Product Code: CGN-01001
UPC: 4006381333931
2 x California Gold Nutrition Vitamin D3 90 Softgels 125 mcg`,
});
assert.equal(iherb.response.status, 201);
assert.equal(iherb.body.document.provider, "iherb");
assert.equal(iherb.body.lines[0].secondaryType, "iherb");
assert.equal(iherb.body.lines[0].matchNonInventoryId, quote.id);
assert.equal(iherb.body.lines[0].status, "non_inventory");
const moveConfirm = await call(`/api/inventory-intake/${iherb.body.document.id}/confirm`, {
  method: "POST",
  body: JSON.stringify({ operationId: "ingress-iherb-move-001", lines: [{ ...iherb.body.lines[0], receivedQuantity: 2, unitsPerPackage: 1, totalToAdd: 2, barcodeLevel: "unit", selected: true }] }),
});
assert.equal(moveConfirm.response.status, 200);
const moved = (await call("/api/products?code=4006381333931")).body.product;
assert.equal(moved.quantityAvailable, 2);
assert.equal(moved.purchasePriceUsd, 8.5);
assert.equal(moved.weightLb, 0.2);
assert.equal((await call("/api/quotes?limit=100")).body.quotes.some((item) => item.id === quote.id), false);

const packageInvoice = await analyze({
  id: 5,
  fileName: "other-store.pdf",
  text: `Wellness Store Invoice
Order #: WS-001
Invoice #: WS-INV-001
UPC: 5901234123457
2 x Nutri Test Omega 3 Pack of 3 Bottles 60 Softgels`,
});
assert.equal(packageInvoice.response.status, 201);
assert.equal(packageInvoice.body.lines[0].status, "requires_conversion");
const packageLine = { ...packageInvoice.body.lines[0], receivedQuantity: 2, unitsPerPackage: 3, totalToAdd: 6, barcodeLevel: "unit", status: "new_product", action: "create", selected: true };
const packageConfirm = await call(`/api/inventory-intake/${packageInvoice.body.document.id}/confirm`, {
  method: "POST",
  body: JSON.stringify({ operationId: "ingress-package-0001", lines: [packageLine] }),
});
assert.equal(packageConfirm.response.status, 200);
const createdPackage = (await call("/api/products?code=5901234123457")).body.product;
assert.equal(createdPackage.quantityAvailable, 6);
assert.equal(createdPackage.purchasePriceUsd, null);
assert.equal(createdPackage.weightLb, null);

const badDocument = await analyze({
  id: 6,
  fileName: "credit-note.pdf",
  text: `Credit Note
Invoice #: RETURN-1
UPC: 5012345678900
1 x Returned Vitamin C 100 Tablets 500 mg`,
});
assert.equal(badDocument.body.document.status, "credit_note");
const badConfirm = await call(`/api/inventory-intake/${badDocument.body.document.id}/confirm`, {
  method: "POST",
  body: JSON.stringify({ operationId: "ingress-credit-note-001", lines: [{ ...badDocument.body.lines[0], selected: true }] }),
});
assert.equal(badConfirm.response.status, 409);

const reversal = await call(`/api/inventory-intake/operations/ingress-package-0001/reverse`, {
  method: "POST",
  body: JSON.stringify({ operationId: "reversal-package-0001", reason: "Prueba de ingreso incorrecto" }),
});
assert.equal(reversal.response.status, 200);
assert.equal((await call("/api/products?code=5901234123457")).body.product.quantityAvailable, 0);
const secondReversal = await call(`/api/inventory-intake/operations/ingress-package-0001/reverse`, {
  method: "POST",
  body: JSON.stringify({ operationId: "reversal-package-0002", reason: "No debe duplicarse" }),
});
assert.equal(secondReversal.response.status, 409);

const history = await call("/api/inventory-intake?history=1");
assert.equal(history.response.status, 200);
assert.ok(history.body.operations.some((operation) => operation.id === "ingress-package-0001"));
assert.ok(history.body.operations.some((operation) => operation.id === "reversal-package-0001"));

await mf.dispose();
console.log("Invoice recognition, additive inventory, duplicate protection, package conversion, move, history, and reversal checks passed");
