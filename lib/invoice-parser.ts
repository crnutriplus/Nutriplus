import { validateBarcode } from "./barcodes";

export type InvoiceProvider = "amazon" | "iherb" | "other";

export type InvoicePageText = {
  pageNumber: number;
  text: string;
  confidence: number;
  source: "pdf_text" | "ocr";
};

export type ParsedInvoiceLine = {
  lineKey: string;
  pageNumber: number;
  originalDescription: string;
  name: string;
  brand: string;
  presentation: string;
  flavor: string;
  concentration: string;
  billedQuantity: number | null;
  receivedQuantity: number | null;
  unitsPerPackage: number;
  barcode: string;
  barcodeType: string;
  secondaryId: string;
  secondaryType: "asin" | "iherb" | "other" | "";
  productUrl: string;
  confidence: number;
  warnings: string[];
  specialType: "sample" | "gift" | "promotion" | "canceled" | "refund" | "return" | "product";
};

export type ParsedInvoice = {
  provider: InvoiceProvider;
  orderNumber: string;
  invoiceNumber: string;
  shipmentNumber: string;
  documentDate: string;
  status: "draft" | "credit_note" | "return";
  warnings: string[];
  lines: ParsedInvoiceLine[];
};

const MONEY_ONLY = /^(?:[$€£₡]\s*)?[\d,.]+(?:\s*(?:USD|CRC))?$/i;
const PRICE_WORDS = /^(?:subtotal|total|tax|impuesto|shipping|env[ií]o|delivery|discount|descuento|coupon|cup[oó]n|payment|pago|price|precio)\b/i;
const HEADER_WORDS = /^(?:invoice|factura|order|pedido|shipment|env[ií]o|sold by|vendido por|ship to|enviar a|bill to|facturar a|description|descripci[oó]n|item|producto|quantity|cantidad|qty|cant\.?|unit price|precio unitario)\b/i;
const PRODUCT_HINT = /\b(?:capsules?|c[aá]psulas?|tablets?|tabletas?|softgels?|gomitas?|gummies|servings?|porciones?|pack|paquete|bottle|frasco|fl\s*oz|ounces?|oz|ml|mg|mcg|µg|kg|grams?|gramos?|count|ct|unidades?|pieces?|pcs|cream|serum|solution|powder|polvo|supplement|vitamin|magnesium|omega|protein|creatine)\b/i;

function cleanLine(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
}

function cleanDescription(value: string) {
  return cleanLine(value)
    .replace(/\b(?:ASIN|UPC|EAN|GTIN|SKU|Item\s*(?:No\.?|#)|Product\s*Code|C[oó]digo(?:\s+de\s+producto)?)\s*[:#-]?\s*[A-Z0-9-]+\b/gi, "")
    .replace(/(?:[$€£₡]\s*)\d+(?:[.,]\d{1,2})?/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[,;|\-–—\s]+|[,;|\-–—\s]+$/g, "")
    .trim();
}

function stableKey(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `line-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function capture(source: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = source.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return value.slice(0, 160);
  }
  return "";
}

function detectProvider(source: string): InvoiceProvider {
  if (/\biherb\b|iherb\.com/i.test(source)) return "iherb";
  if (/\bamazon\b|amazon\.(?:com|ca|co\.uk|es|mx)/i.test(source)) return "amazon";
  return "other";
}

function isProductish(line: string) {
  if (line.length < 6 || MONEY_ONLY.test(line) || PRICE_WORDS.test(line) || HEADER_WORDS.test(line)) return false;
  if (/^(?:https?:\/\/|www\.)/i.test(line)) return false;
  if (/\b(?:tracking|seguimiento|address|direcci[oó]n|phone|tel[eé]fono|email|correo)\b/i.test(line)) return false;
  return PRODUCT_HINT.test(line) || /[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(line) && line.length >= 18;
}

function nearestDescription(lines: string[], index: number, inline: string) {
  const cleanedInline = cleanDescription(inline);
  if (isProductish(cleanedInline)) return cleanedInline;
  for (const offset of [-1, 1, -2, 2, -3, 3]) {
    const candidate = cleanDescription(lines[index + offset] || "");
    if (isProductish(candidate)) return candidate;
  }
  return cleanedInline || cleanDescription(lines[index - 1] || lines[index + 1] || "Producto sin identificar");
}

function windowAround(lines: string[], index: number) {
  return lines.slice(Math.max(0, index - 3), index + 4).join(" \n ");
}

function taggedBarcode(source: string) {
  const tagged = source.match(/\b(?:UPC(?:-A|-E)?|EAN(?:-8|-13)?|GTIN(?:-14)?|BARCODE|C[ÓO]DIGO\s+DE\s+BARRAS)\s*[:#-]?\s*([\d\s-]{8,24})\b/i)?.[1];
  const checked = tagged ? validateBarcode(tagged) : null;
  return checked?.valid ? checked : null;
}

function detailsFromDescription(description: string) {
  const presentation = description.match(/\b(?:\d+\s*(?:x|×)\s*)?\d+(?:[.,]\d+)?\s*(?:fl\s*oz|oz|ml|l|mg|mcg|µg|g|kg|capsules?|c[aá]psulas?|tablets?|tabletas?|softgels?|gomitas?|gummies|servings?|porciones?|count|ct|unidades?|pieces?|pcs)\b(?:\s*(?:pack|paquete))?/i)?.[0] || "";
  const concentration = description.match(/\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|g|IU|UI|%)\b/i)?.[0] || "";
  const flavor = description.match(/\b(?:flavor|sabor)\s*[:\-]?\s*([^,;|]{2,40})/i)?.[1]?.trim() || "";
  const pack = description.match(/\b(?:pack|paquete|set|caja)\s*(?:of|de)?\s*(\d+)\b|\b(\d+)\s*[- ]?(?:pack|paquete)\b/i);
  const unitsPerPackage = Math.max(1, Number(pack?.[1] || pack?.[2] || 1));
  const brand = description.match(/\b(?:brand|marca)\s*[:\-]?\s*([^,;|]{2,50})/i)?.[1]?.trim() || "";
  return { presentation, concentration, flavor, unitsPerPackage, brand };
}

function specialType(source: string): ParsedInvoiceLine["specialType"] {
  if (/\b(?:cancel(?:led|ed|ado)|canceled|cancelado)\b/i.test(source)) return "canceled";
  if (/\b(?:refund(?:ed)?|reembols(?:o|ado))\b/i.test(source)) return "refund";
  if (/\b(?:return(?:ed)?|devoluci[oó]n|devuelto)\b/i.test(source)) return "return";
  if (/\b(?:sample|muestra)\b/i.test(source)) return "sample";
  if (/\b(?:gift|regalo)\b/i.test(source)) return "gift";
  if (/\b(?:promotion|promotional|promoci[oó]n|free item|art[ií]culo gratis)\b/i.test(source)) return "promotion";
  return "product";
}

function lineFromCandidate(provider: InvoiceProvider, pageNumber: number, lines: string[], index: number, quantity: number | null, inline: string, baseConfidence: number): ParsedInvoiceLine {
  const context = windowAround(lines, index);
  const originalDescription = nearestDescription(lines, index, inline);
  const details = detailsFromDescription(originalDescription);
  const asin = context.match(/\b(?:ASIN\s*[:#-]?\s*)?(B[0-9A-Z]{9})\b/i)?.[1]?.toUpperCase() || "";
  const iherbCode = context.match(/\b(?:SKU|Item\s*(?:No\.?|#)|Product\s*Code|C[oó]digo(?:\s+de\s+producto)?)\s*[:#-]?\s*([A-Z]{2,6}-?\d{3,9})\b/i)?.[1]?.toUpperCase() || "";
  const barcode = taggedBarcode(context);
  const productUrl = context.match(/https?:\/\/[^\s)\]}]+/i)?.[0] || "";
  const secondaryId = provider === "amazon" ? asin : provider === "iherb" ? iherbCode : asin || iherbCode;
  const secondaryType: ParsedInvoiceLine["secondaryType"] = provider === "amazon" && asin ? "asin" : provider === "iherb" && iherbCode ? "iherb" : secondaryId ? "other" : "";
  const warnings: string[] = [];
  if (quantity === null) warnings.push("No se pudo determinar la cantidad facturada.");
  if (!barcode) warnings.push("El código de barras todavía no está confirmado.");
  if (provider === "amazon" && !asin) warnings.push("No se detectó el ASIN para la segunda validación.");
  if (provider === "iherb" && !iherbCode) warnings.push("No se detectó el código interno de iHerb para la segunda validación.");
  const special = specialType(context);
  if (["canceled", "refund", "return"].includes(special)) warnings.push("Este artículo no debe procesarse como ingreso de inventario.");
  const confidence = Math.max(0, Math.min(100, baseConfidence - (quantity === null ? 25 : 0) - (!originalDescription ? 35 : 0)));
  return {
    lineKey: stableKey(`${pageNumber}|${index}|${originalDescription}|${quantity ?? "?"}|${secondaryId}`),
    pageNumber,
    originalDescription,
    name: originalDescription,
    brand: details.brand,
    presentation: details.presentation,
    flavor: details.flavor,
    concentration: details.concentration,
    billedQuantity: quantity,
    receivedQuantity: quantity,
    unitsPerPackage: details.unitsPerPackage,
    barcode: barcode?.normalized || "",
    barcodeType: barcode?.type || "",
    secondaryId,
    secondaryType,
    productUrl,
    confidence,
    warnings,
    specialType: special,
  };
}

function parsePageLines(provider: InvoiceProvider, page: InvoicePageText) {
  const lines = page.text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const candidates: ParsedInvoiceLine[] = [];
  const seenIndexes = new Set<number>();
  lines.forEach((line, index) => {
    let quantity: number | null = null;
    let inline = "";
    let matched = false;
    const labeled = line.match(/^(?:qty|quantity|cantidad|cant\.?)\s*[:#-]?\s*(\d+)\s*(?:x|×)?\s*(.*)$/i);
    const prefixed = line.match(/^(\d+)\s*(?:x|×|of\s*:)\s+(.+)$/i);
    const suffixed = line.match(/^(.+?)\s+(?:qty|quantity|cantidad|cant\.?)\s*[:#-]?\s*(\d+)$/i);
    if (labeled) { quantity = Number(labeled[1]); inline = labeled[2]; matched = true; }
    else if (prefixed) { quantity = Number(prefixed[1]); inline = prefixed[2]; matched = true; }
    else if (suffixed) { quantity = Number(suffixed[2]); inline = suffixed[1]; matched = true; }
    if (!matched || quantity === null || quantity < 0 || quantity > 10000) return;
    const description = nearestDescription(lines, index, inline);
    if (!isProductish(description)) return;
    candidates.push(lineFromCandidate(provider, page.pageNumber, lines, index, quantity, inline, page.confidence));
    seenIndexes.add(index);
  });

  lines.forEach((line, index) => {
    if (seenIndexes.has(index)) return;
    const context = windowAround(lines, index);
    const hasSecondary = /\bB[0-9A-Z]{9}\b/i.test(context) || /\b(?:SKU|Product\s*Code|C[oó]digo)\s*[:#-]?\s*[A-Z]{2,6}-?\d{3,9}\b/i.test(context);
    if (!hasSecondary || !isProductish(line)) return;
    const already = candidates.some((candidate) => candidate.originalDescription.toLowerCase() === cleanDescription(line).toLowerCase());
    if (!already) candidates.push(lineFromCandidate(provider, page.pageNumber, lines, index, null, line, page.confidence - 10));
  });

  if (!candidates.length) {
    lines.forEach((line, index) => {
      if (candidates.length >= 30 || !PRODUCT_HINT.test(line) || !isProductish(line)) return;
      candidates.push(lineFromCandidate(provider, page.pageNumber, lines, index, null, line, page.confidence - 30));
    });
  }
  return candidates;
}

export function parseInvoicePages(pages: InvoicePageText[]): ParsedInvoice {
  const source = pages.map((page) => page.text).join("\n");
  const provider = detectProvider(source);
  const warnings: string[] = [];
  const normalizedPages = new Map<string, number>();
  pages.forEach((page) => {
    const signature = page.text.toLowerCase().replace(/\s+/g, " ").trim();
    if (signature.length < 30) warnings.push(`La página ${page.pageNumber} tiene poco texto legible.`);
    if (page.confidence < 70) warnings.push(`La página ${page.pageNumber} tiene baja seguridad de reconocimiento.`);
    const previous = normalizedPages.get(signature);
    if (previous) warnings.push(`Las páginas ${previous} y ${page.pageNumber} parecen repetidas.`);
    else if (signature) normalizedPages.set(signature, page.pageNumber);
  });

  const pageMarkers = [...source.matchAll(/(?:page|p[aá]gina)\s*(\d+)\s*(?:of|de)\s*(\d+)/gi)];
  const expectedPages = Math.max(0, ...pageMarkers.map((match) => Number(match[2])));
  if (expectedPages > pages.length) warnings.push(`La factura indica ${expectedPages} páginas, pero se cargaron ${pages.length}.`);
  if (/\b(?:continued|contin[uú]a|continuaci[oó]n)\b/i.test(source) && pages.length === 1) warnings.push("La factura parece continuar en otra página.");

  const isCredit = /\b(?:credit note|credit memo|nota de cr[eé]dito)\b/i.test(source);
  const isReturn = /\b(?:return invoice|return authorization|factura de devoluci[oó]n)\b/i.test(source);
  if (isCredit) warnings.push("El documento parece ser una nota de crédito y no puede ingresarse como compra.");
  if (isReturn) warnings.push("El documento parece corresponder a una devolución y no puede ingresarse como compra.");

  const lines = pages.flatMap((page) => parsePageLines(provider, page));
  const unique = new Map<string, ParsedInvoiceLine>();
  lines.forEach((line) => {
    const key = `${line.pageNumber}|${line.originalDescription.toLowerCase()}|${line.secondaryId}|${line.billedQuantity ?? "?"}`;
    if (!unique.has(key)) unique.set(key, line);
  });
  if (!unique.size) warnings.push("No se pudieron reconocer productos con seguridad. Agregalos manualmente antes de continuar.");

  return {
    provider,
    orderNumber: capture(source, [/(?:order|pedido)(?:\s*(?:number|no\.?|#))?\s*[:#-]\s*([A-Z0-9-]{4,})/i]),
    invoiceNumber: capture(source, [/(?:invoice|factura)(?:\s*(?:number|no\.?|#))?\s*[:#-]\s*([A-Z0-9-]{3,})/i]),
    shipmentNumber: capture(source, [/(?:shipment|shipping|env[ií]o)(?:\s*(?:number|no\.?|#))?\s*[:#-]\s*([A-Z0-9-]{4,})/i, /(?:tracking|seguimiento)(?:\s*(?:number|no\.?|#))?\s*[:#-]\s*([A-Z0-9-]{6,})/i]),
    documentDate: capture(source, [/(?:invoice date|order date|fecha(?:\s+de\s+(?:factura|pedido))?)\s*[:#-]\s*([^\n]{4,30})/i]),
    status: isCredit ? "credit_note" : isReturn ? "return" : "draft",
    warnings: [...new Set(warnings)],
    lines: [...unique.values()],
  };
}
