export const SPREADSHEET_IMPORT_LIMITS = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxSheets: 10,
  maxRowsIncludingHeader: 5_001,
  maxColumns: 64,
  maxZipEntries: 200,
  maxZipUncompressedBytes: 50 * 1024 * 1024,
  maxZipCompressionRatio: 100,
  workerTimeoutMs: 15_000,
});

export type SpreadsheetFileKind = "xlsx" | "xlsm" | "xls" | "csv";

export type SpreadsheetImportErrorCode =
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_EXTENSION"
  | "MIME_MISMATCH"
  | "MAGIC_MISMATCH"
  | "CORRUPT_ZIP"
  | "SUSPICIOUS_ZIP"
  | "ZIP_ENTRY_LIMIT"
  | "ZIP_SIZE_LIMIT"
  | "ZIP_RATIO_LIMIT"
  | "SHEET_LIMIT"
  | "ROW_LIMIT"
  | "COLUMN_LIMIT"
  | "MISSING_SHEET"
  | "MISSING_PRODUCT_HEADER"
  | "NO_PRODUCTS"
  | "WORKER_TIMEOUT"
  | "WORKER_FAILURE"
  | "INVALID_WORKER_RESPONSE"
  | "CORRUPT_SPREADSHEET";

const ERROR_MESSAGES: Record<SpreadsheetImportErrorCode, string> = {
  EMPTY_FILE: "El archivo está vacío. Exportalo nuevamente desde Excel o guardalo como CSV y volvé a seleccionarlo. No se importó ningún producto.",
  FILE_TOO_LARGE: "El archivo supera el límite de 10 MiB. Dividilo en archivos más pequeños y volvé a intentarlo. No se importó ningún producto.",
  UNSUPPORTED_EXTENSION: "El tipo de archivo no es compatible. Seleccioná un archivo .xlsx, .xlsm, .xls o .csv. No se importó ningún producto.",
  MIME_MISMATCH: "El tipo declarado por el archivo no coincide con su extensión. Volvé a exportarlo en el formato correcto y seleccioná la copia nueva. No se importó ningún producto.",
  MAGIC_MISMATCH: "El contenido del archivo no coincide con su extensión. Volvé a exportarlo como Excel o CSV sin cambiarle el nombre manualmente. No se importó ningún producto.",
  CORRUPT_ZIP: "El libro de Excel está dañado o incompleto. Abrilo en Excel, guardá una copia nueva y volvé a seleccionarla. No se importó ningún producto.",
  SUSPICIOUS_ZIP: "El libro contiene una estructura interna no segura. Exportá una copia nueva directamente desde Excel y volvé a intentarlo. No se importó ningún producto.",
  ZIP_ENTRY_LIMIT: "El libro contiene demasiados archivos internos. Dividilo o exportá una copia más simple y volvé a intentarlo. No se importó ningún producto.",
  ZIP_SIZE_LIMIT: "El contenido descomprimido del libro es demasiado grande. Dividilo en archivos más pequeños y volvé a intentarlo. No se importó ningún producto.",
  ZIP_RATIO_LIMIT: "El libro tiene una compresión inusualmente alta y se bloqueó por seguridad. Exportá una copia nueva o dividí el archivo. No se importó ningún producto.",
  SHEET_LIMIT: "El libro contiene más de 10 hojas. Dejá únicamente las hojas necesarias o dividí el archivo. No se importó ningún producto.",
  ROW_LIMIT: "La hoja supera el límite de 5.001 filas, incluido el encabezado. Dividí los productos en varios archivos. No se importó ningún producto.",
  COLUMN_LIMIT: "La hoja supera el límite de 64 columnas. Eliminá las columnas que no necesitás y volvé a intentarlo. No se importó ningún producto.",
  MISSING_SHEET: "No se encontró la hoja seleccionada. Volvé a elegir el archivo y seleccioná una hoja disponible. No se importó ningún producto.",
  MISSING_PRODUCT_HEADER: "No se encontró la columna Producto. Agregá ese encabezado a la hoja elegida y volvé a intentarlo. No se importó ningún producto.",
  NO_PRODUCTS: "La hoja no contiene productos. Agregá al menos una fila debajo del encabezado Producto y volvé a intentarlo. No se importó ningún producto.",
  WORKER_TIMEOUT: "La lectura tardó más de 15 segundos y se detuvo por seguridad. Dividí o simplificá el archivo y volvé a intentarlo. No se importó ningún producto.",
  WORKER_FAILURE: "No se pudo iniciar el lector seguro de hojas de cálculo. Cerrá y abrí NutriPlus y volvé a intentarlo. No se importó ningún producto.",
  INVALID_WORKER_RESPONSE: "El lector devolvió una respuesta incompleta. Cerrá y abrí NutriPlus y volvé a intentarlo. No se importó ningún producto.",
  CORRUPT_SPREADSHEET: "No se pudo leer la hoja de cálculo porque está dañada o usa una estructura no compatible. Abrila, guardá una copia nueva y volvé a intentarlo. No se importó ningún producto.",
};

export class SpreadsheetImportError extends Error {
  readonly code: SpreadsheetImportErrorCode;

  constructor(code: SpreadsheetImportErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SpreadsheetImportError";
    this.code = code;
  }
}

export function spreadsheetImportErrorMessage(error: unknown) {
  return error instanceof SpreadsheetImportError
    ? error.message
    : ERROR_MESSAGES.CORRUPT_SPREADSHEET;
}

function extensionOf(name: string) {
  return name.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
}

function fileKind(name: string): SpreadsheetFileKind {
  const extension = extensionOf(name);
  if (extension === "xlsx" || extension === "xlsm" || extension === "xls" || extension === "csv") return extension;
  throw new SpreadsheetImportError("UNSUPPORTED_EXTENSION");
}

const GENERIC_MIME_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);
const MIME_TYPES: Record<SpreadsheetFileKind, Set<string>> = {
  xlsx: new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "application/zip",
  ]),
  xlsm: new Set([
    "application/vnd.ms-excel.sheet.macroenabled.12",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "application/zip",
  ]),
  xls: new Set(["application/vnd.ms-excel", "application/x-ole-storage"]),
  csv: new Set(["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel"]),
};

function validateMime(kind: SpreadsheetFileKind, type: string) {
  const mimeType = type.trim().toLowerCase().split(";")[0];
  if (!GENERIC_MIME_TYPES.has(mimeType) && !MIME_TYPES[kind].has(mimeType)) {
    throw new SpreadsheetImportError("MIME_MISMATCH");
  }
}

function startsWith(bytes: Uint8Array, expected: number[]) {
  return expected.every((value, index) => bytes[index] === value);
}

function looksLikeText(bytes: Uint8Array) {
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return true;
  let controls = 0;
  const inspected = Math.min(bytes.byteLength, 8_192);
  for (let index = 0; index < inspected; index += 1) {
    const value = bytes[index];
    if (value === 0) return false;
    if (value < 0x20 && value !== 0x09 && value !== 0x0a && value !== 0x0d && value !== 0x0c) controls += 1;
  }
  return inspected === 0 || controls / inspected <= 0.02;
}

function uint16(view: DataView, offset: number) {
  if (offset < 0 || offset + 2 > view.byteLength) throw new SpreadsheetImportError("CORRUPT_ZIP");
  return view.getUint16(offset, true);
}

function uint32(view: DataView, offset: number) {
  if (offset < 0 || offset + 4 > view.byteLength) throw new SpreadsheetImportError("CORRUPT_ZIP");
  return view.getUint32(offset, true);
}

function unsafeZipPath(name: string) {
  if (!name || name.includes("\0") || name.startsWith("/") || name.startsWith("\\") || /^[a-z]:[\\/]/i.test(name)) return true;
  const parts = name.replaceAll("\\", "/").split("/");
  return parts.some((part) => part === "..");
}

const EXECUTABLE_EXTENSIONS = /\.(?:app|bat|cmd|com|dll|exe|jar|js|jse|mjs|msi|ps1|scr|sh|vbs|wsf)$/i;

function inspectOoxmlZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumEocdOffset = Math.max(0, bytes.byteLength - 65_557);
  let eocdOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimumEocdOffset; offset -= 1) {
    if (uint32(view, offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new SpreadsheetImportError("CORRUPT_ZIP");

  const diskNumber = uint16(view, eocdOffset + 4);
  const centralDisk = uint16(view, eocdOffset + 6);
  const entriesOnDisk = uint16(view, eocdOffset + 8);
  const entryCount = uint16(view, eocdOffset + 10);
  const centralSize = uint32(view, eocdOffset + 12);
  const centralOffset = uint32(view, eocdOffset + 16);
  const commentLength = uint16(view, eocdOffset + 20);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw new SpreadsheetImportError("SUSPICIOUS_ZIP");
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new SpreadsheetImportError("SUSPICIOUS_ZIP");
  if (eocdOffset + 22 + commentLength !== bytes.byteLength) throw new SpreadsheetImportError("CORRUPT_ZIP");
  if (entryCount > SPREADSHEET_IMPORT_LIMITS.maxZipEntries) throw new SpreadsheetImportError("ZIP_ENTRY_LIMIT");
  if (centralOffset + centralSize > eocdOffset || centralOffset > bytes.byteLength) throw new SpreadsheetImportError("CORRUPT_ZIP");

  let cursor = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  const names = new Set<string>();
  const localRanges: Array<{ start: number; end: number }> = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (let index = 0; index < entryCount; index += 1) {
    if (uint32(view, cursor) !== 0x02014b50) throw new SpreadsheetImportError("CORRUPT_ZIP");
    const madeBy = uint16(view, cursor + 4);
    const flags = uint16(view, cursor + 8);
    const method = uint16(view, cursor + 10);
    const compressedSize = uint32(view, cursor + 20);
    const uncompressedSize = uint32(view, cursor + 24);
    const nameLength = uint16(view, cursor + 28);
    const extraLength = uint16(view, cursor + 30);
    const entryCommentLength = uint16(view, cursor + 32);
    const externalAttributes = uint32(view, cursor + 38);
    const localOffset = uint32(view, cursor + 42);
    const recordLength = 46 + nameLength + extraLength + entryCommentLength;
    if (cursor + recordLength > centralOffset + centralSize || localOffset + 4 > centralOffset) {
      throw new SpreadsheetImportError("CORRUPT_ZIP");
    }
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (unsafeZipPath(name) || EXECUTABLE_EXTENSIONS.test(name)) throw new SpreadsheetImportError("SUSPICIOUS_ZIP");
    if (names.has(name.toLowerCase())) throw new SpreadsheetImportError("SUSPICIOUS_ZIP");
    if ((flags & 0x0001) !== 0 || (method !== 0 && method !== 8)) throw new SpreadsheetImportError("SUSPICIOUS_ZIP");
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((madeBy >>> 8) === 3 && (unixMode & 0xf000) === 0xa000) throw new SpreadsheetImportError("SUSPICIOUS_ZIP");
    if (uint32(view, localOffset) !== 0x04034b50) throw new SpreadsheetImportError("CORRUPT_ZIP");
    const localFlags = uint16(view, localOffset + 6);
    const localMethod = uint16(view, localOffset + 8);
    const localNameLength = uint16(view, localOffset + 26);
    const localExtraLength = uint16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (localFlags !== flags || localMethod !== method || dataEnd > centralOffset) throw new SpreadsheetImportError("CORRUPT_ZIP");
    const localName = decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    if (localName !== name) throw new SpreadsheetImportError("CORRUPT_ZIP");
    localRanges.push({ start: localOffset, end: dataEnd });

    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > SPREADSHEET_IMPORT_LIMITS.maxZipUncompressedBytes) throw new SpreadsheetImportError("ZIP_SIZE_LIMIT");
    if (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > SPREADSHEET_IMPORT_LIMITS.maxZipCompressionRatio)) {
      throw new SpreadsheetImportError("ZIP_RATIO_LIMIT");
    }
    names.add(name.toLowerCase());
    cursor += recordLength;
  }
  if (cursor !== centralOffset + centralSize) throw new SpreadsheetImportError("CORRUPT_ZIP");
  localRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index].start < localRanges[index - 1].end) throw new SpreadsheetImportError("SUSPICIOUS_ZIP");
  }
  if (totalUncompressed > 0 && (totalCompressed === 0 || totalUncompressed / totalCompressed > SPREADSHEET_IMPORT_LIMITS.maxZipCompressionRatio)) {
    throw new SpreadsheetImportError("ZIP_RATIO_LIMIT");
  }
  if (!names.has("[content_types].xml") || !names.has("xl/workbook.xml")) {
    throw new SpreadsheetImportError("MAGIC_MISMATCH");
  }
}

function validateMagic(kind: SpreadsheetFileKind, bytes: Uint8Array) {
  if (kind === "xlsx" || kind === "xlsm") {
    if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) throw new SpreadsheetImportError("MAGIC_MISMATCH");
    inspectOoxmlZip(bytes);
    return;
  }
  if (kind === "xls") {
    if (!startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) throw new SpreadsheetImportError("MAGIC_MISMATCH");
    return;
  }
  if (!looksLikeText(bytes)) throw new SpreadsheetImportError("MAGIC_MISMATCH");
}

export async function validateSpreadsheetFile(file: Pick<File, "name" | "type" | "size" | "arrayBuffer">) {
  const kind = fileKind(file.name);
  if (file.size === 0) throw new SpreadsheetImportError("EMPTY_FILE");
  if (file.size > SPREADSHEET_IMPORT_LIMITS.maxFileBytes) throw new SpreadsheetImportError("FILE_TOO_LARGE");
  validateMime(kind, file.type || "");
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    throw new SpreadsheetImportError("CORRUPT_SPREADSHEET");
  }
  if (buffer.byteLength !== file.size || buffer.byteLength === 0) throw new SpreadsheetImportError("CORRUPT_SPREADSHEET");
  validateMagic(kind, new Uint8Array(buffer));
  return { buffer, kind };
}
