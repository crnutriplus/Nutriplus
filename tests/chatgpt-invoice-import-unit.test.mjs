import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { zipSync } from "fflate";
import { parseChatGptInvoiceImport } from "../lib/chatgpt-invoice-import.ts";

const encoder = new TextEncoder();
const pdf = encoder.encode("%PDF-1.4\n% NutriPlus ChatGPT import fixture\n%%EOF");
const pdfSha256 = createHash("sha256").update(pdf).digest("hex");

function analysis(overrides = {}) {
  const value = {
    schema: "nutriplus.invoice_import",
    schema_version: "1.0",
    analysis_origin: "CHATGPT_IMPORT",
    source: { file_name: "fixture.pdf", sha256: pdfSha256, page_count: 1 },
    invoice: {
      supplier: "iHerb",
      purchase_number: "TEST-100",
      invoice_number: null,
      purchase_date: "2026-07-03",
      tracking_number: "TRACK-100",
      currency: "USD",
      subtotal: 12.34,
      shipping: 0,
      tax: 0,
      total: 12.34,
      line_count: 1,
      inventory_units: 2,
    },
    products: [{
      line_number: 1,
      brand: "NOW Foods",
      name: "Producto de prueba",
      presentation: "60 cápsulas",
      size: "60 cápsulas",
      flavor: null,
      strength: "100 mg",
      quantity: 2,
      unit_price: 6.67,
      discount_total: 1,
      line_subtotal: 12.34,
      supplier_sku: "NOW-TEST",
      identifiers: { upc_gtin12: "036000291452", iherb_product_id: "12345" },
      provenance: { upc_gtin12: "invoice" },
      review_status: "READY",
    }],
    validation: {
      line_subtotals_sum: 12.34,
      invoice_total_matches_lines: true,
      all_quantities_present: true,
    },
  };
  return Object.assign(value, overrides);
}

function packageFile(value = analysis(), entries = {}) {
  const archive = zipSync({
    "invoice.pdf": pdf,
    "analysis.json": encoder.encode(JSON.stringify(value)),
    ...entries,
  });
  return new File([archive], "NutriPlus_TEST-100.zip", { type: "application/zip" });
}

test("validates a ChatGPT package and converts it to the existing draft contract", async () => {
  const result = await parseChatGptInvoiceImport(packageFile());
  assert.equal(result.analysis.analysis_origin, "CHATGPT_IMPORT");
  assert.equal(result.parsedInvoice.status, "draft");
  assert.equal(result.parsedInvoice.provider, "iherb");
  assert.equal(result.parsedInvoice.orderNumber, "TEST-100");
  assert.equal(result.parsedInvoice.lines.length, 1);
  assert.equal(result.parsedInvoice.lines[0].billedQuantity, 2);
  assert.equal(result.parsedInvoice.lines[0].barcode, "036000291452");
  assert.equal(result.parsedInvoice.lines[0].barcodeMethod, "chatgpt_import");
  assert.equal(result.summary.total, 12.34);
  assert.equal(result.summary.inventoryUnits, 2);
  assert.equal(result.summary.sourceSha256, pdfSha256);
  assert.equal(result.reviewRequired, false);
});

test("blocks a package when source.sha256 does not match invoice.*", async () => {
  const value = analysis();
  value.source.sha256 = "0".repeat(64);
  await assert.rejects(
    parseChatGptInvoiceImport(packageFile(value)),
    (error) => error?.code === "CHATGPT_HASH_MISMATCH" && /no corresponde a la factura/.test(error.message),
  );
});

test("recalculates totals instead of trusting the validation block", async () => {
  const value = analysis();
  value.invoice.subtotal = 12.35;
  value.invoice.total = 12.35;
  value.validation.line_subtotals_sum = 12.35;
  value.validation.invoice_total_matches_lines = true;
  await assert.rejects(
    parseChatGptInvoiceImport(packageFile(value)),
    (error) => error?.code === "CHATGPT_TOTAL_INCONSISTENT" && /total calculado de los productos/.test(error.message),
  );
});

test("blocks paths, extra files and executable-shaped package contents before extraction", async () => {
  await assert.rejects(
    parseChatGptInvoiceImport(packageFile(analysis(), { "../payload.exe": encoder.encode("MZ") })),
    (error) => error?.code === "CHATGPT_ZIP_INVALID" && /rutas o carpetas no permitidas|archivos adicionales/.test(error.message),
  );
});

test("distinguishes missing analysis, missing invoice, multiple invoices and unsupported schema versions", async () => {
  const onlyInvoice = zipSync({ "invoice.pdf": pdf });
  await assert.rejects(
    parseChatGptInvoiceImport(new File([onlyInvoice], "missing-analysis.zip", { type: "application/zip" })),
    (error) => error?.code === "CHATGPT_ANALYSIS_MISSING",
  );

  const onlyAnalysis = zipSync({ "analysis.json": encoder.encode(JSON.stringify(analysis())) });
  await assert.rejects(
    parseChatGptInvoiceImport(new File([onlyAnalysis], "missing-invoice.zip", { type: "application/zip" })),
    (error) => error?.code === "CHATGPT_INVOICE_MISSING",
  );

  const multipleInvoices = packageFile(analysis(), { "invoice.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
  await assert.rejects(parseChatGptInvoiceImport(multipleInvoices), (error) => error?.code === "CHATGPT_MULTIPLE_INVOICES");

  const unsupported = analysis();
  unsupported.schema_version = "2.0";
  await assert.rejects(parseChatGptInvoiceImport(packageFile(unsupported)), (error) => error?.code === "CHATGPT_SCHEMA_UNSUPPORTED");
});

test("returns actionable codes for invalid ZIP, JSON and quantities", async () => {
  await assert.rejects(
    parseChatGptInvoiceImport(new File([encoder.encode("not a zip")], "broken.zip", { type: "application/zip" })),
    (error) => error?.code === "CHATGPT_ZIP_INVALID" && /No pudimos abrir/.test(error.message),
  );

  const invalidJson = zipSync({ "invoice.pdf": pdf, "analysis.json": encoder.encode("{not-json") });
  await assert.rejects(
    parseChatGptInvoiceImport(new File([invalidJson], "invalid-json.zip", { type: "application/zip" })),
    (error) => error?.code === "CHATGPT_ANALYSIS_JSON_INVALID",
  );

  const invalidQuantity = analysis();
  invalidQuantity.products[0].quantity = 0;
  await assert.rejects(
    parseChatGptInvoiceImport(packageFile(invalidQuantity)),
    (error) => error?.code === "INVENTORY_INVALID_QUANTITY" && /Producto de prueba/.test(error.message),
  );
});
