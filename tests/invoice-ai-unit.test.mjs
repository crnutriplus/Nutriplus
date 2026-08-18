import assert from "node:assert/strict";
import test from "node:test";
import {
  assessInvoiceAnalysis,
  DEFAULT_INVOICE_AI_MODEL,
  estimateInvoiceAiCostMicrousd,
  invoiceAiConfig,
  parsedInvoiceFromAi,
  SOL_INVOICE_AI_MODEL,
} from "../lib/invoice-ai.ts";

function evidence(field, value, page = 1, confidence = 95, source = "invoice_visual") {
  return { field, value, page, confidence, source };
}

test("estimates model, cached-token, output, and web-search consumption", () => {
  assert.equal(estimateInvoiceAiCostMicrousd("gpt-5.6-terra-2026-08-01", 10_000, 2_000, 2_000, 4), 80_400);
  assert.equal(estimateInvoiceAiCostMicrousd("gpt-5.6-terra", 0, 0, 0, 0), 0);
  assert.equal(estimateInvoiceAiCostMicrousd(SOL_INVOICE_AI_MODEL, 10_000, 2_000, 2_000, 4), 141_000);
});

test("uses the server model setting and defaults exclusively to Terra", () => {
  const previous = globalThis.__NUTRIPLUS_INVOICE_AI_MODEL__;
  try {
    delete globalThis.__NUTRIPLUS_INVOICE_AI_MODEL__;
    assert.equal(invoiceAiConfig().model, DEFAULT_INVOICE_AI_MODEL);
    globalThis.__NUTRIPLUS_INVOICE_AI_MODEL__ = "server-configured-model";
    assert.equal(invoiceAiConfig().model, "server-configured-model");
  } finally {
    if (previous === undefined) delete globalThis.__NUTRIPLUS_INVOICE_AI_MODEL__;
    else globalThis.__NUTRIPLUS_INVOICE_AI_MODEL__ = previous;
  }
});

test("marks incomplete or inconsistent Terra output for review without discarding it", () => {
  const analysis = {
    provider: "iherb",
    provider_label: "iHerb",
    order_number: "945586803",
    invoice_number: "",
    document_date: "2026-07-03",
    shipment_number: "1LSCXLZ0066WJ4P",
    document_type: "purchase",
    metadata_evidence: [],
    products: [{
      line_key: "line-1",
      page: 1,
      confidence: 95,
      original_description: "NOW Foods Liquid Multi",
      name: "NOW Foods Liquid Multi",
      brand: "NOW Foods",
      presentation: "líquido",
      size: "473 ml",
      flavor: "bayas",
      concentration: "",
      package_units: 1,
      quantity: 1,
      iherb_code: "NOW-03773",
      asin: "",
      special_type: "normal",
      barcode: { value: "733739037732", type: "UPC-A", confidence: 94, page: 0, source_kind: "web", source_title: "NOW Foods", source_url: "https://example.test/now", exact_match: true, differences: [] },
      field_evidence: [evidence("iherb_code", "NOW-03773", 1, 98, "invoice_text")],
    }],
  };
  assert.deepEqual(assessInvoiceAnalysis(analysis), { reviewRequired: false, issues: [] });
  const incomplete = structuredClone(analysis);
  incomplete.products[0].brand = "";
  incomplete.products[0].quantity = 0;
  const quality = assessInvoiceAnalysis(incomplete);
  assert.equal(quality.reviewRequired, true);
  assert.match(quality.issues.join(" "), /marca verificable/);
  assert.match(quality.issues.join(" "), /cantidad válida/);
});

test("accepts evidenced Amazon ASINs and reviews unsupported ASINs, missing barcodes, and heterogeneous kits", () => {
  const analysis = {
    provider: "amazon",
    provider_label: "Amazon",
    order_number: "112-7504724-5768234",
    invoice_number: "",
    document_date: "2026-07-25",
    shipment_number: "",
    document_type: "purchase",
    metadata_evidence: [],
    products: [
      {
        line_key: "amazon-1",
        page: 1,
        confidence: 95,
        original_description: "Scent Fill 2 recargas + difusor",
        name: "Scent Fill ambientador",
        brand: "Scent Fill",
        presentation: "Kit de 2 recargas + difusor",
        size: "1.35 fl oz",
        flavor: "lavanda y vainilla",
        concentration: "",
        package_units: 3,
        quantity: 1,
        iherb_code: "",
        asin: "B0CS51YRDL",
        special_type: "normal",
        barcode: { value: "850012304524", type: "UPC-A", confidence: 90, page: 0, source_kind: "web", source_title: "Web", source_url: "https://example.test/scent", exact_match: true, differences: [] },
        field_evidence: [evidence("asin", "B0CS51YRDL", 0, 80, "web")],
      },
      {
        line_key: "amazon-2",
        page: 1,
        confidence: 95,
        original_description: "Dr Green Mom 1 oz",
        name: "Ácido folínico",
        brand: "Dr. Green Mom",
        presentation: "gotas",
        size: "1 fl oz",
        flavor: "",
        concentration: "500 mcg",
        package_units: 1,
        quantity: 1,
        iherb_code: "",
        asin: "",
        special_type: "normal",
        barcode: { value: "", type: "", confidence: 0, page: 0, source_kind: "pending", source_title: "", source_url: "", exact_match: false, differences: [] },
        field_evidence: [],
      },
    ],
  };
  const quality = assessInvoiceAnalysis(analysis);
  assert.equal(quality.reviewRequired, true);
  assert.match(quality.issues.join(" "), /set con componentes distintos/);
  assert.doesNotMatch(quality.issues.join(" "), /ASIN sin evidencia verificable/);
  assert.match(quality.issues.join(" "), /no tiene un UPC, EAN o GTIN verificable/);

  const unsupported = structuredClone(analysis);
  unsupported.products[0].field_evidence = [];
  const unsupportedQuality = assessInvoiceAnalysis(unsupported);
  assert.match(unsupportedQuality.issues.join(" "), /ASIN sin evidencia verificable/);
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
