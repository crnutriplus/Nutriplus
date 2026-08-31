import { unzipSync } from "fflate";
import { validateBarcode } from "./barcodes.ts";
import type { ParsedInvoice, ParsedInvoiceLine } from "./invoice-parser.ts";
import { normalizePresentation } from "./product-presentation.ts";
import { sha256Bytes, type PreparedInvoiceFile } from "./invoice-storage.ts";

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_ENTRY_COUNT = 10;
const MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
const MAX_INVOICE_BYTES = 20 * 1024 * 1024;
const MAX_ANALYSIS_BYTES = 512 * 1024;
const MAX_COMPRESSION_RATIO = 100;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;

const INVOICE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

type ZipEntryMetadata = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  flags: number;
  externalAttributes: number;
  localOffset: number;
};

type ValidatedProduct = {
  lineNumber: number;
  brand: string;
  name: string;
  presentation: string;
  size: string;
  flavor: string;
  strength: string;
  quantity: number;
  unitPriceCents: number;
  discountTotalCents: number;
  lineSubtotalCents: number;
  supplierSku: string;
  barcode: string;
  barcodeProvenance: string;
  asin: string;
  iherbProductId: string;
  reviewStatus: string;
  grossSubtotalCents: number;
  explicitDiscountCents: number;
  allocatedDiscountCents: number;
  netLineCostCents: number;
  discountAllocationMethod: "EXPLICIT" | "PROPORTIONAL_ESTIMATE" | "NONE";
};

export type ImportedInvoicePayment = {
  method: "CASH" | "SINPE" | "CARD" | "OTHER";
  type: string;
  amountCents: number;
  currency: string;
  last4: string | null;
  paidAt: string;
  cashAffecting: boolean;
  evidence: string;
};

export type ChatGptImportSummary = {
  pageCount: number;
  currency: string;
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
  lineCount: number;
  inventoryUnits: number;
  sourceSha256: string;
  paymentStatus: "PAID";
  payments: ImportedInvoicePayment[];
};

export type ChatGptInvoiceImportResult = {
  analysis: Record<string, unknown>;
  parsedInvoice: ParsedInvoice;
  preparedFile: PreparedInvoiceFile;
  fingerprint: string;
  summary: ChatGptImportSummary;
  reviewRequired: boolean;
  reviewIssues: string[];
};

export class ChatGptImportError extends Error {
  status: number;
  code: string;
  title: string;

  constructor(message: string, status = 400, code = "CHATGPT_SCHEMA_INVALID", title = "Análisis no compatible") {
    super(message);
    this.name = "ChatGptImportError";
    this.status = status;
    this.code = code;
    this.title = title;
  }
}

function zipError(message = "No pudimos abrir este archivo ZIP. Puede estar dañado o incompleto. Descargalo nuevamente desde ChatGPT e intentá otra vez. No se creó ninguna factura ni se modificó el inventario.") {
  return new ChatGptImportError(message, 400, "CHATGPT_ZIP_INVALID", "ZIP dañado o incompleto");
}

function record(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChatGptImportError(`${label} debe ser un objeto válido.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, options: { required?: boolean; max?: number } = {}) {
  const result = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (options.required !== false && !result) throw new ChatGptImportError(`${label} es obligatorio.`);
  if (result.length > (options.max || 1000)) throw new ChatGptImportError(`${label} supera el tamaño permitido.`);
  return result;
}

function optionalText(value: unknown, label: string, max = 1000) {
  if (value == null) return "";
  return text(value, label, { required: false, max });
}

function wholeNumber(value: unknown, label: string, minimum: number, maximum: number) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new ChatGptImportError(`${label} debe ser un número entero entre ${minimum} y ${maximum}.`);
  }
  return number;
}

function moneyCents(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10_000_000) {
    throw new ChatGptImportError(`${label} debe ser un importe válido igual o mayor que cero.`);
  }
  const cents = Math.round(value * 100);
  if (Math.abs(value - cents / 100) > 0.000001) throw new ChatGptImportError(`${label} debe tener como máximo dos decimales.`);
  return cents;
}

function optionalMoneyCents(value: unknown, label: string) {
  return value == null || value === "" ? null : moneyCents(value, label);
}

function paymentMethod(value: string) {
  if (/store\s*credit|cr[eé]dito\s*(?:de\s*)?tienda|gift\s*card/i.test(value)) return { method: "OTHER" as const, cashAffecting: false };
  if (/american express|amex|visa|mastercard|card|tarjeta/i.test(value)) return { method: "CARD" as const, cashAffecting: true };
  if (/sinpe|transfer/i.test(value)) return { method: "SINPE" as const, cashAffecting: true };
  if (/cash|efectivo/i.test(value)) return { method: "CASH" as const, cashAffecting: true };
  return { method: "OTHER" as const, cashAffecting: true };
}

function safeLast4(value: unknown) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^\d{4}$/.test(candidate) ? candidate : null;
}

function redactSensitive(value: unknown, key = ""): unknown {
  if (/^(?:pan|card_number|account_number|cvv|cvc|pin|otp|password|secret|token)$/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redactSensitive(child, childKey)]));
  if (typeof value === "string") return value.replace(/\b(?:\d[ -]?){12,19}\b/g, "[REDACTED]");
  return value;
}

function allocateByLargestRemainder(total: number, weights: number[]) {
  if (total <= 0 || !weights.length) return weights.map(() => 0);
  const weightTotal = weights.reduce((sum, item) => sum + item, 0);
  if (weightTotal <= 0) return weights.map((_, index) => index === weights.length - 1 ? total : 0);
  const exact = weights.map((weight) => total * weight / weightTotal);
  const allocated = exact.map(Math.floor);
  let remainder = total - allocated.reduce((sum, item) => sum + item, 0);
  exact.map((value, index) => ({ index, residue: value - allocated[index] }))
    .sort((a, b) => b.residue - a.residue || a.index - b.index)
    .forEach(({ index }) => { if (remainder > 0) { allocated[index] += 1; remainder -= 1; } });
  return allocated;
}

function dateText(value: unknown) {
  const result = text(value, "invoice.purchase_date", { max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new ChatGptImportError("invoice.purchase_date debe usar el formato AAAA-MM-DD.");
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new ChatGptImportError("invoice.purchase_date no contiene una fecha válida.");
  }
  return result;
}

function decodeName(bytes: Uint8Array) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw zipError(); }
}

function findEocd(bytes: Uint8Array, view: DataView) {
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) return offset;
  }
  throw zipError();
}

function safeArchiveName(name: string) {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  const parts = name.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

function zipMetadata(bytes: Uint8Array) {
  if (bytes.byteLength < 22) throw zipError();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes, view);
  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw zipError();
  if (entryCount < 1 || entryCount > MAX_ENTRY_COUNT) throw zipError(`Este paquete supera el máximo seguro de ${MAX_ENTRY_COUNT} archivos. Generá nuevamente el ZIP desde ChatGPT. No se creó ninguna factura ni se modificó el inventario.`);
  if (eocd + 22 + commentLength !== bytes.byteLength || centralOffset + centralSize > eocd) throw zipError();

  const entries: ZipEntryMetadata[] = [];
  const seen = new Set<string>();
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) throw zipError();
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const entryCommentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const end = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (end > eocd || diskStart !== 0 || [compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) {
      throw zipError();
    }
    const name = decodeName(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const normalizedName = name.toLowerCase();
    if (!safeArchiveName(name) || name.includes("/") || name.endsWith("/")) throw zipError("Este paquete contiene rutas o carpetas no permitidas. Generá nuevamente el ZIP desde ChatGPT. No se creó ninguna factura ni se modificó el inventario.");
    if (seen.has(normalizedName)) throw zipError("Este paquete contiene nombres de archivo duplicados. Generá nuevamente el ZIP desde ChatGPT. No se creó ninguna factura ni se modificó el inventario.");
    seen.add(normalizedName);
    if (flags & 0x1) throw zipError("Este paquete está cifrado y NutriPlus no puede validarlo. Generá nuevamente el ZIP desde ChatGPT sin contraseña.");
    if (![0, 8].includes(method)) throw zipError();
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) throw zipError("Este paquete contiene enlaces no permitidos. Generá nuevamente el ZIP desde ChatGPT. No se creó ninguna factura ni se modificó el inventario.");
    if ((unixMode & 0o111) !== 0) throw zipError("Este paquete contiene un archivo ejecutable no permitido. Generá nuevamente el ZIP desde ChatGPT. No se creó ninguna factura ni se modificó el inventario.");
    if ((externalAttributes & 0x10) !== 0) throw zipError("Este paquete contiene carpetas no permitidas. Debe incluir solo analysis.json y una factura.");
    if (uncompressedSize > 0 && compressedSize === 0) throw zipError();
    if (uncompressedSize > 1024 * 1024 && uncompressedSize / Math.max(1, compressedSize) > MAX_COMPRESSION_RATIO) {
      throw zipError("Este paquete tiene una compresión insegura y no puede abrirse. Generá nuevamente el ZIP desde ChatGPT. No se creó ninguna factura ni se modificó el inventario.");
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw zipError("El contenido del paquete supera el máximo seguro de 25 MB. Generá un paquete más pequeño. No se creó ninguna factura ni se modificó el inventario.");
    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== ZIP_LOCAL_SIGNATURE) throw zipError();
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localName = decodeName(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    const dataEnd = localOffset + 30 + localNameLength + localExtraLength + compressedSize;
    if (localName !== name || dataEnd > centralOffset) throw zipError();
    entries.push({ name, compressedSize, uncompressedSize, method, flags, externalAttributes, localOffset });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) throw zipError();
  return entries;
}

function invoiceExtension(name: string) {
  return name.toLowerCase().match(/^invoice\.(pdf|jpe?g|png|webp)$/)?.[1] || "";
}

function validInvoiceSignature(bytes: Uint8Array, extension: string) {
  if (extension === "pdf") return new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  if (extension === "jpg" || extension === "jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === "png") return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  if (extension === "webp") {
    return new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
  }
  return false;
}

function providerFromSupplier(supplier: string): ParsedInvoice["provider"] {
  if (/^iherb$/i.test(supplier)) return "iherb";
  if (/^amazon\b/i.test(supplier)) return "amazon";
  return "other";
}

function barcodeFromIdentifiers(identifiers: Record<string, unknown>) {
  const keys = ["upc_gtin12", "upc", "ean", "ean13", "gtin", "gtin14"];
  for (const key of keys) {
    const candidate = optionalText(identifiers[key], `products.identifiers.${key}`, 40).replace(/[^0-9]/g, "");
    if (candidate) return candidate;
  }
  return "";
}

function validateAnalysis(value: unknown) {
  const root = record(value, "analysis.json");
  if (text(root.schema, "schema", { max: 100 }) !== "nutriplus.invoice_import") {
    throw new ChatGptImportError(
      "Este análisis no usa el formato de importación de NutriPlus. Generá nuevamente el paquete desde ChatGPT. No se creó ninguna factura ni se modificó el inventario.",
      400,
      "CHATGPT_SCHEMA_INVALID",
      "Formato de análisis no válido",
    );
  }
  if (text(root.schema_version, "schema_version", { max: 20 }) !== "1.0") {
    throw new ChatGptImportError(
      "Este paquete fue creado con una versión de importación que NutriPlus no admite. Generá nuevamente el paquete desde ChatGPT. No se creó ninguna factura ni se modificó el inventario.",
      400,
      "CHATGPT_SCHEMA_UNSUPPORTED",
      "Versión no compatible",
    );
  }
  if (text(root.analysis_origin, "analysis_origin", { max: 40 }) !== "CHATGPT_IMPORT") {
    throw new ChatGptImportError(
      "Este análisis no fue identificado como una importación de ChatGPT para NutriPlus. Generá nuevamente el paquete desde ChatGPT.",
      400,
      "CHATGPT_SCHEMA_INVALID",
      "Origen de análisis no válido",
    );
  }

  const source = record(root.source, "source");
  const sourceFileName = text(source.file_name, "source.file_name", { max: 500 });
  if (!safeArchiveName(sourceFileName) || sourceFileName.includes("/")) throw new ChatGptImportError("source.file_name no es un nombre seguro.");
  const sourceSha256 = text(source.sha256, "source.sha256", { max: 64 }).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new ChatGptImportError("source.sha256 debe ser una huella SHA-256 válida.");
  const pageCount = wholeNumber(source.page_count, "source.page_count", 1, 500);

  const invoice = record(root.invoice, "invoice");
  const supplier = text(invoice.supplier, "invoice.supplier", { max: 120 });
  const purchaseNumber = text(invoice.purchase_number, "invoice.purchase_number", { max: 160 });
  const invoiceNumber = optionalText(invoice.invoice_number, "invoice.invoice_number", 160);
  const purchaseDate = dateText(invoice.purchase_date);
  const trackingNumber = optionalText(invoice.tracking_number, "invoice.tracking_number", 160);
  const currency = text(invoice.currency, "invoice.currency", { max: 3 }).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new ChatGptImportError("invoice.currency debe ser un código de moneda de tres letras.");
  const statedSubtotalCents = moneyCents(invoice.subtotal, "invoice.subtotal");
  const shippingCents = moneyCents(invoice.shipping, "invoice.shipping");
  const taxCents = moneyCents(invoice.tax, "invoice.tax");
  const totalCents = moneyCents(invoice.total, "invoice.total");
  const lineCount = wholeNumber(invoice.line_count, "invoice.line_count", 1, 500);
  const inventoryUnits = wholeNumber(invoice.inventory_units, "invoice.inventory_units", 1, 1_000_000);

  if (!Array.isArray(root.products) || !root.products.length || root.products.length > 500) {
    throw new ChatGptImportError("products debe contener entre 1 y 500 productos.");
  }
  const seenLines = new Set<number>();
  const products: ValidatedProduct[] = root.products.map((value, index) => {
    const item = record(value, `products[${index}]`);
    const lineNumber = wholeNumber(item.line_number, `products[${index}].line_number`, 1, 500);
    if (seenLines.has(lineNumber)) throw new ChatGptImportError(`La línea ${lineNumber} está duplicada en products.`);
    seenLines.add(lineNumber);
    const name = text(item.name, `products[${index}].name`, { max: 700 });
    const quantityValue = Number(item.quantity);
    if (!Number.isInteger(quantityValue) || quantityValue < 1 || quantityValue > 100_000) {
      throw new ChatGptImportError(
        `El producto “${name}” tiene una cantidad inválida. Corregila antes de continuar. No se modificó el inventario.`,
        400,
        "INVENTORY_INVALID_QUANTITY",
        "Cantidad inválida",
      );
    }
    const quantity = quantityValue;
    const unitPriceCents = moneyCents(item.unit_price, `products[${index}].unit_price`);
    const grossCents = optionalMoneyCents(item.gross_subtotal, `products[${index}].gross_subtotal`) ?? unitPriceCents * quantity;
    const explicitDiscountCents = optionalMoneyCents(item.explicit_line_discount, `products[${index}].explicit_line_discount`)
      ?? optionalMoneyCents(item.discount_total, `products[${index}].discount_total`) ?? 0;
    if (explicitDiscountCents > grossCents) throw new ChatGptImportError(`El descuento de la línea ${lineNumber} supera su subtotal bruto.`);
    const suppliedNet = optionalMoneyCents(item.net_line_cost, `products[${index}].net_line_cost`)
      ?? optionalMoneyCents(item.line_subtotal, `products[${index}].line_subtotal`);
    if (suppliedNet != null && suppliedNet !== grossCents - explicitDiscountCents) {
      throw new ChatGptImportError(`El costo neto de la línea ${lineNumber} no coincide con su descuento explícito.`);
    }
    const identifiers = item.identifiers == null ? {} : record(item.identifiers, `products[${index}].identifiers`);
    const provenance = item.provenance == null ? {} : record(item.provenance, `products[${index}].provenance`);
    const barcode = barcodeFromIdentifiers(identifiers);
    if (barcode && !validateBarcode(barcode).valid) throw new ChatGptImportError(`El UPC/EAN/GTIN de la línea ${lineNumber} no es válido.`);
    const reviewStatus = text(item.review_status, `products[${index}].review_status`, { max: 40 });
    if (!/^(?:READY|REVIEW_REQUIRED)$/.test(reviewStatus)) throw new ChatGptImportError(`products[${index}].review_status no es válido.`);
    return {
      lineNumber,
      brand: text(item.brand, `products[${index}].brand`, { max: 250 }),
      name,
      presentation: text(item.presentation, `products[${index}].presentation`, { max: 500 }),
      size: optionalText(item.size, `products[${index}].size`, 200) || text(item.presentation, `products[${index}].presentation`, { max: 500 }),
      flavor: optionalText(item.flavor, `products[${index}].flavor`, 200),
      strength: optionalText(item.strength, `products[${index}].strength`, 150),
      quantity,
      unitPriceCents,
      discountTotalCents: explicitDiscountCents,
      lineSubtotalCents: grossCents - explicitDiscountCents,
      supplierSku: optionalText(item.supplier_sku, `products[${index}].supplier_sku`, 100).toUpperCase(),
      barcode: validateBarcode(barcode).normalized || "",
      barcodeProvenance: optionalText(provenance.upc_gtin12 || provenance.upc || provenance.ean || provenance.gtin, `products[${index}].provenance`, 80),
      asin: optionalText(identifiers.asin, `products[${index}].identifiers.asin`, 20).toUpperCase(),
      iherbProductId: optionalText(identifiers.iherb_product_id, `products[${index}].identifiers.iherb_product_id`, 100),
      reviewStatus,
      grossSubtotalCents: grossCents,
      explicitDiscountCents,
      allocatedDiscountCents: 0,
      netLineCostCents: grossCents - explicitDiscountCents,
      discountAllocationMethod: (explicitDiscountCents ? "EXPLICIT" : "NONE") as ValidatedProduct["discountAllocationMethod"],
    };
  }).sort((left, right) => left.lineNumber - right.lineNumber);

  if (lineCount !== products.length) throw new ChatGptImportError("invoice.line_count no coincide con la cantidad real de productos.");
  if (products.some((product, index) => product.lineNumber !== index + 1)) throw new ChatGptImportError("Los números de línea deben ser consecutivos y comenzar en 1.");
  if (products.reduce((sum, product) => sum + product.quantity, 0) !== inventoryUnits) {
    throw new ChatGptImportError("invoice.inventory_units no coincide con la suma de cantidades de productos.");
  }
  const grossProducts = products.reduce((sum, product) => sum + product.grossSubtotalCents, 0);
  const explicitDiscounts = products.reduce((sum, product) => sum + product.explicitDiscountCents, 0);
  const declaredGross = optionalMoneyCents(invoice.gross_subtotal ?? invoice.products_gross_subtotal, "invoice.gross_subtotal") ?? grossProducts;
  const declaredDiscount = optionalMoneyCents(invoice.discount_total ?? invoice.global_discount, "invoice.discount_total");
  const declaredNet = optionalMoneyCents(invoice.net_products_total, "invoice.net_products_total")
    ?? (declaredDiscount != null ? declaredGross - declaredDiscount : statedSubtotalCents);
  if (declaredGross !== grossProducts || declaredNet < 0 || declaredNet > grossProducts - explicitDiscounts) {
    throw new ChatGptImportError("El total calculado de los productos no concilia con los subtotales bruto/neto del documento. Revisá el paquete; el inventario no fue modificado.", 400, "CHATGPT_TOTAL_INCONSISTENT", "Total inconsistente");
  }
  const globalToAllocate = grossProducts - explicitDiscounts - declaredNet;
  const eligible = products.map((product, index) => ({ product, index })).filter(({ product }) => product.grossSubtotalCents > product.explicitDiscountCents);
  const allocations = allocateByLargestRemainder(globalToAllocate, eligible.map(({ product }) => product.grossSubtotalCents));
  eligible.forEach(({ product }, index) => {
    product.allocatedDiscountCents = allocations[index];
    product.netLineCostCents = product.grossSubtotalCents - product.explicitDiscountCents - allocations[index];
    product.discountTotalCents = product.explicitDiscountCents + allocations[index];
    product.lineSubtotalCents = product.netLineCostCents;
    if (allocations[index] > 0) product.discountAllocationMethod = "PROPORTIONAL_ESTIMATE";
  });
  const subtotalCents = products.reduce((sum, product) => sum + product.netLineCostCents, 0);
  if (subtotalCents !== declaredNet) throw new ChatGptImportError("No se pudo reconciliar el descuento global al centavo. No se creó la factura ni se modificó el inventario.", 400, "CHATGPT_DISCOUNT_RECONCILIATION_FAILED", "Descuento sin conciliar");
  if (subtotalCents + shippingCents + taxCents !== totalCents) {
    const calculated = (subtotalCents + shippingCents + taxCents) / 100;
    throw new ChatGptImportError(
      `El total recalculado de la factura (${currency} ${calculated.toFixed(2)}) no coincide con el total indicado (${currency} ${(totalCents / 100).toFixed(2)}). Revisá el paquete antes de continuar. El inventario no fue modificado.`,
      400,
      "CHATGPT_TOTAL_INCONSISTENT",
      "Total inconsistente",
    );
  }

  const rawPayments = Array.isArray(root.payments) ? root.payments : Array.isArray(invoice.payments) ? invoice.payments : [];
  const payments: ImportedInvoicePayment[] = rawPayments.map((value, index) => {
    const item = record(value, `payments[${index}]`);
    const type = text(item.payment_method ?? item.payment_type ?? item.method, `payments[${index}].payment_method`, { max: 100 });
    const mapped = paymentMethod(type);
    return {
      ...mapped,
      type,
      amountCents: moneyCents(item.amount, `payments[${index}].amount`),
      currency: optionalText(item.currency, `payments[${index}].currency`, 3).toUpperCase() || currency,
      last4: safeLast4(item.last4 ?? item.card_last4),
      paidAt: optionalText(item.payment_date ?? item.date, `payments[${index}].payment_date`, 10) || purchaseDate,
      evidence: optionalText(item.evidence ?? item.provenance, `payments[${index}].evidence`, 500) || "Documento importado",
    };
  });
  if (!payments.length) {
    const type = optionalText(invoice.payment_method ?? invoice.payment_type, "invoice.payment_method", 100) || "No especificado";
    payments.push({ ...paymentMethod(type), type, amountCents: totalCents, currency, last4: safeLast4(invoice.last4 ?? invoice.card_last4), paidAt: purchaseDate, evidence: "Documento importado; factura confirmada como pagada por regla del flujo" });
  }
  if (payments.some((payment) => payment.currency !== currency) || payments.reduce((sum, payment) => sum + payment.amountCents, 0) !== totalCents) {
    throw new ChatGptImportError("Los medios de pago no concilian exactamente con el total de la factura. Corregí analysis.json; no se creó la factura ni se modificó el inventario.", 400, "CHATGPT_PAYMENT_RECONCILIATION_FAILED", "Pagos sin conciliar");
  }
  const safeRoot = redactSensitive(root) as Record<string, unknown>;
  safeRoot.payment_status = "PAID";
  safeRoot.payments = payments.map((payment) => ({ payment_method: payment.type, normalized_method: payment.method, amount: payment.amountCents / 100, currency: payment.currency, last4: payment.last4, payment_date: payment.paidAt, cash_affecting: payment.cashAffecting, evidence: payment.evidence }));
  safeRoot.products = products.map((product) => ({ ...(redactSensitive((root.products as Record<string, unknown>[])[product.lineNumber - 1]) as Record<string, unknown>), gross_subtotal: product.grossSubtotalCents / 100, explicit_line_discount: product.explicitDiscountCents / 100, allocated_global_discount: product.allocatedDiscountCents / 100, net_line_cost: product.netLineCostCents / 100, discount_allocation_method: product.discountAllocationMethod }));

  return {
    root: safeRoot,
    sourceFileName,
    sourceSha256,
    pageCount,
    supplier,
    provider: providerFromSupplier(supplier),
    purchaseNumber,
    invoiceNumber,
    purchaseDate,
    trackingNumber,
    currency,
    subtotalCents,
    shippingCents,
    taxCents,
    totalCents,
    lineCount,
    inventoryUnits,
    products,
    payments,
  };
}

function parsedProduct(product: ValidatedProduct, provider: ParsedInvoice["provider"]): ParsedInvoiceLine {
  const secondaryId = provider === "amazon" ? product.asin || product.supplierSku : provider === "iherb" ? product.supplierSku || product.iherbProductId : product.supplierSku;
  const secondaryType: ParsedInvoiceLine["secondaryType"] = provider === "amazon" && secondaryId ? "asin" : provider === "iherb" && secondaryId ? "iherb" : secondaryId ? "other" : "";
  const warnings: string[] = [];
  if (!product.barcode) warnings.push("El paquete no contiene un UPC, EAN o GTIN válido para esta línea.");
  if (product.reviewStatus !== "READY") warnings.push("ChatGPT marcó este producto para revisión manual.");
  const presentation = normalizePresentation(product.presentation || product.size || [product.name, product.strength].filter(Boolean).join(" ")) || product.presentation;
  const description = [product.brand, product.name, product.presentation, product.strength, product.flavor].filter(Boolean).join(" · ");
  const evidenceSource = "chatgpt_import";
  return {
    lineKey: `chatgpt-import-${product.lineNumber}`,
    pageNumber: 1,
    originalDescription: description,
    name: product.name,
    brand: product.brand,
    presentation,
    size: presentation || product.size,
    flavor: product.flavor,
    concentration: product.strength,
    billedQuantity: product.quantity,
    receivedQuantity: product.quantity,
    unitsPerPackage: 1,
    barcode: product.barcode,
    barcodeType: validateBarcode(product.barcode).type || "",
    barcodeSourceUrl: "",
    barcodeSourceTitle: `ChatGPT Import${product.barcodeProvenance ? ` · ${product.barcodeProvenance}` : ""}`,
    barcodeDifferences: [],
    barcodeLookupStatus: product.barcode ? "found_exact" : "pending",
    barcodeMethod: "chatgpt_import",
    barcodeSource: "ChatGPT Import",
    secondaryId,
    secondaryType,
    productUrl: "",
    confidence: product.reviewStatus === "READY" ? 100 : 80,
    fieldEvidence: {
      name: { value: product.name, confidence: 100, page: 1, source: evidenceSource },
      brand: { value: product.brand, confidence: 100, page: 1, source: evidenceSource },
      presentation: { value: presentation, confidence: 100, page: 1, source: evidenceSource },
      quantity: { value: String(product.quantity), confidence: 100, page: 1, source: evidenceSource },
      unit_price: { value: (product.unitPriceCents / 100).toFixed(2), confidence: 100, page: 1, source: evidenceSource },
      discount_total: { value: (product.discountTotalCents / 100).toFixed(2), confidence: 100, page: 1, source: evidenceSource },
      line_subtotal: { value: (product.lineSubtotalCents / 100).toFixed(2), confidence: 100, page: 1, source: evidenceSource },
      gross_subtotal: { value: (product.grossSubtotalCents / 100).toFixed(2), confidence: 100, page: 1, source: evidenceSource },
      explicit_line_discount: { value: (product.explicitDiscountCents / 100).toFixed(2), confidence: 100, page: 1, source: evidenceSource },
      allocated_global_discount: { value: (product.allocatedDiscountCents / 100).toFixed(2), confidence: product.allocatedDiscountCents ? 70 : 100, page: 1, source: product.allocatedDiscountCents ? "proportional_estimate" : evidenceSource },
      net_line_cost: { value: (product.netLineCostCents / 100).toFixed(2), confidence: product.allocatedDiscountCents ? 70 : 100, page: 1, source: product.discountAllocationMethod.toLowerCase() },
      discount_allocation_method: { value: product.discountAllocationMethod, confidence: 100, page: 1, source: evidenceSource },
    },
    warnings,
    specialType: "product",
  };
}

export async function parseChatGptInvoiceImport(file: File): Promise<ChatGptInvoiceImportResult> {
  if (!file || !file.size) throw new ChatGptImportError(
    "Seleccioná el archivo .zip generado desde ChatGPT. No se creó ninguna factura ni se modificó el inventario.",
    400,
    "CHATGPT_ZIP_INVALID",
    "Paquete ZIP requerido",
  );
  if (!/\.zip$/i.test(file.name) && !/(?:application\/zip|application\/x-zip-compressed)/i.test(file.type || "")) {
    throw new ChatGptImportError(
      "Este archivo no es un paquete ZIP válido de NutriPlus. Seleccioná el archivo .zip generado desde ChatGPT. No se creó ninguna factura ni se modificó el inventario.",
      400,
      "CHATGPT_ZIP_INVALID",
      "Tipo de archivo incorrecto",
    );
  }
  if (file.size > MAX_ARCHIVE_BYTES) throw zipError("Este paquete supera el máximo seguro de 25 MB. Generá un paquete más pequeño. No se creó ninguna factura ni se modificó el inventario.");
  const archiveBytes = new Uint8Array(await file.arrayBuffer());
  const metadata = zipMetadata(archiveBytes);
  const analysisEntry = metadata.filter((entry) => entry.name.toLowerCase() === "analysis.json");
  const invoiceEntries = metadata.filter((entry) => Boolean(invoiceExtension(entry.name)));
  if (!analysisEntry.length) throw new ChatGptImportError(
    "Este paquete no contiene el archivo de análisis necesario (analysis.json). Generá nuevamente el paquete desde ChatGPT. No se creó ninguna factura ni se modificó el inventario.",
    400,
    "CHATGPT_ANALYSIS_MISSING",
    "Falta analysis.json",
  );
  if (analysisEntry.length > 1) throw zipError("Este paquete contiene más de un archivo analysis.json. Generá nuevamente el ZIP desde ChatGPT. No se creó ninguna factura ni se modificó el inventario.");
  if (!invoiceEntries.length) throw new ChatGptImportError(
    "Este paquete contiene el análisis, pero no incluye la factura original. Generá nuevamente el paquete desde ChatGPT. No se creó ninguna factura ni se modificó el inventario.",
    400,
    "CHATGPT_INVOICE_MISSING",
    "Falta la factura original",
  );
  if (invoiceEntries.length > 1) throw new ChatGptImportError(
    "Este paquete contiene más de una factura. Cada paquete NutriPlus debe incluir solamente una factura. No se creó ninguna factura ni se modificó el inventario.",
    400,
    "CHATGPT_MULTIPLE_INVOICES",
    "Más de una factura",
  );
  if (metadata.length !== 2) throw zipError("Este paquete contiene archivos adicionales no permitidos. Debe incluir solamente analysis.json y una factura. No se creó ninguna factura ni se modificó el inventario.");
  if (analysisEntry[0].uncompressedSize > MAX_ANALYSIS_BYTES) throw zipError("analysis.json supera el máximo seguro de 512 KB. Generá nuevamente el paquete desde ChatGPT.");
  if (invoiceEntries[0].uncompressedSize > MAX_INVOICE_BYTES) throw zipError("La factura incluida supera el máximo seguro de 20 MB. Generá un paquete más pequeño.");

  let extracted: Record<string, Uint8Array>;
  try { extracted = unzipSync(archiveBytes); }
  catch { throw zipError(); }
  const extractedByName = new Map(Object.entries(extracted).map(([name, bytes]) => [name.toLowerCase(), bytes]));
  const analysisBytes = extractedByName.get("analysis.json");
  const invoiceEntry = invoiceEntries[0];
  const invoiceBytes = extractedByName.get(invoiceEntry.name.toLowerCase());
  if (!analysisBytes || !invoiceBytes || analysisBytes.byteLength !== analysisEntry[0].uncompressedSize || invoiceBytes.byteLength !== invoiceEntry.uncompressedSize) {
    throw zipError();
  }
  let analysisValue: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(analysisBytes).replace(/^\uFEFF/, "");
    analysisValue = JSON.parse(json);
  } catch {
    throw new ChatGptImportError(
      "El archivo de análisis está dañado o tiene un formato que NutriPlus no puede leer. Generá nuevamente el paquete desde ChatGPT. No se creó ninguna factura ni se modificó el inventario.",
      400,
      "CHATGPT_ANALYSIS_JSON_INVALID",
      "Análisis JSON inválido",
    );
  }
  const validated = validateAnalysis(analysisValue);
  const extension = invoiceExtension(invoiceEntry.name);
  if (!validInvoiceSignature(invoiceBytes, extension)) throw zipError("La factura incluida no coincide con su tipo de archivo. Generá nuevamente el paquete desde ChatGPT. No se creó ninguna factura ni se modificó el inventario.");
  const actualSha256 = await sha256Bytes(invoiceBytes);
  if (actualSha256 !== validated.sourceSha256) {
    throw new ChatGptImportError(
      "El análisis no corresponde a la factura incluida en este paquete. No se importó ningún producto ni se modificó el inventario. Generá nuevamente el paquete usando la factura correcta.",
      400,
      "CHATGPT_HASH_MISMATCH",
      "El análisis no corresponde a la factura",
    );
  }
  const sourceExtension = validated.sourceFileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || extension;
  const mimeType = INVOICE_TYPES[extension];
  if (!INVOICE_TYPES[sourceExtension] || INVOICE_TYPES[sourceExtension] !== mimeType) {
    throw new ChatGptImportError("source.file_name no coincide con el tipo de factura incluido en el ZIP.");
  }

  const parsedLines = validated.products.map((product) => parsedProduct(product, validated.provider));
  const reviewIssues = parsedLines.flatMap((line) => line.warnings);
  const parsedInvoice: ParsedInvoice = {
    provider: validated.provider,
    orderNumber: validated.purchaseNumber,
    invoiceNumber: validated.invoiceNumber,
    shipmentNumber: validated.trackingNumber,
    documentDate: validated.purchaseDate,
    status: "draft",
    warnings: [...new Set(reviewIssues)],
    lines: parsedLines,
  };
  const fingerprintBytes = new TextEncoder().encode(`0:${actualSha256}`);
  return {
    analysis: validated.root,
    parsedInvoice,
    preparedFile: {
      index: 0,
      fileName: validated.sourceFileName,
      mimeType,
      sizeBytes: invoiceBytes.byteLength,
      sha256: actualSha256,
      bytes: invoiceBytes,
    },
    fingerprint: await sha256Bytes(fingerprintBytes),
    summary: {
      pageCount: validated.pageCount,
      currency: validated.currency,
      subtotal: validated.subtotalCents / 100,
      shipping: validated.shippingCents / 100,
      tax: validated.taxCents / 100,
      total: validated.totalCents / 100,
      lineCount: validated.lineCount,
      inventoryUnits: validated.inventoryUnits,
      sourceSha256: actualSha256,
      paymentStatus: "PAID",
      payments: validated.payments,
    },
    reviewRequired: reviewIssues.length > 0,
    reviewIssues: [...new Set(reviewIssues)],
  };
}
