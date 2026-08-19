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
    (error) => error?.message === "El análisis no corresponde a la factura incluida en este paquete.",
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
    /invoice\.subtotal no coincide con la suma recalculada/,
  );
});

test("blocks paths, extra files and executable-shaped package contents before extraction", async () => {
  await assert.rejects(
    parseChatGptInvoiceImport(packageFile(analysis(), { "../payload.exe": encoder.encode("MZ") })),
    /rutas o carpetas no permitidas|analysis\.json y exactamente una factura/,
  );
});
