import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { LocalD1Database, LocalR2Bucket } from "./helpers/local-bindings.mjs";

const DB = new LocalD1Database();
const BUCKET = new LocalR2Bucket();
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("inventory-intake", `${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
const env = {
  DB,
  BUCKET,
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  IMAGES: { input() { throw new Error("Images are not used in API tests."); } },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function request(path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("accept", "application/json");
  headers.set("oai-authenticated-user-email", "inventario@nutriplus.test");
  if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  return worker.fetch(new Request(`http://local.test${path}`, { ...init, headers }), env, ctx);
}

async function call(path, init = {}) {
  const response = await request(path, init);
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

const recoveredPdf = new TextEncoder().encode("%PDF-1.4\n% NutriPlus legacy upload recovery\n%%EOF");
const recoveredFileSha = createHash("sha256").update(recoveredPdf).digest("hex");
const recoveredFingerprint = createHash("sha256").update(`0:${recoveredFileSha}`).digest("hex");
const legacyDraft = await call("/api/inventory-intake", {
  method: "POST",
  body: JSON.stringify({
    fingerprint: recoveredFingerprint,
    fileName: "amazon-legacy.pdf",
    mimeTypes: ["application/pdf"],
    pages: page("Amazon · borrador legado sin archivo"),
    warnings: ["No se encontró el archivo guardado. Podés continuar agregando los productos manualmente."],
  }),
});
assert.equal(legacyDraft.response.status, 201);
assert.equal(legacyDraft.body.document.fileCount, 0);
assert.equal(legacyDraft.body.files.length, 0);

const recoveryForm = new FormData();
recoveryForm.set("mode", "manual");
recoveryForm.append("files", new File([recoveredPdf], "amazon-recovered.pdf", { type: "application/pdf" }));
const recoveredDraft = await call("/api/inventory-intake", { method: "POST", body: recoveryForm });
assert.equal(recoveredDraft.response.status, 200);
assert.equal(recoveredDraft.body.resumed, true);
assert.equal(recoveredDraft.body.document.id, legacyDraft.body.document.id);
assert.equal(recoveredDraft.body.document.fileCount, 1);
assert.equal(recoveredDraft.body.files.length, 1);
assert.equal(recoveredDraft.body.document.warnings.some((warning) => /archivo guardado/i.test(warning)), false);
const recoveredView = await request(recoveredDraft.body.files[0].viewUrl);
assert.equal(recoveredView.status, 200);
assert.deepEqual(Buffer.from(await recoveredView.arrayBuffer()), Buffer.from(recoveredPdf));
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM inventory_operations").first()).total), 0);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM inventory_movements").first()).total), 0);

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
  text: `Amazon Resumen del pedido
Pedido realizado 25 de julio de 2026 — N.° de pedido 114-1234567-1234567
Número de rastreo: SHIP-001
ASIN: B000123456
UPC: 036000291452
2 x NOW Foods Magnesium Citrate 120 Veg Capsules 200 mg`,
});
assert.equal(amazon.response.status, 201);
assert.equal(amazon.body.document.provider, "amazon");
assert.equal(amazon.body.document.orderNumber, "114-1234567-1234567");
assert.equal(amazon.body.document.documentDate, "25 de julio de 2026");
assert.equal(amazon.body.document.shipmentNumber, "SHIP-001");
assert.equal(amazon.body.lines.length, 1);
assert.equal(amazon.body.lines[0].secondaryType, "asin");
assert.equal(amazon.body.lines[0].secondaryId, "B000123456");
assert.equal(amazon.body.lines[0].status, "confirmed");
assert.equal(amazon.body.lines[0].matchProductId, baseProduct.id);

const amazonLine = { ...amazon.body.lines[0], receivedQuantity: 5, totalToAdd: 5, unitsPerPackage: 1, barcodeLevel: "unit", barcodeConfirmed: true, selected: true };
const unconfirmedAttempt = await call(`/api/inventory-intake/${amazon.body.document.id}/confirm`, {
  method: "POST",
  body: JSON.stringify({ operationId: "ingress-amazon-unconfirmed", lines: [{ ...amazonLine, barcodeConfirmed: false }] }),
});
assert.equal(unconfirmedAttempt.response.status, 409);
assert.equal((await call("/api/products?code=036000291452")).body.product.quantityAvailable, 10);
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
  text: `Amazon Resumen del pedido
Pedido realizado 25 de julio de 2026 — N.P de pedido 114-1234567-1234567
Número de rastreo: SHIP-001
ASIN: B000123456
UPC: 036000291452
2 x NOW Foods Magnesium Citrate 120 Veg Capsules 200 mg`,
});
assert.equal(secondFileSameInvoice.response.status, 201);
assert.equal(secondFileSameInvoice.body.duplicate, true);
const duplicateConfirm = await call(`/api/inventory-intake/${secondFileSameInvoice.body.document.id}/confirm`, {
  method: "POST",
  body: JSON.stringify({ operationId: "ingress-amazon-duplicate", lines: [{ ...secondFileSameInvoice.body.lines[0], receivedQuantity: 2, totalToAdd: 2, unitsPerPackage: 1, barcodeLevel: "unit", barcodeConfirmed: true, selected: true }] }),
});
assert.equal(duplicateConfirm.response.status, 409);
assert.equal((await call("/api/products?code=036000291452")).body.product.quantityAvailable, 15);

const partialShipment = await analyze({
  id: 3,
  fileName: "amazon-partial-2.pdf",
  text: `Amazon Resumen del pedido
Pedido realizado 26 de julio de 2026 — N.º de pedido 114-1234567-1234567
Número de rastreo: SHIP-002
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
  text: `www.iHerb.com
Número de compra: 945586803
Fecha de la compra: 03 Julio 2026
Método de envío / Información
de seguimiento
Envío acelerado /
1LSCXLZ0066WJ4P
Product Code: CGN-01001
UPC: 4006381333931
2 x California Gold Nutrition Vitamin D3 90 Softgels 125 mcg`,
});
assert.equal(iherb.response.status, 201);
assert.equal(iherb.body.document.provider, "iherb");
assert.equal(iherb.body.document.orderNumber, "945586803");
assert.equal(iherb.body.document.documentDate, "03 Julio 2026");
assert.equal(iherb.body.document.shipmentNumber, "1LSCXLZ0066WJ4P");
assert.equal(iherb.body.lines[0].secondaryType, "iherb");
assert.equal(iherb.body.lines[0].matchNonInventoryId, quote.id);
assert.equal(iherb.body.lines[0].status, "non_inventory");
const moveConfirm = await call(`/api/inventory-intake/${iherb.body.document.id}/confirm`, {
  method: "POST",
  body: JSON.stringify({ operationId: "ingress-iherb-move-001", lines: [{ ...iherb.body.lines[0], receivedQuantity: 2, unitsPerPackage: 1, totalToAdd: 2, barcodeLevel: "unit", barcodeConfirmed: true, selected: true }] }),
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
const packageLine = { ...packageInvoice.body.lines[0], receivedQuantity: 2, unitsPerPackage: 3, totalToAdd: 6, barcodeLevel: "unit", barcodeConfirmed: true, status: "new_product", action: "create", selected: true };
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

const cancelDraft = await analyze({
  id: 7,
  fileName: "cancel-me.pdf",
  text: `iHerb
Número de compra: 777888999
Fecha de la compra: 11 Agosto 2026
UPC: 5901234123457
1 x Nutri Test Omega 3 Pack of 3 Bottles 60 Softgels`,
});
assert.equal(cancelDraft.response.status, 201);
const canceled = await call(`/api/inventory-intake/${cancelDraft.body.document.id}/cancel`, { method: "POST", body: "{}" });
assert.equal(canceled.response.status, 200);
const reloadCanceledFile = await analyze({
  id: 7,
  fileName: "cancel-me.pdf",
  text: `iHerb
Número de compra: 777888999
Fecha de la compra: 11 Agosto 2026
UPC: 5901234123457
1 x Nutri Test Omega 3 Pack of 3 Bottles 60 Softgels`,
});
assert.equal(reloadCanceledFile.response.status, 201);
assert.equal(reloadCanceledFile.body.exactDuplicate, false);

const saveSubset = await analyze({
  id: 8,
  fileName: "subset-review.pdf",
  text: `Amazon
Pedido realizado 11 de agosto de 2026 — N.º de pedido 112-0000000-0000001
ASIN: B000123456
UPC: 036000291452
1 x NOW Foods Magnesium Citrate 120 Veg Capsules 200 mg`,
});
const savedLine = { ...saveSubset.body.lines[0], barcodeConfirmed: true, receivedQuantity: 1, totalToAdd: 1 };
const extraLine = { ...savedLine, id: "iline-manual-to-delete", lineKey: "manual-to-delete" };
const individualLine = {
  ...savedLine,
  id: "iline-confirm-individually",
  lineKey: "confirm-individually",
  originalDescription: "NutriPlus Test Vitamin C 30 tablets",
  name: "NutriPlus Test Vitamin C 30 tablets",
  presentation: "30 tablets",
  size: "30 tablets",
  barcode: "9780306406157",
  canonicalBarcode: "09780306406157",
  barcodeType: "EAN-13",
  barcodeMethod: "external_source",
  barcodeSource: "Catálogo de prueba",
  barcodeSourceUrl: "https://catalogo.example.test/vitamin-c-30",
  barcodeSourceTitle: "NutriPlus Test Vitamin C 30 tablets",
  barcodeDifferences: [],
  barcodeLookupStatus: "found_exact",
  secondaryId: "",
  secondaryType: "",
  matchProductId: null,
  matchNonInventoryId: null,
  status: "new_product",
  action: "create",
};
const savedSubset = await call(`/api/inventory-intake/${saveSubset.body.document.id}`, {
  method: "PUT",
  body: JSON.stringify({ ...saveSubset.body.document, metadataChanged: true, lines: [savedLine, extraLine, individualLine], deletedLineIds: [] }),
});
assert.equal(savedSubset.response.status, 200, JSON.stringify(savedSubset.body));
const deletedSubset = await call(`/api/inventory-intake/${saveSubset.body.document.id}`, {
  method: "PUT",
  body: JSON.stringify({ metadataChanged: false, lines: [], deletedLineIds: [extraLine.id] }),
});
assert.equal(deletedSubset.response.status, 200);
assert.equal(deletedSubset.body.lines.some((line) => line.id === extraLine.id), false);
const individualConfirm = await call(`/api/inventory-intake/${saveSubset.body.document.id}/confirm`, {
  method: "POST",
  body: JSON.stringify({ operationId: "ingress-individual-line-001", lines: [{ ...individualLine, selected: true }] }),
});
assert.equal(individualConfirm.response.status, 200, JSON.stringify(individualConfirm.body));
assert.equal(individualConfirm.body.operation.lineCount, 1);
const afterIndividual = await call(`/api/inventory-intake/${saveSubset.body.document.id}`);
assert.equal(afterIndividual.response.status, 200);
assert.equal(afterIndividual.body.document.status, "partial");
assert.equal(afterIndividual.body.lines.find((line) => line.id === individualLine.id).status, "processed");
assert.equal(afterIndividual.body.lines.find((line) => line.id === individualLine.id).barcodeSourceUrl, "https://catalogo.example.test/vitamin-c-30");
assert.notEqual(afterIndividual.body.lines.find((line) => line.id === savedLine.id).status, "processed");
assert.equal((await call("/api/products?code=9780306406157")).body.product.quantityAvailable, 1);
assert.equal((await call("/api/products?code=036000291452")).body.product.quantityAvailable, 15);

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

DB.close();
console.log("Invoice recognition, additive inventory, duplicate protection, package conversion, move, history, and reversal checks passed");
