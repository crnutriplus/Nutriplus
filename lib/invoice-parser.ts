import { validateBarcode } from "./barcodes.ts";

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
  size: string;
  flavor: string;
  concentration: string;
  billedQuantity: number | null;
  receivedQuantity: number | null;
  unitsPerPackage: number;
  barcode: string;
  barcodeType: string;
  barcodeSourceUrl: string;
  barcodeSourceTitle: string;
  barcodeMethod?: string;
  barcodeSource?: string;
  barcodeDifferences: string[];
  barcodeLookupStatus: "found_exact" | "suggestion" | "pending";
  secondaryId: string;
  secondaryType: "asin" | "iherb" | "other" | "";
  productUrl: string;
  confidence: number;
  fieldEvidence: Record<string, { value: string; confidence: number; page: number; source: string }>;
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

function orderNumberFrom(source: string) {
  return capture(source, [
    // Amazon en español. El OCR puede convertir “N.º” en “N.°”, “N.o” o “N.P”.
    /(?:^|[^A-Z0-9])N(?:[.\s]*[º°oOpP])?[.\s]*(?:de\s+)?pedido\s*[:#-]?\s*([0-9]{3}-[0-9]{7}-[0-9]{7})\b/i,
    /(?:^|[^A-Z0-9])N(?:[.\s]*[º°oOpP])?[.\s]*(?:de\s+)?(?:pedido|compra|orden)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,})\b/i,
    /\bn[úu]mero\s+de\s+(?:pedido|compra|orden)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,})\b/i,
    /\b(?:order|purchase)\s*(?:number|no\.?|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,})\b/i,
  ]);
}

function purchaseDateFrom(source: string) {
  return capture(source, [
    /\bfecha\s+de\s+(?:la\s+)?(?:compra|pedido|orden)\s*[:#-]?\s*([^\n|]{4,40})/i,
    /\bpedido\s+realizado\s+(?:el\s+)?([^\n|—-]{4,40})/i,
    /\b(?:order|purchase)\s+date\s*[:#-]?\s*([^\n|]{4,40})/i,
    /\bfecha\s*[:#-]\s*([^\n|]{4,40})/i,
  ]).replace(/[\s|—-]+$/g, "").trim();
}

function shipmentNumberFrom(source: string) {
  return capture(source, [
    /\b(?:n[úu]mero\s+de\s+(?:rastreo|seguimiento|env[ií]o)|rastreo|seguimiento)\s*[:#-]\s*([A-Z0-9][A-Z0-9-]{5,})\b/i,
    /\b(?:tracking|shipment|shipping)\s*(?:number|no\.?|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{5,})\b/i,
    // En iHerb el servicio de envío ocupa una línea y el código aparece después de “/”.
    /m[eé]todo\s+de\s+env[ií]o\s*\/\s*informaci[oó]n\s+de\s+seguimiento[\s\S]{0,160}?\/[ \t]*\r?\n[ \t]*([A-Z0-9][A-Z0-9-]{5,})\b/i,
    /informaci[oó]n\s+de\s+seguimiento[\s\S]{0,160}?\/[ \t]*\r?\n[ \t]*([A-Z0-9][A-Z0-9-]{5,})\b/i,
  ]);
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
  // Keep the capture on the identifier's own line. Using `\s` here can consume
  // the quantity at the beginning of the next invoice line and accidentally
  // turn a valid UPC into a different, also-valid EAN.
  const tagged = source.match(/\b(?:UPC(?:-A|-E)?|EAN(?:-8|-13)?|GTIN(?:-14)?|BARCODE|C[ÓO]DIGO[ \t]+DE[ \t]+BARRAS)[ \t]*[:#-]?[ \t]*([\d \t-]{8,24})\b/i)?.[1];
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
  const iherbCode = (context.match(/\b(?:SKU|Item\s*(?:No\.?|#)|Product\s*Code|C[oó]digo(?:\s+de\s+producto)?)\s*[:#-]?\s*([A-Z]{2,6}-?\d{3,9})\b/i)?.[1]
    || (provider === "iherb" ? context.match(/\b([A-Z]{2,6}-\d{3,9})\b/i)?.[1] : ""))?.toUpperCase() || "";
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
    size: details.presentation,
    flavor: details.flavor,
    concentration: details.concentration,
    billedQuantity: quantity,
    receivedQuantity: quantity,
    unitsPerPackage: details.unitsPerPackage,
    barcode: barcode?.normalized || "",
    barcodeType: barcode?.type || "",
    barcodeSourceUrl: "",
    barcodeSourceTitle: barcode ? "Factura" : "",
    barcodeDifferences: [],
    barcodeLookupStatus: barcode ? "found_exact" : "pending",
    secondaryId,
    secondaryType,
    productUrl,
    confidence,
    fieldEvidence: {},
    warnings,
    specialType: special,
  };
}

function parseIherbTable(page: InvoicePageText) {
  const allLines = page.text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const headerIndex = allLines.findIndex((line) => /#\s*art[ií]culo\s+precio\s+cantidad/i.test(line));
  if (headerIndex < 0) return [] as ParsedInvoiceLine[];
  const endIndex = allLines.findIndex((line, index) => index > headerIndex && /^(?:descuentos adicionales|informaci[oó]n de contacto)/i.test(line));
  const lines = allLines.slice(headerIndex + 1, endIndex < 0 ? undefined : endIndex);
  const itemRows = lines.map((line, index) => {
    const match = line.match(/^(\d{1,3})\s+(.*?)\$[\d,.]+\s+(\d+)\s+(?:-\$|\$)/i);
    return match ? { index, item: Number(match[1]), inline: cleanLine(match[2]), quantity: Number(match[3]) } : null;
  }).filter((row): row is { index: number; item: number; inline: string; quantity: number } => Boolean(row));
  if (!itemRows.length) return [] as ParsedInvoiceLine[];

  return itemRows.map((row, rowIndex) => {
    const parts: string[] = [];
    const before = lines[row.index - 1] || "";
    if (isProductish(before)) parts.push(before);
    if (row.inline && isProductish(row.inline)) parts.push(row.inline);
    const hasNextItem = Boolean(itemRows[rowIndex + 1]);
    const nextItemIndex = itemRows[rowIndex + 1]?.index ?? lines.length;
    const continuationLimit = hasNextItem ? Math.max(row.index + 1, nextItemIndex - 1) : lines.length;
    // La descripción de iHerb suele continuar justo debajo de la fila de precio.
    // Se detiene antes de la línea que encabeza el siguiente artículo.
    for (let index = row.index + 1; index < continuationLimit; index += 1) {
      const candidate = lines[index];
      if (!candidate || PRICE_WORDS.test(candidate)) continue;
      if (MONEY_ONLY.test(candidate)) {
        if (/^[0-9]{3,9}$/.test(candidate) && /-$/.test(parts.at(-1) || "")) parts.push(candidate);
        continue;
      }
      parts.push(candidate);
      if (/\b[A-Z]{2,6}-\s*\d{3,9}\b/i.test(parts.join(" "))) break;
    }
    const description = parts.join(" ")
      .replace(/\b([A-Z]{2,6})-\s+(\d{3,9})\b/g, "$1-$2")
      .replace(/\s{2,}/g, " ")
      .trim();
    return lineFromCandidate("iherb", page.pageNumber, [description], 0, row.quantity, description, page.confidence);
  }).filter((line) => isProductish(line.name));
}

function parseAmazonOrderSummary(page: InvoicePageText) {
  const lines = page.text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const sellerIndexes = lines.map((line, index) => /vendido\s+por\s*:/i.test(line) ? index : -1).filter((index) => index >= 0);
  if (!sellerIndexes.length) return [] as ParsedInvoiceLine[];
  const boundary = /^(?:entregado|entrega\s+autom[aá]tica|devolver|reemplazar|proporcionado|vendido\s+por|US\$|U[sS]\$|resumen\s+del\s+pedido|enviar\s+a|m[eé]todo\s+de\s+pago)\b/i;
  return sellerIndexes.map((sellerIndex) => {
    const parts: string[] = [];
    for (let index = sellerIndex - 1; index >= 0 && parts.length < 8; index -= 1) {
      const candidate = lines[index];
      if (boundary.test(candidate) || MONEY_ONLY.test(candidate)) break;
      if (candidate.length >= 6) parts.unshift(candidate);
    }
    const description = parts.join(" ").replace(/\s{2,}/g, " ").trim();
    const context = lines.slice(Math.max(0, sellerIndex - 3), Math.min(lines.length, sellerIndex + 5)).join(" ");
    const explicitQuantity = context.match(/\b(?:cantidad|qty)\s*[:#-]?\s*(\d+)\b/i)?.[1];
    return lineFromCandidate("amazon", page.pageNumber, [description], 0, explicitQuantity ? Number(explicitQuantity) : null, description, page.confidence);
  }).filter((line) => isProductish(line.name));
}

function parsePageLines(provider: InvoiceProvider, page: InvoicePageText) {
  if (provider === "iherb") {
    const structured = parseIherbTable(page);
    if (structured.length) return structured;
  }
  if (provider === "amazon") {
    const structured = parseAmazonOrderSummary(page);
    if (structured.length) return structured;
  }
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
    // A nearby ASIN/SKU must not turn order headers, tracking rows or other
    // metadata into products. This fallback is intentionally limited to rows
    // that also contain a concrete presentation/product hint.
    if (!hasSecondary || !PRODUCT_HINT.test(line) || !isProductish(line)) return;
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

  const orderNumber = orderNumberFrom(source);
  const shipmentNumber = shipmentNumberFrom(source);
  const documentDate = purchaseDateFrom(source);
  if (!orderNumber) warnings.push("No se pudo leer el número de pedido, compra u orden. Revisalo antes de confirmar.");
  if (!documentDate) warnings.push("No se pudo leer la fecha de la compra. Revisala antes de confirmar.");

  return {
    provider,
    orderNumber,
    // NutriPlus identifica estas compras por el número de pedido/compra/orden.
    // El número de factura no se solicita ni se muestra en este flujo.
    invoiceNumber: "",
    shipmentNumber,
    documentDate,
    status: isCredit ? "credit_note" : isReturn ? "return" : "draft",
    warnings: [...new Set(warnings)],
    lines: [...unique.values()],
  };
}
