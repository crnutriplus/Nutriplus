import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { LocalD1Database, LocalR2Bucket } from "./helpers/local-bindings.mjs";

const zipPath = process.env.NUTRIPLUS_CHATGPT_IMPORT_ZIP;
if (!zipPath) {
  throw new Error("Definí NUTRIPLUS_CHATGPT_IMPORT_ZIP para ejecutar esta prueba con el paquete real.");
}

const zipBytes = await readFile(zipPath);
const extracted = unzipSync(zipBytes);
const invoiceEntry = Object.entries(extracted).find(([name]) => /^invoice\.(?:pdf|jpe?g|png|webp)$/i.test(name));
assert.ok(invoiceEntry, "El ZIP real debe incluir una factura invoice.*.");

const DB = new LocalD1Database();
const BUCKET = new LocalR2Bucket();
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("chatgpt-invoice-import", `${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
const env = {
  DB,
  BUCKET,
  OPENAI_API_KEY: ["sk", "test", "unused-chatgpt-import-key-000000000000"].join("-"),
  INVOICE_AI_ENABLED: "true",
  INVOICE_AI_MODEL: "gpt-5.6-terra",
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  IMAGES: { input() { throw new Error("Images are not used in this test."); } },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

let openAiCalls = 0;
globalThis.__NUTRIPLUS_INVOICE_AI_TEST_FETCH__ = async () => {
  openAiCalls += 1;
  throw new Error("Importar análisis de ChatGPT no debe llamar a OpenAI.");
};

async function request(path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("accept", "application/json");
  headers.set("oai-authenticated-user-email", "pruebas-importacion@nutriplus.test");
  return worker.fetch(new Request(`http://local.test${path}`, { ...init, headers }), env, ctx);
}

async function callJson(path, init = {}) {
  const response = await request(path, init);
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(`${path} devolvió contenido no JSON (${response.status}): ${raw.slice(0, 300)}`); }
  return { response, body };
}

function uploadPackage() {
  const form = new FormData();
  form.append("package", new File([zipBytes], basename(zipPath), { type: "application/zip" }));
  return callJson("/api/inventory-intake/import-chatgpt", { method: "POST", body: form });
}

function uploadBytes(bytes, name = "NutriPlus_PARTIAL-2.zip", type = "application/zip") {
  const form = new FormData();
  form.append("package", new File([bytes], name, { type }));
  return callJson("/api/inventory-intake/import-chatgpt", { method: "POST", body: form });
}

const encoder = new TextEncoder();
function twoLinePackage({
  purchaseNumber = "PARTIAL-2",
  invoiceBytes = encoder.encode("%PDF-1.4\n% NutriPlus two-line partial recovery fixture\n%%EOF"),
  sourceSha256,
  invalidJson = false,
  entries,
} = {}) {
  const sha256 = sourceSha256 || createHash("sha256").update(invoiceBytes).digest("hex");
  const analysis = {
    schema: "nutriplus.invoice_import",
    schema_version: "1.0",
    analysis_origin: "CHATGPT_IMPORT",
    source: { file_name: `${purchaseNumber}.pdf`, sha256, page_count: 1 },
    invoice: {
      supplier: "iHerb",
      purchase_number: purchaseNumber,
      invoice_number: null,
      purchase_date: "2026-08-19",
      tracking_number: `TRACK-${purchaseNumber}`,
      currency: "USD",
      subtotal: 14,
      shipping: 0,
      tax: 0,
      total: 14,
      line_count: 2,
      inventory_units: 3,
    },
    products: [
      {
        line_number: 1,
        brand: "NutriPlus Test",
        name: "Vitamina C prueba parcial",
        presentation: "30 tabletas",
        size: "30 tabletas",
        flavor: null,
        strength: "500 mg",
        quantity: 1,
        unit_price: 6,
        discount_total: 0,
        line_subtotal: 6,
        supplier_sku: `NP-${purchaseNumber}-1`,
        identifiers: { upc_gtin12: "036000291452", iherb_product_id: "TEST-1" },
        provenance: { upc_gtin12: "fixture" },
        review_status: "READY",
      },
      {
        line_number: 2,
        brand: "NutriPlus Test",
        name: "Omega 3 prueba parcial",
        presentation: "60 cápsulas",
        size: "60 cápsulas",
        flavor: null,
        strength: "1000 mg",
        quantity: 2,
        unit_price: 4,
        discount_total: 0,
        line_subtotal: 8,
        supplier_sku: `NP-${purchaseNumber}-2`,
        identifiers: { ean13: "5901234123457", iherb_product_id: "TEST-2" },
        provenance: { ean13: "fixture" },
        review_status: "READY",
      },
    ],
    validation: { invoice_total_matches_lines: true, all_quantities_present: true },
  };
  return zipSync(entries || {
    "invoice.pdf": invoiceBytes,
    "analysis.json": encoder.encode(invalidJson ? "{not-json" : JSON.stringify(analysis)),
  });
}

function confirmable(line) {
  return {
    ...line,
    barcodeConfirmed: true,
    barcodeLevel: "unit",
    status: "new_product",
    action: "create",
    selected: true,
  };
}

try {
  await callJson("/api/settings");

  const imported = await uploadPackage();
  assert.equal(imported.response.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.document.processingMode, "chatgpt_import");
  assert.equal(imported.body.document.status, "draft");
  assert.equal(imported.body.document.provider, "iherb");
  assert.equal(imported.body.document.orderNumber, "945586803");
  assert.equal(imported.body.document.documentDate, "2026-07-03");
  assert.equal(imported.body.document.shipmentNumber, "1LSCXLZ0066WJ4P");
  assert.equal(imported.body.document.fileCount, 1);
  assert.equal(imported.body.lines.length, 4);
  assert.deepEqual(imported.body.lines.map((line) => line.billedQuantity), [1, 1, 2, 1]);
  assert.equal(imported.body.lines.reduce((sum, line) => sum + line.billedQuantity, 0), 5);
  assert.deepEqual(imported.body.lines.map((line) => line.brand), ["Centrum", "NOW Foods", "Source Naturals", "Nordic Naturals"]);
  assert.deepEqual(imported.body.lines.map((line) => line.barcode), ["305734755654", "733739037732", "021078027829", "768990567803"]);
  assert.deepEqual(imported.body.lines.map((line) => line.secondaryId), ["CEM-75565", "NOW-03773", "SNS-02782", "NOR-56780"]);

  assert.equal(imported.body.analysis.analysisOrigin, "CHATGPT_IMPORT");
  assert.equal(imported.body.analysis.apiCalls, 0);
  assert.equal(imported.body.analysis.apiCostUsd, 0);
  assert.equal(imported.body.analysis.estimatedCostUsd, 0);
  assert.equal(imported.body.analysis.webSearchCount, 0);
  assert.equal(imported.body.analysis.importSummary.currency, "USD");
  assert.equal(imported.body.analysis.importSummary.total, 60.58);
  assert.equal(imported.body.analysis.importSummary.lineCount, 4);
  assert.equal(imported.body.analysis.importSummary.inventoryUnits, 5);
  assert.equal(imported.body.usage.billedAnalyses, 0);
  assert.equal(imported.body.usage.cumulativeCostUsd, 0);
  assert.equal(openAiCalls, 0);

  const storedInvoice = await request(imported.body.files[0].viewUrl);
  assert.equal(storedInvoice.status, 200);
  const storedBytes = Buffer.from(await storedInvoice.arrayBuffer());
  assert.equal(
    createHash("sha256").update(storedBytes).digest("hex"),
    createHash("sha256").update(invoiceEntry[1]).digest("hex"),
  );

  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM products").first()).total), 0);
  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM inventory_operations").first()).total), 0);
  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM inventory_movements").first()).total), 0);
  const analysisRow = await DB.prepare("SELECT analysis_origin,api_calls,api_cost_microusd FROM invoice_ai_analyses LIMIT 1").first();
  assert.equal(analysisRow.analysis_origin, "CHATGPT_IMPORT");
  assert.equal(analysisRow.api_calls, 0);
  assert.equal(analysisRow.api_cost_microusd, 0);

  const duplicate = await uploadPackage();
  assert.equal(duplicate.response.status, 200, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.recovered, true);
  assert.equal(duplicate.body.recoveryState, "draft");
  assert.equal(duplicate.body.processedLines, 0);
  assert.equal(duplicate.body.pendingLines, 4);
  assert.equal(duplicate.body.notice.title, "Borrador recuperado");
  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM inventory_documents").first()).total), 1);
  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM inventory_document_lines").first()).total), 4);
  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM invoice_ai_analyses").first()).total), 1);
  assert.equal(openAiCalls, 0);

  const partialZip = twoLinePackage();
  const partialImport = await uploadBytes(partialZip);
  assert.equal(partialImport.response.status, 201, JSON.stringify(partialImport.body));
  assert.equal(partialImport.body.lines.length, 2);
  assert.equal(partialImport.body.document.status, "draft");
  const [firstLine, secondLine] = partialImport.body.lines;

  const firstConfirmation = await callJson(`/api/inventory-intake/${partialImport.body.document.id}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationId: "ingress-chatgpt-partial-1", lines: [confirmable(firstLine)] }),
  });
  assert.equal(firstConfirmation.response.status, 200, JSON.stringify(firstConfirmation.body));
  assert.equal((await DB.prepare("SELECT quantity_available FROM products WHERE code=?").bind("036000291452").first()).quantity_available, 1);
  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM inventory_movements WHERE document_line_id=?").bind(firstLine.id).first()).total), 1);
  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM finance_expenses WHERE source_type LIKE 'INVENTORY_INVOICE_%' AND source_id LIKE ?").bind(`${partialImport.body.document.id}:payment:%`).first()).total), 1);

  // Simula el estado real encontrado: el movimiento existe, pero la fila procesada dejó de estar en la revisión.
  await DB.prepare("DELETE FROM inventory_document_lines WHERE id=?").bind(firstLine.id).run();
  const partialRecovery = await uploadBytes(partialZip);
  assert.equal(partialRecovery.response.status, 200, JSON.stringify(partialRecovery.body));
  assert.equal(partialRecovery.body.recovered, true);
  assert.equal(partialRecovery.body.recoveryState, "partial");
  assert.equal(partialRecovery.body.processedLines, 1);
  assert.equal(partialRecovery.body.pendingLines, 1);
  assert.equal(partialRecovery.body.notice.code, "CHATGPT_ALREADY_PARTIAL");
  assert.match(partialRecovery.body.notice.message, /1 producto ingresado y 1 pendiente/);
  const recoveredFirst = partialRecovery.body.lines.find((line) => line.lineKey === firstLine.lineKey);
  const recoveredSecond = partialRecovery.body.lines.find((line) => line.lineKey === secondLine.lineKey);
  assert.equal(recoveredFirst.status, "processed");
  assert.ok(recoveredFirst.processedOperationId);
  assert.notEqual(recoveredSecond.status, "processed");

  const duplicateLineAttempt = await callJson(`/api/inventory-intake/${partialImport.body.document.id}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationId: "ingress-chatgpt-duplicate-line", lines: [confirmable(recoveredFirst)] }),
  });
  assert.equal(duplicateLineAttempt.response.status, 409);
  assert.equal(duplicateLineAttempt.body.code, "INVENTORY_LINE_ALREADY_CONFIRMED");
  assert.equal((await DB.prepare("SELECT quantity_available FROM products WHERE code=?").bind("036000291452").first()).quantity_available, 1);
  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM inventory_movements WHERE document_line_id=? AND original_movement_id IS NULL").bind(recoveredFirst.id).first()).total), 1);

  const secondConfirmation = await callJson(`/api/inventory-intake/${partialImport.body.document.id}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationId: "ingress-chatgpt-partial-2", lines: [confirmable(recoveredSecond)] }),
  });
  assert.equal(secondConfirmation.response.status, 200, JSON.stringify(secondConfirmation.body));
  assert.equal((await DB.prepare("SELECT quantity_available FROM products WHERE code=?").bind("5901234123457").first()).quantity_available, 2);
  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM finance_expenses WHERE source_id LIKE ?").bind(`${partialImport.body.document.id}:payment:%`).first()).total), 1, "reprocessing must not duplicate the paid invoice movement");
  const secondRetry = await callJson(`/api/inventory-intake/${partialImport.body.document.id}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationId: "ingress-chatgpt-partial-2", lines: [confirmable(recoveredSecond)] }),
  });
  assert.equal(secondRetry.response.status, 200);
  assert.equal(secondRetry.body.idempotent, true);

  const completedRecovery = await uploadBytes(partialZip);
  assert.equal(completedRecovery.response.status, 200, JSON.stringify(completedRecovery.body));
  assert.equal(completedRecovery.body.recoveryState, "completed");
  assert.equal(completedRecovery.body.processedLines, 2);
  assert.equal(completedRecovery.body.pendingLines, 0);
  assert.equal(completedRecovery.body.notice.code, "CHATGPT_ALREADY_COMPLETED");
  assert.ok(completedRecovery.body.lines.every((line) => line.status === "processed"));
  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM inventory_movements WHERE operation_id IN (?,?)")
    .bind("ingress-chatgpt-partial-1", "ingress-chatgpt-partial-2").first()).total), 2);
  const reversedSecond = await callJson("/api/inventory-intake/operations/ingress-chatgpt-partial-2/reverse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationId: "reversal-chatgpt-partial-2", reason: "Prueba de reversa y reingreso" }),
  });
  assert.equal(reversedSecond.response.status, 200, JSON.stringify(reversedSecond.body));
  assert.equal((await DB.prepare("SELECT quantity_available FROM products WHERE code=?").bind("5901234123457").first()).quantity_available, 0);
  const reversedRecovery = await uploadBytes(partialZip);
  assert.equal(reversedRecovery.response.status, 200, JSON.stringify(reversedRecovery.body));
  assert.equal(reversedRecovery.body.recoveryState, "partial");
  assert.equal(reversedRecovery.body.processedLines, 1);
  assert.equal(reversedRecovery.body.pendingLines, 1);
  const availableAgain = reversedRecovery.body.lines.find((line) => line.lineKey === secondLine.lineKey);
  assert.equal(availableAgain.activeQuantity, 0);
  assert.equal(availableAgain.availableQuantity, 2);
  assert.equal(availableAgain.hasReversals, true);
  assert.equal(availableAgain.action, "existing");
  const reingressedSecond = await callJson(`/api/inventory-intake/${partialImport.body.document.id}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationId: "ingress-chatgpt-partial-3", lines: [{ ...availableAgain, barcodeConfirmed: true, barcodeLevel: "unit", requestedQuantity: 2, selected: true }] }),
  });
  assert.equal(reingressedSecond.response.status, 200, JSON.stringify(reingressedSecond.body));
  assert.equal((await DB.prepare("SELECT quantity_available FROM products WHERE code=?").bind("5901234123457").first()).quantity_available, 2);
  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM inventory_movements WHERE document_line_id=?").bind(availableAgain.id).first()).total), 3);
  const completedAgain = await uploadBytes(partialZip);
  assert.equal(completedAgain.body.recoveryState, "completed");
  assert.equal(completedAgain.body.pendingLines, 0);
  assert.equal(completedAgain.body.lines.find((line) => line.id === availableAgain.id).activeQuantity, 2);
  const history = await callJson("/api/inventory-intake?history=1");
  assert.equal(history.response.status, 200);
  assert.ok(history.body.operations.some((operation) => operation.id === "ingress-chatgpt-partial-1"));
  assert.ok(history.body.operations.some((operation) => operation.id === "ingress-chatgpt-partial-2"));
  assert.ok(history.body.operations.some((operation) => operation.id === "reversal-chatgpt-partial-2"));
  assert.ok(history.body.operations.some((operation) => operation.id === "ingress-chatgpt-partial-3"));
  assert.equal(history.body.documents.filter((invoice) => invoice.id === partialImport.body.document.id).length, 1);

  const personalImport = await uploadBytes(twoLinePackage({ purchaseNumber: "PERSONAL-EXCLUDE", invoiceBytes: encoder.encode("%PDF-1.4\n% personal exclusion fixture\n%%EOF") }));
  assert.equal(personalImport.response.status, 201, JSON.stringify(personalImport.body));
  const [businessLine, personalLine] = personalImport.body.lines;
  const omitted = await callJson(`/api/inventory-intake/${personalImport.body.document.id}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ metadataChanged: false, lines: [{ ...personalLine, lineIndex: 1, action: "ignore", status: "ignored", selectedForIngress: false }], deletedLineIds: [], reviewedLineIds: [personalLine.id] }),
  });
  assert.equal(omitted.response.status, 200, JSON.stringify(omitted.body));
  const businessProduct = await DB.prepare("SELECT id FROM products WHERE code=?").bind("036000291452").first();
  const personalConfirm = await callJson(`/api/inventory-intake/${personalImport.body.document.id}/confirm`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationId: "ingress-personal-exclude", lines: [{ ...businessLine, action: "existing", status: "confirmed", matchProductId: Number(businessProduct.id), barcodeConfirmed: true, barcodeLevel: "unit", selected: true }] }),
  });
  assert.equal(personalConfirm.response.status, 200, JSON.stringify(personalConfirm.body));
  const personalExpense = await DB.prepare("SELECT original_amount_minor FROM finance_expenses WHERE source_id LIKE ? LIMIT 1").bind(`${personalImport.body.document.id}:payment:%`).first();
  assert.equal(Number(personalExpense.original_amount_minor), 600, "only the USD 6.00 business line must enter NutriPlus finance");

  const invalidZip = await uploadBytes(encoder.encode("not a zip"));
  assert.equal(invalidZip.response.status, 400);
  assert.equal(invalidZip.body.code, "CHATGPT_ZIP_INVALID");
  const hashMismatch = await uploadBytes(twoLinePackage({ purchaseNumber: "HASH-MISMATCH", sourceSha256: "0".repeat(64) }));
  assert.equal(hashMismatch.response.status, 400);
  assert.equal(hashMismatch.body.code, "CHATGPT_HASH_MISMATCH");
  const invalidJson = await uploadBytes(twoLinePackage({ purchaseNumber: "INVALID-JSON", invalidJson: true }));
  assert.equal(invalidJson.response.status, 400);
  assert.equal(invalidJson.body.code, "CHATGPT_ANALYSIS_JSON_INVALID");
  const missingAnalysis = await uploadBytes(twoLinePackage({ entries: { "invoice.pdf": encoder.encode("%PDF-1.4\n%%EOF") } }));
  assert.equal(missingAnalysis.response.status, 400);
  assert.equal(missingAnalysis.body.code, "CHATGPT_ANALYSIS_MISSING");
  const missingInvoice = await uploadBytes(twoLinePackage({ entries: { "analysis.json": encoder.encode("{}") } }));
  assert.equal(missingInvoice.response.status, 400);
  assert.equal(missingInvoice.body.code, "CHATGPT_INVOICE_MISSING");

  const differentInvoice = await uploadBytes(twoLinePackage({
    purchaseNumber: "DIFFERENT-2",
    invoiceBytes: encoder.encode("%PDF-1.4\n% a genuinely different invoice fixture\n%%EOF"),
  }), "NutriPlus_DIFFERENT-2.zip");
  assert.equal(differentInvoice.response.status, 201, JSON.stringify(differentInvoice.body));
  assert.notEqual(differentInvoice.body.document.id, partialImport.body.document.id);
  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM invoice_ai_analyses WHERE analysis_origin='CHATGPT_IMPORT' AND (api_calls<>0 OR api_cost_microusd<>0)").first()).total), 0);
  assert.equal(openAiCalls, 0);

  console.log("ChatGPT Import: real ZIP validation, draft/partial/completed recovery, reversal reingress, invoice history, idempotency, and zero OpenAI calls passed");
} finally {
  delete globalThis.__NUTRIPLUS_INVOICE_AI_TEST_FETCH__;
  DB.close();
}
