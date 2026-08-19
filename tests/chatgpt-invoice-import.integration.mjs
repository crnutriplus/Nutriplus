import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { unzipSync } from "fflate";
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
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error, "Esta factura ya fue procesada.");
  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM inventory_documents").first()).total), 1);
  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM inventory_document_lines").first()).total), 4);
  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM invoice_ai_analyses").first()).total), 1);
  assert.equal(openAiCalls, 0);

  console.log("ChatGPT Import real ZIP: validated draft, 4 lines, 5 units, deduplication, zero inventory writes, and zero OpenAI calls passed");
} finally {
  delete globalThis.__NUTRIPLUS_INVOICE_AI_TEST_FETCH__;
  DB.close();
}
