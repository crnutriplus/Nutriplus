import { validateBarcode } from "./barcodes";
import { normalizeName } from "./pricing";
import type { ParsedInvoiceLine } from "./invoice-parser";

export type IntakeLineStatus =
  | "confirmed"
  | "requires_confirm_code"
  | "requires_select_product"
  | "requires_conversion"
  | "new_product"
  | "non_inventory"
  | "pending_receive"
  | "ignored"
  | "conflict_identifiers"
  | "processed";

export type IntakeMatch = {
  source: "inventory" | "no_inventory";
  id: number;
  name: string;
  code: string | null;
  quantityAvailable: number | null;
};

export type IntakeLineDto = {
  id: string;
  lineKey: string;
  pageNumber: number | null;
  originalDescription: string;
  name: string;
  brand: string;
  presentation: string;
  size: string;
  flavor: string;
  concentration: string;
  billedQuantity: number | null;
  receivedQuantity: number | null;
  unitsPerPackage: number;
  totalToAdd: number;
  barcode: string;
  canonicalBarcode: string;
  barcodeType: string;
  secondaryId: string;
  secondaryType: string;
  barcodeMethod: string;
  barcodeSource: string;
  barcodeSourceUrl: string;
  barcodeSourceTitle: string;
  barcodeDifferences: string[];
  barcodeLookupStatus: "found_exact" | "suggestion" | "pending";
  barcodeConfirmed: boolean;
  selectedForIngress: boolean;
  reviewSavedAt: string;
  confidence: number;
  fieldEvidence: Record<string, { value: string; confidence: number; page: number; source: string }>;
  status: IntakeLineStatus;
  action: "existing" | "move" | "create" | "ignore" | "pending";
  barcodeLevel: "unit" | "package" | "distribution" | "set" | "";
  matchProductId: number | null;
  matchNonInventoryId: number | null;
  match: IntakeMatch | null;
  suggestions: IntakeMatch[];
  warnings: string[];
  processedOperationId: string;
  originalQuantity?: number;
  activeQuantity?: number;
  availableQuantity?: number;
  reversedQuantity?: number;
  hasReversals?: boolean;
  progressInconsistent?: boolean;
  isOriginalLine?: boolean;
  movementHistory?: Array<{
    id: string;
    operationId: string;
    documentLineId: string;
    operationType: string;
    reversalOf: string;
    originalMovementId: string;
    productId: number;
    productName: string;
    barcode: string;
    previousQuantity: number;
    quantityChange: number;
    resultingQuantity: number;
    reason: string;
    confirmedBy: string;
    confirmedAt: string;
  }>;
};

type ProductIdentityRow = Record<string, unknown> & {
  id: number;
  name: string;
  code: string | null;
  quantity_available?: number;
};

type AliasRow = Record<string, unknown> & {
  provider: string;
  secondary_type: string;
  secondary_id: string;
  barcode: string;
  canonical_barcode: string;
  product_id: number;
  description_signature: string;
  presentation_signature: string | null;
  units_per_package: number;
  barcode_level: string;
};

const STOP_WORDS = new Set(["the", "and", "with", "for", "of", "de", "del", "la", "el", "con", "para", "un", "una", "pack", "paquete"]);

function words(value: string) {
  return normalizeName(value).split(/[^a-z0-9]+/).filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

export function descriptionSignature(value: string) {
  return [...new Set(words(value))].sort().join(" ");
}

export function presentationSignature(...values: Array<string | null | undefined>) {
  const source = normalizeName(values.filter(Boolean).join(" "));
  const details = source.match(/\b\d+(?:[.,]\d+)?\s*(?:fl\s*oz|oz|ml|l|mg|mcg|ug|g|kg|iu|ui|%|ct|count|capsules?|capsulas?|tablets?|tabletas?|softgels?|gomitas?|gummies|servings?|porciones?|unidades?)\b/g) || [];
  const packs = source.match(/\b(?:pack|paquete|set|caja)\s*(?:of|de)?\s*\d+\b|\b\d+\s*(?:pack|paquete)\b/g) || [];
  const flavor = source.match(/\b(?:flavor|sabor)\s*[:\-]?\s*[a-z][a-z\s]{1,30}/g) || [];
  return [...new Set([...details, ...packs, ...flavor].map((value) => value.replace(/\s+/g, " ").trim()))].sort().join("|");
}

function similarity(left: string, right: string) {
  const a = new Set(words(left));
  const b = new Set(words(right));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((word) => b.has(word)).length;
  return intersection / Math.max(a.size, b.size);
}

export function descriptionsCompatible(storedDescription: string, currentDescription: string, storedPresentation = "", currentPresentation = "") {
  const leftPresentation = presentationSignature(storedDescription, storedPresentation);
  const rightPresentation = presentationSignature(currentDescription, currentPresentation);
  if (leftPresentation && rightPresentation && leftPresentation !== rightPresentation) return false;
  return similarity(storedDescription, currentDescription) >= 0.3;
}

function intakeMatch(row: ProductIdentityRow, source: IntakeMatch["source"]): IntakeMatch {
  return {
    source,
    id: Number(row.id),
    name: String(row.name),
    code: row.code ? String(row.code) : null,
    quantityAvailable: source === "inventory" ? Number(row.quantity_available ?? 0) : null,
  };
}

function canonicalMap(rows: ProductIdentityRow[]) {
  const map = new Map<string, ProductIdentityRow[]>();
  rows.forEach((row) => {
    const barcode = validateBarcode(row.code);
    if (!barcode.valid || !barcode.canonical) return;
    map.set(barcode.canonical, [...(map.get(barcode.canonical) || []), row]);
  });
  return map;
}

function suggestionsFor(line: ParsedInvoiceLine, products: ProductIdentityRow[], quotes: ProductIdentityRow[]) {
  const candidates = [
    ...products.map((row) => ({ row, source: "inventory" as const, score: similarity(line.name, String(row.name)) })),
    ...quotes.map((row) => ({ row, source: "no_inventory" as const, score: similarity(line.name, String(row.name)) })),
  ];
  return candidates.filter((candidate) => candidate.score >= 0.25)
    .sort((left, right) => right.score - left.score || String(left.row.name).localeCompare(String(right.row.name), "es"))
    .slice(0, 5)
    .map((candidate) => intakeMatch(candidate.row, candidate.source));
}

export function resolveParsedLine(args: {
  id: string;
  line: ParsedInvoiceLine;
  provider: string;
  products: ProductIdentityRow[];
  quotes: ProductIdentityRow[];
  aliases: AliasRow[];
}): IntakeLineDto {
  const { id, line, provider, products, quotes, aliases } = args;
  const warnings = [...line.warnings];
  const barcode = validateBarcode(line.barcode);
  if (line.barcode && !barcode.valid && barcode.error) warnings.push(barcode.error);
  const productByBarcode = canonicalMap(products);
  const quoteByBarcode = canonicalMap(quotes);
  const productMatches = barcode.canonical ? productByBarcode.get(barcode.canonical) || [] : [];
  const quoteMatches = barcode.canonical ? quoteByBarcode.get(barcode.canonical) || [] : [];
  const secondary = line.secondaryId
    ? aliases.find((alias) => alias.provider === provider && alias.secondary_type === line.secondaryType && alias.secondary_id.toLowerCase() === line.secondaryId.toLowerCase())
    : undefined;
  const secondaryProduct = secondary ? products.find((product) => Number(product.id) === Number(secondary.product_id)) : undefined;
  let status: IntakeLineStatus = "requires_confirm_code";
  let action: IntakeLineDto["action"] = "pending";
  let match: IntakeMatch | null = null;
  let resolvedBarcode = barcode.valid ? barcode.normalized || "" : "";
  let resolvedCanonical = barcode.valid ? barcode.canonical || "" : "";
  let barcodeType = barcode.valid ? barcode.type || "" : "";
  let unitsPerPackage = Math.max(1, line.unitsPerPackage || 1);
  let barcodeLevel: IntakeLineDto["barcodeLevel"] = "";

  if (["canceled", "refund", "return"].includes(line.specialType)) {
    status = "ignored";
    action = "ignore";
  } else if (secondary) {
    const compatible = descriptionsCompatible(secondary.description_signature, line.name, secondary.presentation_signature || "", line.presentation);
    if (!secondaryProduct || !compatible || (barcode.canonical && secondary.canonical_barcode !== barcode.canonical)) {
      status = "conflict_identifiers";
      warnings.push("El identificador del proveedor coincide con una equivalencia anterior, pero la presentación o el código cambió.");
    } else {
      match = intakeMatch(secondaryProduct, "inventory");
      status = "confirmed";
      action = "existing";
      resolvedBarcode = secondary.barcode;
      resolvedCanonical = secondary.canonical_barcode;
      barcodeType = validateBarcode(secondary.barcode).type || barcodeType;
      unitsPerPackage = Math.max(1, Number(secondary.units_per_package || unitsPerPackage));
      barcodeLevel = (secondary.barcode_level || "unit") as IntakeLineDto["barcodeLevel"];
    }
  } else if (barcode.valid && barcode.canonical) {
    if (productMatches.length + quoteMatches.length > 1) {
      status = "conflict_identifiers";
      warnings.push("Este código equivalente está asignado a más de un registro.");
    } else if (productMatches.length === 1) {
      const product = productMatches[0];
      if (!descriptionsCompatible(String(product.name), line.name, String(product.presentation || ""), line.presentation)) {
        status = "conflict_identifiers";
        warnings.push("El código coincide, pero el nombre o la presentación parecen diferentes.");
      } else {
        match = intakeMatch(product, "inventory");
        status = "confirmed";
        action = "existing";
      }
    } else if (quoteMatches.length === 1) {
      const quote = quoteMatches[0];
      if (!descriptionsCompatible(String(quote.name), line.name, "", line.presentation)) {
        status = "conflict_identifiers";
        warnings.push("El código coincide con No inventario, pero la presentación parece diferente.");
      } else {
        match = intakeMatch(quote, "no_inventory");
        status = "non_inventory";
        action = "move";
      }
    } else {
      const exactProduct = products.find((product) => normalizeName(String(product.name)) === normalizeName(line.name));
      const exactQuote = quotes.find((quote) => normalizeName(String(quote.name)) === normalizeName(line.name));
      if (exactProduct || exactQuote) {
        match = intakeMatch((exactProduct || exactQuote)!, exactProduct ? "inventory" : "no_inventory");
        status = "requires_select_product";
        action = "pending";
        warnings.push("El nombre coincide, pero debés confirmar manualmente el producto antes de asociar el código.");
      } else {
        status = "new_product";
        action = "create";
      }
    }
  }

  if (!["ignored", "conflict_identifiers"].includes(status) && (line.billedQuantity === null || line.receivedQuantity === null)) {
    status = "pending_receive";
    action = "pending";
  } else if (!["ignored", "conflict_identifiers", "requires_confirm_code", "requires_select_product", "pending_receive"].includes(status) && unitsPerPackage > 1 && !barcodeLevel) {
    status = "requires_conversion";
    action = "pending";
    warnings.push("Confirmá si el código corresponde al paquete completo o a cada unidad.");
  }

  return {
    id,
    lineKey: line.lineKey,
    pageNumber: line.pageNumber,
    originalDescription: line.originalDescription,
    name: line.name,
    brand: line.brand,
    presentation: line.presentation,
    size: line.size,
    flavor: line.flavor,
    concentration: line.concentration,
    billedQuantity: line.billedQuantity,
    receivedQuantity: line.receivedQuantity,
    unitsPerPackage,
    totalToAdd: Math.max(0, (line.receivedQuantity ?? 0) * unitsPerPackage),
    barcode: resolvedBarcode,
    canonicalBarcode: resolvedCanonical,
    barcodeType,
    secondaryId: line.secondaryId,
    secondaryType: line.secondaryType,
    barcodeMethod: line.barcodeMethod || (line.barcode ? line.barcodeSourceUrl ? "web_search" : "invoice" : secondary ? "saved_equivalence" : ""),
    barcodeSource: line.barcodeSource || (line.barcode ? line.barcodeSourceTitle || (line.barcodeSourceUrl ? "Búsqueda web" : "Factura") : secondary?.source ? String(secondary.source) : ""),
    barcodeSourceUrl: line.barcodeSourceUrl,
    barcodeSourceTitle: line.barcodeSourceTitle,
    barcodeDifferences: line.barcodeDifferences,
    barcodeLookupStatus: line.barcodeLookupStatus,
    barcodeConfirmed: false,
    selectedForIngress: action !== "ignore",
    reviewSavedAt: "",
    confidence: line.confidence,
    fieldEvidence: line.fieldEvidence,
    status,
    action,
    barcodeLevel,
    matchProductId: match?.source === "inventory" ? match.id : null,
    matchNonInventoryId: match?.source === "no_inventory" ? match.id : null,
    match,
    suggestions: suggestionsFor(line, products, quotes),
    warnings: [...new Set(warnings)],
    processedOperationId: "",
  };
}

export function lineFromRow(row: Record<string, unknown>): IntakeLineDto {
  return {
    id: String(row.id),
    lineKey: String(row.line_key),
    pageNumber: row.page_number == null ? null : Number(row.page_number),
    originalDescription: String(row.original_description),
    name: String(row.name),
    brand: row.brand ? String(row.brand) : "",
    presentation: row.presentation ? String(row.presentation) : "",
    size: row.size ? String(row.size) : "",
    flavor: row.flavor ? String(row.flavor) : "",
    concentration: row.concentration ? String(row.concentration) : "",
    billedQuantity: row.billed_quantity == null ? null : Number(row.billed_quantity),
    receivedQuantity: row.received_quantity == null ? null : Number(row.received_quantity),
    unitsPerPackage: Number(row.units_per_package ?? 1),
    totalToAdd: Number(row.total_to_add ?? 0),
    barcode: row.barcode ? String(row.barcode) : "",
    canonicalBarcode: row.canonical_barcode ? String(row.canonical_barcode) : "",
    barcodeType: row.barcode_type ? String(row.barcode_type) : "",
    secondaryId: row.secondary_id ? String(row.secondary_id) : "",
    secondaryType: row.secondary_type ? String(row.secondary_type) : "",
    barcodeMethod: row.barcode_method ? String(row.barcode_method) : "",
    barcodeSource: row.barcode_source ? String(row.barcode_source) : "",
    barcodeSourceUrl: row.barcode_source_url ? String(row.barcode_source_url) : "",
    barcodeSourceTitle: row.barcode_source_title ? String(row.barcode_source_title) : "",
    barcodeDifferences: JSON.parse(String(row.barcode_differences_json || "[]")) as string[],
    barcodeLookupStatus: (row.barcode_lookup_status ? String(row.barcode_lookup_status) : "pending") as IntakeLineDto["barcodeLookupStatus"],
    barcodeConfirmed: Number(row.barcode_confirmed ?? 0) === 1,
    selectedForIngress: Number(row.selected_for_ingress ?? 1) === 1,
    reviewSavedAt: row.review_saved_at ? String(row.review_saved_at) : "",
    confidence: Number(row.confidence ?? 0),
    fieldEvidence: JSON.parse(String(row.field_evidence_json || "{}")) as IntakeLineDto["fieldEvidence"],
    status: String(row.status) as IntakeLineStatus,
    action: String(row.action) as IntakeLineDto["action"],
    barcodeLevel: (row.barcode_level ? String(row.barcode_level) : "") as IntakeLineDto["barcodeLevel"],
    matchProductId: row.match_product_id == null ? null : Number(row.match_product_id),
    matchNonInventoryId: row.match_non_inventory_id == null ? null : Number(row.match_non_inventory_id),
    match: null,
    suggestions: [],
    warnings: JSON.parse(String(row.warnings_json || "[]")) as string[],
    processedOperationId: row.processed_operation_id ? String(row.processed_operation_id) : "",
  };
}
