import { unzipSync } from "fflate";
import { validateBarcode } from "./barcodes.ts";
import type { ParsedInvoice, ParsedInvoiceLine } from "./invoice-parser.ts";
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

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ChatGptImportError";
    this.status = status;
  }
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
  catch { throw new ChatGptImportError("El ZIP contiene un nombre de archivo ilegible."); }
}

function findEocd(bytes: Uint8Array, view: DataView) {
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) return offset;
  }
  throw new ChatGptImportError("El archivo no es un ZIP válido.");
}

function safeArchiveName(name: string) {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  const parts = name.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

function zipMetadata(bytes: Uint8Array) {
  if (bytes.byteLength < 22) throw new ChatGptImportError("El archivo no es un ZIP válido.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes, view);
  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw new ChatGptImportError("No se permiten ZIP divididos en varios archivos.");
  if (entryCount < 1 || entryCount > MAX_ENTRY_COUNT) throw new ChatGptImportError(`El ZIP supera el máximo de ${MAX_ENTRY_COUNT} archivos.`);
  if (eocd + 22 + commentLength !== bytes.byteLength || centralOffset + centralSize > eocd) throw new ChatGptImportError("La estructura central del ZIP es inválida.");

  const entries: ZipEntryMetadata[] = [];
  const seen = new Set<string>();
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) throw new ChatGptImportError("La estructura de archivos del ZIP es inválida.");
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
      throw new ChatGptImportError("El ZIP utiliza una estructura no admitida o demasiado grande.");
    }
    const name = decodeName(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const normalizedName = name.toLowerCase();
    if (!safeArchiveName(name) || name.includes("/") || name.endsWith("/")) throw new ChatGptImportError("El ZIP contiene rutas o carpetas no permitidas.");
    if (seen.has(normalizedName)) throw new ChatGptImportError("El ZIP contiene nombres de archivo duplicados.");
    seen.add(normalizedName);
    if (flags & 0x1) throw new ChatGptImportError("No se permiten archivos ZIP cifrados.");
    if (![0, 8].includes(method)) throw new ChatGptImportError("El ZIP usa un método de compresión no admitido.");
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) throw new ChatGptImportError("El ZIP contiene enlaces simbólicos no permitidos.");
    if ((unixMode & 0o111) !== 0) throw new ChatGptImportError("El ZIP contiene un archivo marcado como ejecutable.");
    if ((externalAttributes & 0x10) !== 0) throw new ChatGptImportError("El ZIP contiene carpetas no permitidas.");
    if (uncompressedSize > 0 && compressedSize === 0) throw new ChatGptImportError("El ZIP contiene una entrada con compresión inválida.");
    if (uncompressedSize > 1024 * 1024 && uncompressedSize / Math.max(1, compressedSize) > MAX_COMPRESSION_RATIO) {
      throw new ChatGptImportError("El ZIP presenta una relación de compresión insegura.");
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new ChatGptImportError("El contenido descomprimido del ZIP supera 25 MB.");
    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== ZIP_LOCAL_SIGNATURE) throw new ChatGptImportError("El ZIP contiene una cabecera local inválida.");
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localName = decodeName(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    const dataEnd = localOffset + 30 + localNameLength + localExtraLength + compressedSize;
    if (localName !== name || dataEnd > centralOffset) throw new ChatGptImportError("Las cabeceras del ZIP no coinciden.");
    entries.push({ name, compressedSize, uncompressedSize, method, flags, externalAttributes, localOffset });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) throw new ChatGptImportError("El directorio central del ZIP tiene un tamaño inválido.");
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
  if (text(root.schema, "schema", { max: 100 }) !== "nutriplus.invoice_import") throw new ChatGptImportError("El schema debe ser nutriplus.invoice_import.");
  if (text(root.schema_version, "schema_version", { max: 20 }) !== "1.0") throw new ChatGptImportError("schema_version debe ser 1.0.");
  if (text(root.analysis_origin, "analysis_origin", { max: 40 }) !== "CHATGPT_IMPORT") throw new ChatGptImportError("analysis_origin debe ser CHATGPT_IMPORT.");

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
  const subtotalCents = moneyCents(invoice.subtotal, "invoice.subtotal");
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
    const quantity = wholeNumber(item.quantity, `products[${index}].quantity`, 1, 100_000);
    const unitPriceCents = moneyCents(item.unit_price, `products[${index}].unit_price`);
    const discountTotalCents = moneyCents(item.discount_total, `products[${index}].discount_total`);
    const lineSubtotalCents = moneyCents(item.line_subtotal, `products[${index}].line_subtotal`);
    const grossCents = unitPriceCents * quantity;
    if (discountTotalCents > grossCents || grossCents - discountTotalCents !== lineSubtotalCents) {
      throw new ChatGptImportError(`El subtotal de la línea ${lineNumber} no coincide con precio, cantidad y descuento.`);
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
      name: text(item.name, `products[${index}].name`, { max: 700 }),
      presentation: text(item.presentation, `products[${index}].presentation`, { max: 500 }),
      size: optionalText(item.size, `products[${index}].size`, 200) || text(item.presentation, `products[${index}].presentation`, { max: 500 }),
      flavor: optionalText(item.flavor, `products[${index}].flavor`, 200),
      strength: optionalText(item.strength, `products[${index}].strength`, 150),
      quantity,
      unitPriceCents,
      discountTotalCents,
      lineSubtotalCents,
      supplierSku: optionalText(item.supplier_sku, `products[${index}].supplier_sku`, 100).toUpperCase(),
      barcode: validateBarcode(barcode).normalized || "",
      barcodeProvenance: optionalText(provenance.upc_gtin12 || provenance.upc || provenance.ean || provenance.gtin, `products[${index}].provenance`, 80),
      asin: optionalText(identifiers.asin, `products[${index}].identifiers.asin`, 20).toUpperCase(),
      iherbProductId: optionalText(identifiers.iherb_product_id, `products[${index}].identifiers.iherb_product_id`, 100),
      reviewStatus,
    };
  }).sort((left, right) => left.lineNumber - right.lineNumber);

  if (lineCount !== products.length) throw new ChatGptImportError("invoice.line_count no coincide con la cantidad real de productos.");
  if (products.some((product, index) => product.lineNumber !== index + 1)) throw new ChatGptImportError("Los números de línea deben ser consecutivos y comenzar en 1.");
  if (products.reduce((sum, product) => sum + product.quantity, 0) !== inventoryUnits) {
    throw new ChatGptImportError("invoice.inventory_units no coincide con la suma de cantidades de productos.");
  }
  if (products.reduce((sum, product) => sum + product.lineSubtotalCents, 0) !== subtotalCents) {
    throw new ChatGptImportError("invoice.subtotal no coincide con la suma recalculada de las líneas.");
  }
  if (subtotalCents + shippingCents + taxCents !== totalCents) {
    throw new ChatGptImportError("invoice.total no coincide con subtotal, envío e impuestos recalculados.");
  }

  return {
    root,
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
  };
}

function parsedProduct(product: ValidatedProduct, provider: ParsedInvoice["provider"]): ParsedInvoiceLine {
  const secondaryId = provider === "amazon" ? product.asin || product.supplierSku : provider === "iherb" ? product.supplierSku || product.iherbProductId : product.supplierSku;
  const secondaryType: ParsedInvoiceLine["secondaryType"] = provider === "amazon" && secondaryId ? "asin" : provider === "iherb" && secondaryId ? "iherb" : secondaryId ? "other" : "";
  const warnings: string[] = [];
  if (!product.barcode) warnings.push("El paquete no contiene un UPC, EAN o GTIN válido para esta línea.");
  if (product.reviewStatus !== "READY") warnings.push("ChatGPT marcó este producto para revisión manual.");
  const description = [product.brand, product.name, product.presentation, product.strength, product.flavor].filter(Boolean).join(" · ");
  const evidenceSource = "chatgpt_import";
  return {
    lineKey: `chatgpt-import-${product.lineNumber}`,
    pageNumber: 1,
    originalDescription: description,
    name: product.name,
    brand: product.brand,
    presentation: product.presentation,
    size: product.size,
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
      presentation: { value: product.presentation, confidence: 100, page: 1, source: evidenceSource },
      quantity: { value: String(product.quantity), confidence: 100, page: 1, source: evidenceSource },
      unit_price: { value: (product.unitPriceCents / 100).toFixed(2), confidence: 100, page: 1, source: evidenceSource },
      discount_total: { value: (product.discountTotalCents / 100).toFixed(2), confidence: 100, page: 1, source: evidenceSource },
      line_subtotal: { value: (product.lineSubtotalCents / 100).toFixed(2), confidence: 100, page: 1, source: evidenceSource },
    },
    warnings,
    specialType: "product",
  };
}

export async function parseChatGptInvoiceImport(file: File): Promise<ChatGptInvoiceImportResult> {
  if (!file || !file.size) throw new ChatGptImportError("Seleccioná un archivo ZIP generado desde ChatGPT.");
  if (!/\.zip$/i.test(file.name) && !/(?:application\/zip|application\/x-zip-compressed)/i.test(file.type || "")) {
    throw new ChatGptImportError("Importar análisis de ChatGPT acepta únicamente un archivo ZIP.");
  }
  if (file.size > MAX_ARCHIVE_BYTES) throw new ChatGptImportError("El ZIP supera el máximo de 25 MB.");
  const archiveBytes = new Uint8Array(await file.arrayBuffer());
  const metadata = zipMetadata(archiveBytes);
  const analysisEntry = metadata.filter((entry) => entry.name.toLowerCase() === "analysis.json");
  const invoiceEntries = metadata.filter((entry) => Boolean(invoiceExtension(entry.name)));
  if (analysisEntry.length !== 1 || invoiceEntries.length !== 1 || metadata.length !== 2) {
    throw new ChatGptImportError("El ZIP debe contener analysis.json y exactamente una factura invoice.pdf, invoice.jpg, invoice.jpeg, invoice.png o invoice.webp.");
  }
  if (analysisEntry[0].uncompressedSize > MAX_ANALYSIS_BYTES) throw new ChatGptImportError("analysis.json supera el máximo de 512 KB.");
  if (invoiceEntries[0].uncompressedSize > MAX_INVOICE_BYTES) throw new ChatGptImportError("La factura incluida supera el máximo de 20 MB.");

  let extracted: Record<string, Uint8Array>;
  try { extracted = unzipSync(archiveBytes); }
  catch { throw new ChatGptImportError("No se pudo descomprimir el ZIP de forma segura."); }
  const extractedByName = new Map(Object.entries(extracted).map(([name, bytes]) => [name.toLowerCase(), bytes]));
  const analysisBytes = extractedByName.get("analysis.json");
  const invoiceEntry = invoiceEntries[0];
  const invoiceBytes = extractedByName.get(invoiceEntry.name.toLowerCase());
  if (!analysisBytes || !invoiceBytes || analysisBytes.byteLength !== analysisEntry[0].uncompressedSize || invoiceBytes.byteLength !== invoiceEntry.uncompressedSize) {
    throw new ChatGptImportError("El contenido descomprimido no coincide con la estructura declarada del ZIP.");
  }
  let analysisValue: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(analysisBytes).replace(/^\uFEFF/, "");
    analysisValue = JSON.parse(json);
  } catch { throw new ChatGptImportError("analysis.json no contiene JSON UTF-8 válido."); }
  const validated = validateAnalysis(analysisValue);
  const extension = invoiceExtension(invoiceEntry.name);
  if (!validInvoiceSignature(invoiceBytes, extension)) throw new ChatGptImportError("La extensión de invoice.* no coincide con el contenido real de la factura.");
  const actualSha256 = await sha256Bytes(invoiceBytes);
  if (actualSha256 !== validated.sourceSha256) {
    throw new ChatGptImportError("El análisis no corresponde a la factura incluida en este paquete.");
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
    },
    reviewRequired: reviewIssues.length > 0,
    reviewIssues: [...new Set(reviewIssues)],
  };
}
