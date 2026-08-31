import assert from "node:assert/strict";
import test from "node:test";
import { resolveParsedLine } from "../lib/inventory-intake.ts";

function parsedLine(overrides = {}) {
  return {
    lineKey: "line-1",
    pageNumber: 1,
    originalDescription: "Gomitas masticables con DHA para niños",
    name: "Gomitas masticables con DHA para niños",
    brand: "Nordic Naturals",
    presentation: "30 gomitas",
    size: "30 gomitas",
    flavor: "",
    concentration: "355 mg",
    billedQuantity: 1,
    receivedQuantity: 1,
    unitsPerPackage: 1,
    barcode: "",
    secondaryId: "NOR-01709",
    secondaryType: "iherb",
    barcodeMethod: "invoice",
    barcodeSource: "Factura",
    barcodeSourceUrl: "",
    barcodeSourceTitle: "",
    barcodeDifferences: [],
    barcodeLookupStatus: "pending",
    confidence: 95,
    fieldEvidence: {},
    warnings: [],
    specialType: "",
    ...overrides,
  };
}

const nordic = {
  id: 7,
  name: "Omega 3 gomitas Nordic Naturals 30 gomitas",
  code: "036000291452",
  brand: "Nordic Naturals",
  presentation: "30 gomitas",
  quantity_available: 4,
  minimum_stock: 2,
  minimum_stock_enabled: 1,
};

test("supplier + SKU exact beats a different invoice description", () => {
  const resolved = resolveParsedLine({
    id: "line-sku",
    line: parsedLine(),
    provider: "iherb",
    products: [nordic],
    quotes: [],
    aliases: [{ provider: "iherb", secondary_type: "iherb", secondary_id: "NOR-01709", barcode: "036000291452", canonical_barcode: "0036000291452", product_id: 7, description_signature: "", presentation_signature: "", units_per_package: 1, barcode_level: "unit" }],
  });
  assert.equal(resolved.status, "confirmed");
  assert.equal(resolved.action, "existing");
  assert.equal(resolved.matchProductId, 7);
  assert.equal(resolved.match?.name, nordic.name);
  assert.equal(resolved.match?.matchReason, "supplier_sku");
  assert.equal(resolved.suggestions[0]?.id, 7);
  assert.equal(resolved.suggestions[0]?.matchReason, "supplier_sku");
});

test("an exact barcode is canonical even when the invoice name is unrelated", () => {
  const resolved = resolveParsedLine({
    id: "line-barcode",
    line: parsedLine({ name: "Texto de factura completamente distinto", originalDescription: "Texto de factura completamente distinto", secondaryId: "", secondaryType: "", barcode: "036000291452" }),
    provider: "iherb",
    products: [nordic],
    quotes: [],
    aliases: [],
  });
  assert.equal(resolved.status, "confirmed");
  assert.equal(resolved.matchProductId, 7);
  assert.equal(resolved.match?.matchReason, "barcode");
  assert.equal(resolved.suggestions[0]?.id, 7);
  assert.equal(resolved.suggestions[0]?.matchReason, "barcode");
});

test("an orphaned supplier SKU remains invoice evidence and cannot block an exact canonical product", () => {
  const resolved = resolveParsedLine({
    id: "line-orphaned-sku",
    line: parsedLine({
      name: "JoySpring Calmify",
      originalDescription: "JoySpring · Calmify, Magnesio líquido · 30 ml",
      secondaryId: "JYS-88993",
      secondaryType: "other",
      barcode: "850008889936",
    }),
    provider: "iherb",
    products: [{
      id: 49,
      name: "JoySpring Calmify",
      code: "850008889936",
      brand: "JoySpring",
      presentation: "30 ml",
      quantity_available: 0,
      minimum_stock: 1,
      minimum_stock_enabled: 1,
    }],
    quotes: [],
    aliases: [{ provider: "iherb", secondary_type: "other", secondary_id: "JYS-88993", barcode: "078742040370", canonical_barcode: "00078742040370", product_id: 1171, description_signature: "calmify liquido magnesio", presentation_signature: "1 oz|30 ml", units_per_package: 1, barcode_level: "unit" }],
  });
  assert.equal(resolved.status, "confirmed");
  assert.equal(resolved.action, "existing");
  assert.equal(resolved.matchProductId, 49);
  assert.equal(resolved.match?.matchReason, "barcode");
  assert.match(resolved.warnings.join(" "), /asociación histórica/i);
});
