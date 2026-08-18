import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { LocalD1Database, LocalR2Bucket } from "./helpers/local-bindings.mjs";

const iherbPath = process.env.NUTRIPLUS_IHERB_TEST_PDF;
const amazonPath = process.env.NUTRIPLUS_AMAZON_TEST_PDF;
if (!iherbPath || !amazonPath) {
  throw new Error("Definí NUTRIPLUS_IHERB_TEST_PDF y NUTRIPLUS_AMAZON_TEST_PDF para ejecutar esta prueba con las facturas reales.");
}

const [iherbBytes, amazonBytes] = await Promise.all([readFile(iherbPath), readFile(amazonPath)]);
const DB = new LocalD1Database();
const BUCKET = new LocalR2Bucket();
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("real-invoice-ai", `${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
const env = {
  DB,
  BUCKET,
  OPENAI_API_KEY: ["sk", "test", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-"),
  INVOICE_AI_ENABLED: "true",
  INVOICE_AI_MODEL: "gpt-5.6-terra",
  INVOICE_AI_MONTHLY_LIMIT_USD: "10",
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  IMAGES: { input() { throw new Error("Images are not used in this test."); } },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function workerRequest(path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("accept", "application/json");
  headers.set("oai-authenticated-user-email", "pruebas@nutriplus.test");
  if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  return worker.fetch(new Request(`http://local.test${path}`, { ...init, headers }), env, ctx);
}

async function callJson(path, init = {}) {
  const response = await workerRequest(path, init);
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(`La ruta ${path} devolvió contenido no JSON (${response.status}): ${raw.slice(0, 300)}`); }
  return { response, body };
}

function evidence(field, value, page = 1, confidence = 98, source = "invoice_visual") {
  return { field, value, confidence, page, source };
}

const validBarcodes = ["036000291452", "4006381333931", "5901234123457", "5012345678900"];

function product({ index, name, brand, presentation, size, quantity, secondaryId, provider, sourceUrl }) {
  return {
    line_key: `${provider}-${index + 1}`,
    page: 1,
    confidence: 96,
    original_description: name,
    name,
    brand,
    presentation,
    size,
    flavor: "",
    concentration: "",
    package_units: 1,
    quantity,
    iherb_code: provider === "iherb" ? secondaryId : "",
    asin: provider === "amazon" ? secondaryId : "",
    special_type: "normal",
    barcode: {
      value: validBarcodes[index],
      type: validBarcodes[index].length === 12 ? "UPC-A" : "EAN-13",
      confidence: 94,
      page: 0,
      source_kind: "web",
      source_title: `${brand} presentación exacta`,
      source_url: sourceUrl,
      exact_match: true,
      differences: [],
    },
    field_evidence: [
      evidence("name", name),
      evidence("brand", brand),
      evidence("presentation", presentation),
      evidence("size", size),
      evidence("quantity", String(quantity)),
      evidence(provider === "iherb" ? "iherb_code" : "asin", secondaryId, provider === "iherb" ? 1 : 0, provider === "iherb" ? 98 : 0, provider === "iherb" ? "invoice_text" : "absent"),
      evidence("barcode", validBarcodes[index], 0, 94, "web"),
    ],
  };
}

function invoiceAnalysis(provider) {
  const isIherb = provider === "iherb";
  const sources = Array.from({ length: 4 }, (_, index) => `https://catalogo.example.test/${provider}/producto-${index + 1}`);
  const products = isIherb ? [
    product({ index: 0, provider, name: "Centrum suplemento multivitamínico para mujeres", brand: "Centrum", presentation: "65 comprimidos", size: "65 tabletas", quantity: 1, secondaryId: "CEM-75565", sourceUrl: sources[0] }),
    product({ index: 1, provider, name: "NOW Foods Liquid Multi sabor bayas", brand: "NOW Foods", presentation: "16 fl oz", size: "473 ml", quantity: 1, secondaryId: "NOW-03773", sourceUrl: sources[1] }),
    product({ index: 2, provider, name: "Source Naturals Berberine", brand: "Source Naturals", presentation: "500 mg · 30 cápsulas vegetales", size: "30 cápsulas", quantity: 2, secondaryId: "SNS-02782", sourceUrl: sources[2] }),
    product({ index: 3, provider, name: "Nordic Naturals Children's DHA fresa", brand: "Nordic Naturals", presentation: "líquido sabor fresa", size: "119 ml", quantity: 1, secondaryId: "NOR-56780", sourceUrl: sources[3] }),
  ] : [
    product({ index: 0, provider, name: "Scent Fill ambientador lavanda y vainilla con difusor", brand: "Scent Fill", presentation: "2 repuestos y difusor", size: "set de 3 piezas", quantity: 1, secondaryId: "", sourceUrl: sources[0] }),
    product({ index: 1, provider, name: "Dr Green Mom ácido fólico líquido", brand: "Dr Green Mom", presentation: "500 mcg por gota", size: "1 oz", quantity: 1, secondaryId: "", sourceUrl: sources[1] }),
    product({ index: 2, provider, name: "API BIO-CHEM ZORB", brand: "API", presentation: "tamaño 6", size: "paquete de 1", quantity: 1, secondaryId: "", sourceUrl: sources[2] }),
    product({ index: 3, provider, name: "Amazon Basics gel eliminador de olores lavanda", brand: "Amazon Basics", presentation: "lavanda", size: "17 oz · paquete de 1", quantity: 1, secondaryId: "", sourceUrl: sources[3] }),
  ];
  return {
    sources,
    analysis: {
      provider,
      provider_label: isIherb ? "iHerb" : "Amazon",
      order_number: isIherb ? "945586803" : "112-7504724-5768234",
      invoice_number: "",
      document_date: isIherb ? "03 Julio 2026" : "25 de julio de 2026",
      shipment_number: isIherb ? "1LSCXLZ0066WJ4P" : "",
      document_type: "purchase",
      metadata_evidence: [
        evidence("provider", isIherb ? "iHerb" : "Amazon"),
        evidence("order_number", isIherb ? "945586803" : "112-7504724-5768234"),
        evidence("document_date", isIherb ? "03 Julio 2026" : "25 de julio de 2026"),
        evidence("shipment_number", isIherb ? "1LSCXLZ0066WJ4P" : "", isIherb ? 1 : 0, isIherb ? 98 : 0, isIherb ? "invoice_text" : "absent"),
      ],
      products,
    },
  };
}

let openAiCalls = 0;
let failNextCall = false;
let invalidNextCall = false;
let semanticReviewNextCall = false;
const requestedModels = [];
globalThis.__NUTRIPLUS_INVOICE_AI_TEST_FETCH__ = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== "https://api.openai.com/v1/responses") throw new Error(`Unexpected AI test URL: ${url}`);
  openAiCalls += 1;
  const requestBody = JSON.parse(String(init?.body || "{}"));
  requestedModels.push(requestBody.model);
  if (failNextCall) {
    failNextCall = false;
    return Response.json({ error: { type: "server_error", code: "server_error" } }, { status: 503 });
  }
  assert.equal(requestBody.tools[0].type, "web_search");
  assert.equal(requestBody.text.format.type, "json_schema");
  assert.equal(requestBody.text.format.strict, true);
  const fileInputs = requestBody.input[0].content.filter((item) => item.type === "input_file");
  assert.equal(fileInputs.length, 1);
  assert.match(fileInputs[0].file_data, /^data:application\/pdf;base64,JVBER/);
  assert.equal(fileInputs[0].detail, "high");
  const provider = /iherb/i.test(fileInputs[0].filename) ? "iherb" : "amazon";
  const { analysis, sources } = invoiceAnalysis(provider);
  if (semanticReviewNextCall) {
    semanticReviewNextCall = false;
    analysis.products[0].package_units = 3;
  }
  if (invalidNextCall) {
    invalidNextCall = false;
    return Response.json({
      id: `resp-test-${openAiCalls}`,
      model: "gpt-5.6-terra-2026-08-01",
      status: "completed",
      output: [{ id: "message-invalid", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "{resultado-incompleto", annotations: [] }] }],
      usage: { input_tokens: 10_000, input_tokens_details: { cached_tokens: 2_000 }, output_tokens: 100, total_tokens: 10_100 },
    });
  }
  return Response.json({
    id: `resp-test-${openAiCalls}`,
    model: requestBody.model === "gpt-5.6-sol" ? "gpt-5.6-sol-2026-08-01" : "gpt-5.6-terra-2026-08-01",
    status: "completed",
    output: [
      ...sources.map((sourceUrl, index) => ({
        id: `ws-${index + 1}`,
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: `${provider} producto ${index + 1} UPC`, sources: [{ type: "url", url: sourceUrl }] },
      })),
      { id: "message-1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(analysis), annotations: [] }] },
    ],
    usage: { input_tokens: 10_000, input_tokens_details: { cached_tokens: 2_000 }, output_tokens: 2_000, total_tokens: 12_000 },
  });
};

async function uploadPdf(path, bytes, mode) {
  const form = new FormData();
  form.set("mode", mode);
  form.append("files", new File([bytes], basename(path), { type: "application/pdf" }));
  return callJson("/api/inventory-intake", { method: "POST", body: form });
}

try {
  await callJson("/api/settings");

  const amazonFileSha = createHash("sha256").update(amazonBytes).digest("hex");
  const amazonFingerprint = createHash("sha256").update(`0:${amazonFileSha}`).digest("hex");
  const amazonLegacy = await callJson("/api/inventory-intake", {
    method: "POST",
    body: JSON.stringify({
      fingerprint: amazonFingerprint,
      fileName: basename(amazonPath),
      mimeTypes: ["application/pdf"],
      pages: [{ pageNumber: 1, text: "Amazon · borrador legado sin archivo", confidence: 80, source: "ocr" }],
      warnings: ["No se encontró el archivo guardado. Podés continuar agregando los productos manualmente."],
    }),
  });
  assert.equal(amazonLegacy.response.status, 201);
  assert.equal(amazonLegacy.body.document.fileCount, 0);
  assert.equal(amazonLegacy.body.files.length, 0);

  const amazonManual = await uploadPdf(amazonPath, amazonBytes, "manual");
  assert.equal(amazonManual.response.status, 200);
  assert.equal(amazonManual.body.resumed, true);
  assert.equal(amazonManual.body.document.id, amazonLegacy.body.document.id);
  assert.equal(amazonManual.body.document.processingMode, "manual");
  assert.equal(amazonManual.body.document.fileCount, 1);
  assert.equal(amazonManual.body.files.length, 1);
  assert.equal(openAiCalls, 0);
  const amazonView = await workerRequest(amazonManual.body.files[0].viewUrl);
  assert.equal(amazonView.status, 200);
  assert.deepEqual(Buffer.from(await amazonView.arrayBuffer()), amazonBytes);

  // The local stub deliberately mirrors the Responses API contract while the
  // PDF fixtures may be synthetic. A separately authorized invocation can
  // point these variables at the user's real invoices without changing code.

  const amazonAi = await callJson(`/api/inventory-intake/${amazonManual.body.document.id}/reanalyze`, {
    method: "POST",
    body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(amazonAi.response.status, 200, JSON.stringify(amazonAi.body));
  assert.equal(amazonAi.body.document.orderNumber, "112-7504724-5768234");
  assert.equal(amazonAi.body.lines.length, 4);
  assert.equal(amazonAi.body.analysis.webSearchCount, 4);
  assert.ok(amazonAi.body.analysis.estimatedCostUsd > 0);
  assert.equal(amazonAi.body.analysis.reviewRequired, false);
  assert.equal(requestedModels.at(-1), "gpt-5.6-terra");

  const iherbAi = await uploadPdf(iherbPath, iherbBytes, "ai");
  assert.equal(iherbAi.response.status, 201);
  assert.equal(iherbAi.body.document.orderNumber, "945586803");
  assert.equal(iherbAi.body.document.shipmentNumber, "1LSCXLZ0066WJ4P");
  assert.deepEqual(iherbAi.body.lines.map((line) => line.billedQuantity), [1, 1, 2, 1]);
  assert.deepEqual(iherbAi.body.lines.map((line) => line.secondaryId), ["CEM-75565", "NOW-03773", "SNS-02782", "NOR-56780"]);
  assert.ok(iherbAi.body.lines.every((line) => line.barcodeSourceUrl.startsWith("https://catalogo.example.test/")));
  assert.equal(iherbAi.body.analysis.reviewRequired, false);
  assert.equal(requestedModels.at(-1), "gpt-5.6-terra");
  const iherbView = await workerRequest(iherbAi.body.files[0].viewUrl, { headers: { range: "bytes=0-31" } });
  assert.equal(iherbView.status, 206);
  assert.equal((await iherbView.arrayBuffer()).byteLength, 32);

  const callsBeforeCache = openAiCalls;
  const cachedIherb = await uploadPdf(iherbPath, iherbBytes, "ai");
  assert.equal(cachedIherb.response.status, 200);
  assert.equal(cachedIherb.body.cachedAnalysis, true);
  assert.equal(openAiCalls, callsBeforeCache);

  const callsBeforeUnconfirmedSol = openAiCalls;
  const unconfirmedSol = await callJson(`/api/inventory-intake/${iherbAi.body.document.id}/reanalyze`, {
    method: "POST",
    body: JSON.stringify({ confirmed: false, model: "sol" }),
  });
  assert.equal(unconfirmedSol.response.status, 400);
  assert.equal(openAiCalls, callsBeforeUnconfirmedSol);

  const iherbReanalysis = await callJson(`/api/inventory-intake/${iherbAi.body.document.id}/reanalyze`, {
    method: "POST",
    body: JSON.stringify({ confirmed: true, model: "sol" }),
  });
  assert.equal(iherbReanalysis.response.status, 200);
  assert.equal(iherbReanalysis.body.analysis.reanalysis, true);
  assert.match(iherbReanalysis.body.analysis.model, /^gpt-5\.6-sol/);
  assert.equal(requestedModels.at(-1), "gpt-5.6-sol");
  assert.equal(iherbReanalysis.body.analyses.length, 2);
  assert.match(iherbReanalysis.body.analyses[0].model, /^gpt-5\.6-terra/);
  assert.match(iherbReanalysis.body.analyses[1].model, /^gpt-5\.6-sol/);
  assert.ok(iherbReanalysis.body.analyses[0].estimatedCostUsd > 0);
  assert.ok(iherbReanalysis.body.analyses[1].estimatedCostUsd > iherbReanalysis.body.analyses[0].estimatedCostUsd);
  assert.ok(Math.abs(
    iherbReanalysis.body.analysis.cumulativeCostUsd
      - iherbReanalysis.body.analyses.reduce((total, item) => total + item.estimatedCostUsd, 0),
  ) < 0.000001);
  assert.equal(openAiCalls, callsBeforeCache + 1);

  semanticReviewNextCall = true;
  const semanticReviewAmazon = await callJson(`/api/inventory-intake/${amazonManual.body.document.id}/reanalyze`, {
    method: "POST",
    body: JSON.stringify({ confirmed: true, model: "primary" }),
  });
  assert.equal(semanticReviewAmazon.response.status, 200);
  assert.equal(semanticReviewAmazon.body.manualFallback, false);
  assert.equal(semanticReviewAmazon.body.reviewRequired, true);
  assert.equal(semanticReviewAmazon.body.document.processingMode, "ai");
  assert.equal(semanticReviewAmazon.body.document.analysisStatus, "review_required");
  assert.equal(semanticReviewAmazon.body.analysis.status, "review_required");
  assert.equal(semanticReviewAmazon.body.analysis.reviewRequired, true);
  assert.match(semanticReviewAmazon.body.analysis.errorMessage, /set con componentes distintos/);
  assert.equal(semanticReviewAmazon.body.lines[0].unitsPerPackage, 3);

  const callsBeforeReviewCache = openAiCalls;
  const cachedReviewAmazon = await uploadPdf(amazonPath, amazonBytes, "ai");
  assert.equal(cachedReviewAmazon.response.status, 200);
  assert.equal(cachedReviewAmazon.body.cachedAnalysis, true);
  assert.equal(cachedReviewAmazon.body.document.analysisStatus, "review_required");
  assert.equal(openAiCalls, callsBeforeReviewCache);

  invalidNextCall = true;
  const reviewRequiredAmazon = await callJson(`/api/inventory-intake/${amazonManual.body.document.id}/reanalyze`, {
    method: "POST",
    body: JSON.stringify({ confirmed: true, model: "primary" }),
  });
  assert.equal(reviewRequiredAmazon.response.status, 200);
  assert.equal(reviewRequiredAmazon.body.manualFallback, false);
  assert.equal(reviewRequiredAmazon.body.reviewRequired, true);
  assert.equal(reviewRequiredAmazon.body.document.processingMode, "ai");
  assert.equal(reviewRequiredAmazon.body.document.analysisStatus, "review_required");
  assert.equal(reviewRequiredAmazon.body.analysis.status, "review_required");
  assert.equal(reviewRequiredAmazon.body.analysis.reviewRequired, true);
  assert.equal(reviewRequiredAmazon.body.lines.length, 4);
  assert.equal(reviewRequiredAmazon.body.analyses.length, 3);

  failNextCall = true;
  const failedAmazonReanalysis = await callJson(`/api/inventory-intake/${amazonManual.body.document.id}/reanalyze`, {
    method: "POST",
    body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(failedAmazonReanalysis.response.status, 202);
  assert.equal(failedAmazonReanalysis.body.manualFallback, true);
  assert.equal(failedAmazonReanalysis.body.document.processingMode, "manual");
  assert.equal(failedAmazonReanalysis.body.lines.length, 4);
  assert.equal(requestedModels.at(-1), "gpt-5.6-terra");
  const callsAfterFailure = openAiCalls;
  const noAutomaticRetry = await uploadPdf(amazonPath, amazonBytes, "ai");
  assert.equal(noAutomaticRetry.response.status, 200);
  assert.equal(noAutomaticRetry.body.manualFallback, true);
  assert.equal(openAiCalls, callsAfterFailure);

  const products = await callJson("/api/products?limit=1000");
  assert.equal(products.body.products.length, 0);
  const operations = await DB.prepare("SELECT COUNT(*) AS total FROM inventory_operations").first();
  const movements = await DB.prepare("SELECT COUNT(*) AS total FROM inventory_movements").first();
  assert.equal(Number(operations.total), 0);
  assert.equal(Number(movements.total), 0);
  const usage = await callJson("/api/inventory-intake/config");
  assert.equal(usage.body.billedAnalyses, 5);
  assert.ok(usage.body.cumulativeCostUsd > 0);

  console.log("Real iHerb/Amazon PDFs: storage, full-file AI contract, web sources, cache, reanalysis, failover, and zero inventory writes passed");
} finally {
  delete globalThis.__NUTRIPLUS_INVOICE_AI_TEST_FETCH__;
  DB.close();
}
