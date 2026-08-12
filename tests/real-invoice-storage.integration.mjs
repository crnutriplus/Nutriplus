import assert from "node:assert/strict";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { LocalD1Database, LocalR2Bucket } from "./helpers/local-bindings.mjs";

const iherbPath = process.env.NUTRIPLUS_IHERB_TEST_PDF;
const amazonPath = process.env.NUTRIPLUS_AMAZON_TEST_PDF;
if (!iherbPath || !amazonPath) {
  throw new Error("Definí NUTRIPLUS_IHERB_TEST_PDF y NUTRIPLUS_AMAZON_TEST_PDF para ejecutar esta prueba local.");
}

const [iherbBytes, amazonBytes, iherbText, amazonText] = await Promise.all([
  readFile(iherbPath),
  readFile(amazonPath),
  readFile(new URL("./fixtures/iherb-real-text.txt", import.meta.url), "utf8"),
  readFile(new URL("./fixtures/amazon-real-ocr.txt", import.meta.url), "utf8"),
]);
const DB = new LocalD1Database();
const BUCKET = new LocalR2Bucket();
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("real-invoice-storage", `${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
const env = {
  DB,
  BUCKET,
  INVOICE_AI_ENABLED: "false",
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  IMAGES: { input() { throw new Error("Images are not used in this test."); } },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function request(path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("accept", "application/json");
  headers.set("oai-authenticated-user-email", "pruebas-locales@nutriplus.test");
  if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  return worker.fetch(new Request(`http://local.test${path}`, { ...init, headers }), env, ctx);
}

async function json(path, init = {}) {
  const response = await request(path, init);
  const body = JSON.parse(await response.text());
  return { response, body };
}

async function upload(path, bytes) {
  const form = new FormData();
  form.set("mode", "manual");
  form.append("files", new File([bytes], basename(path), { type: "application/pdf" }));
  return json("/api/inventory-intake", { method: "POST", body: form });
}

try {
  await json("/api/settings");
  const config = await json("/api/inventory-intake/config");
  assert.equal(config.body.aiAvailable, false);

  const amazon = await upload(amazonPath, amazonBytes);
  assert.equal(amazon.response.status, 201);
  assert.equal(amazon.body.document.processingMode, "manual");
  assert.equal(amazon.body.lines.length, 0);
  const amazonFile = await request(amazon.body.files[0].viewUrl);
  assert.deepEqual(Buffer.from(await amazonFile.arrayBuffer()), amazonBytes);
  const amazonFallback = await json(`/api/inventory-intake/${amazon.body.document.id}/fallback`, {
    method: "POST",
    body: JSON.stringify({ pages: [{ pageNumber: 1, text: amazonText, confidence: 90, source: "ocr" }], warnings: [] }),
  });
  assert.equal(amazonFallback.response.status, 200);
  assert.equal(amazonFallback.body.document.orderNumber, "112-7504724-5768234");
  assert.equal(amazonFallback.body.lines.length, 4);

  const iherb = await upload(iherbPath, iherbBytes);
  assert.equal(iherb.response.status, 201);
  const iherbRange = await request(iherb.body.files[0].viewUrl, { headers: { range: "bytes=0-63" } });
  assert.equal(iherbRange.status, 206);
  assert.equal((await iherbRange.arrayBuffer()).byteLength, 64);
  const iherbFallback = await json(`/api/inventory-intake/${iherb.body.document.id}/fallback`, {
    method: "POST",
    body: JSON.stringify({ pages: [{ pageNumber: 1, text: iherbText, confidence: 100, source: "pdf_text" }], warnings: [] }),
  });
  assert.equal(iherbFallback.response.status, 200);
  assert.equal(iherbFallback.body.document.orderNumber, "945586803");
  assert.equal(iherbFallback.body.document.shipmentNumber, "1LSCXLZ0066WJ4P");
  assert.deepEqual(iherbFallback.body.lines.map((line) => line.billedQuantity), [1, 1, 2, 1]);

  const cached = await upload(iherbPath, iherbBytes);
  assert.equal(cached.response.status, 200);
  assert.equal(cached.body.resumed, true);
  assert.equal(cached.body.document.id, iherb.body.document.id);

  const products = await json("/api/products?limit=1000");
  assert.equal(products.body.products.length, 0);
  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM inventory_operations").first()).total), 0);
  assert.equal(Number((await DB.prepare("SELECT COUNT(*) AS total FROM inventory_movements").first()).total), 0);
  console.log("Real iHerb/Amazon PDFs: local storage, viewer, Manual/OCR recovery, cache, and zero inventory writes passed");
} finally {
  DB.close();
}
