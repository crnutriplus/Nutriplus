import assert from "node:assert/strict";
import test from "node:test";
import { estimateInvoiceAiCostMicrousd, parsedInvoiceFromAi } from "../lib/invoice-ai.ts";

function evidence(field, value, page = 1, confidence = 95, source = "invoice_visual") {
  return { field, value, page, confidence, source };
}

test("estimates model, cached-token, output, and web-search consumption", () => {
  assert.equal(estimateInvoiceAiCostMicrousd("gpt-5.6-terra-2026-08-01", 10_000, 2_000, 2_000, 4), 60_200);
  assert.equal(estimateInvoiceAiCostMicrousd("gpt-5.6-terra", 0, 0, 0, 0), 0);
});

test("keeps UPC as primary and Amazon ASIN as a secondary identifier", () => {
  const parsed = parsedInvoiceFromAi({
    provider: "amazon",
    provider_label: "Amazon",
    order_number: "112-7504724-5768234",
    invoice_number: "",
    document_date: "25 de julio de 2026",
    shipment_number: "",
    document_type: "purchase",
    metadata_evidence: [evidence("order_number", "112-7504724-5768234")],
    products: [{
      line_key: "amazon-1",
      page: 1,
      confidence: 96,
      original_description: "Test Vitamin C 30 tablets",
      name: "Test Vitamin C",
      brand: "Test",
      presentation: "30 tablets",
      size: "30 tablets",
      flavor: "",
      concentration: "",
      package_units: 1,
      quantity: 2,
      iherb_code: "",
      asin: "B012345678",
      special_type: "normal",
      barcode: {
        value: "036000291452",
        type: "UPC-A",
        confidence: 94,
        page: 0,
        source_kind: "web",
        source_title: "Exact presentation",
        source_url: "https://catalogo.example.test/vitamin-c",
        exact_match: true,
        differences: [],
      },
      field_evidence: [evidence("name", "Test Vitamin C"), evidence("barcode", "036000291452", 0, 94, "web")],
    }],
  });
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].barcode, "036000291452");
  assert.equal(parsed.lines[0].secondaryType, "asin");
  assert.equal(parsed.lines[0].secondaryId, "B012345678");
  assert.equal(parsed.lines[0].barcodeLookupStatus, "found_exact");
  assert.equal(parsed.lines[0].barcodeSourceUrl, "https://catalogo.example.test/vitamin-c");
  assert.equal(parsed.lines[0].billedQuantity, 2);
});

test("filters charges and blocks credit notes from becoming purchase drafts", () => {
  const parsed = parsedInvoiceFromAi({
    provider: "other",
    provider_label: "Store",
    order_number: "ORDER-1",
    invoice_number: "CREDIT-1",
    document_date: "2026-08-12",
    shipment_number: "",
    document_type: "credit_note",
    metadata_evidence: [],
    products: [{
      line_key: "charge-1",
      page: 1,
      confidence: 90,
      original_description: "Shipping",
      name: "Shipping",
      brand: "",
      presentation: "",
      size: "",
      flavor: "",
      concentration: "",
      package_units: 1,
      quantity: 1,
      iherb_code: "",
      asin: "",
      special_type: "charge",
      barcode: { value: "", type: "", confidence: 0, page: 0, source_kind: "pending", source_title: "", source_url: "", exact_match: false, differences: [] },
      field_evidence: [],
    }],
  });
  assert.equal(parsed.status, "credit_note");
  assert.equal(parsed.lines.length, 0);
});
