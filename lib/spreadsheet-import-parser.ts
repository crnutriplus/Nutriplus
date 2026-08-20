import * as XLSX from "xlsx";
import * as cptable from "xlsx/dist/cpexcel.full.mjs";

import {
  SPREADSHEET_IMPORT_LIMITS,
  SpreadsheetImportError,
  spreadsheetImportErrorMessage,
} from "./spreadsheet-import-security.ts";

XLSX.set_cptable(cptable);

export type SpreadsheetCellWarning = {
  code: "IMPRECISE_NUMERIC_CODE";
  rowIndex: number;
  rowNumber: number;
  columnIndex: number;
};

export type SpreadsheetParseResult = {
  status: "ready";
  sheetName: string;
  headers: string[];
  rows: unknown[][];
  formattedRows: string[][];
  rowNumbers: number[];
  warnings: SpreadsheetCellWarning[];
};

export type SpreadsheetSheetSelection = {
  status: "select_sheet";
  sheetNames: string[];
};

export type SpreadsheetWorkerSuccess = SpreadsheetParseResult | SpreadsheetSheetSelection;

export type SpreadsheetWorkerResponse =
  | ({ ok: true } & SpreadsheetWorkerSuccess)
  | { ok: false; error: string; errorCode?: string };

export type SpreadsheetWorkerRequest = {
  type: "parse";
  buffer: ArrayBuffer;
  selectedSheet?: string;
};

const SAFE_PARSE_OPTIONS = Object.freeze({
  type: "array" as const,
  dense: true,
  cellFormula: false,
  cellHTML: false,
  cellText: true,
  bookVBA: false,
  raw: true,
  sheetRows: SPREADSHEET_IMPORT_LIMITS.maxRowsIncludingHeader + 1,
});

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ").toLowerCase();
}

function selectedSheetName(sheetNames: string[], selectedSheet?: string) {
  if (selectedSheet) {
    const exact = sheetNames.find((name) => name === selectedSheet);
    if (!exact) throw new SpreadsheetImportError("MISSING_SHEET");
    return exact;
  }
  const compu = sheetNames.find((name) => normalize(name) === "compu");
  if (compu) return compu;
  const soloCompu = sheetNames.find((name) => normalize(name) === "solo compu");
  if (soloCompu) return soloCompu;
  return sheetNames.length === 1 ? sheetNames[0] : null;
}

function worksheetRange(sheet: XLSX.WorkSheet, full = false) {
  const reference = String((full ? sheet["!fullref"] : undefined) || sheet["!ref"] || "");
  if (!reference) throw new SpreadsheetImportError("NO_PRODUCTS");
  try {
    return XLSX.utils.decode_range(reference);
  } catch {
    throw new SpreadsheetImportError("CORRUPT_SPREADSHEET");
  }
}

function validateWorksheetLimits(sheet: XLSX.WorkSheet) {
  const range = worksheetRange(sheet, true);
  const rows = range.e.r - range.s.r + 1;
  const columns = range.e.c - range.s.c + 1;
  if (rows > SPREADSHEET_IMPORT_LIMITS.maxRowsIncludingHeader) throw new SpreadsheetImportError("ROW_LIMIT");
  if (columns > SPREADSHEET_IMPORT_LIMITS.maxColumns) throw new SpreadsheetImportError("COLUMN_LIMIT");
}

function denseCell(sheet: XLSX.WorkSheet, row: number, column: number) {
  return (sheet["!data"] as XLSX.CellObject[][] | undefined)?.[row]?.[column];
}

function formattedCell(cell: XLSX.CellObject | undefined, rawValue: unknown) {
  if (!cell) return String(rawValue ?? "");
  if (cell.t === "s") return String(cell.v ?? "");
  if (typeof cell.w === "string" && cell.w.trim()) return cell.w;
  return String(cell.v ?? rawValue ?? "");
}

function isImpreciseNumericIdentifier(cell: XLSX.CellObject | undefined) {
  if (!cell || cell.t !== "n" || typeof cell.v !== "number" || !Number.isFinite(cell.v)) return false;
  return Number.isInteger(cell.v) && (Math.abs(cell.v) >= 1_000_000_000_000_000 || !Number.isSafeInteger(cell.v));
}

export function isSpreadsheetWorkerRequest(value: unknown): value is SpreadsheetWorkerRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<SpreadsheetWorkerRequest>;
  return request.type === "parse"
    && request.buffer instanceof ArrayBuffer
    && request.buffer.byteLength > 0
    && request.buffer.byteLength <= SPREADSHEET_IMPORT_LIMITS.maxFileBytes
    && (request.selectedSheet === undefined || (typeof request.selectedSheet === "string" && request.selectedSheet.length <= 120));
}

export function isSpreadsheetWorkerResponse(value: unknown): value is SpreadsheetWorkerResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<SpreadsheetWorkerResponse> & Record<string, unknown>;
  if (response.ok === false) return typeof response.error === "string" && response.error.length > 0 && response.error.length <= 1_000;
  if (response.ok !== true || (response.status !== "ready" && response.status !== "select_sheet")) return false;
  if (response.status === "select_sheet") {
    return Array.isArray(response.sheetNames)
      && response.sheetNames.length > 1
      && response.sheetNames.length <= SPREADSHEET_IMPORT_LIMITS.maxSheets
      && response.sheetNames.every((name) => typeof name === "string" && name.length > 0 && name.length <= 120);
  }
  if (typeof response.sheetName !== "string" || response.sheetName.length === 0 || response.sheetName.length > 120) return false;
  if (!Array.isArray(response.headers) || response.headers.length === 0 || response.headers.length > SPREADSHEET_IMPORT_LIMITS.maxColumns) return false;
  if (!response.headers.every((header) => typeof header === "string" && header.length <= 500)) return false;
  if (!Array.isArray(response.rows) || response.rows.length === 0 || response.rows.length > 5_000) return false;
  const rows = response.rows;
  if (!rows.every((row) => Array.isArray(row)
    && row.length <= SPREADSHEET_IMPORT_LIMITS.maxColumns
    && row.every((cell) => cell === null || typeof cell === "string" || typeof cell === "boolean" || (typeof cell === "number" && Number.isFinite(cell))))) return false;
  if (!Array.isArray(response.formattedRows) || response.formattedRows.length !== rows.length) return false;
  if (!response.formattedRows.every((row) => Array.isArray(row) && row.length <= SPREADSHEET_IMPORT_LIMITS.maxColumns && row.every((cell) => typeof cell === "string" && cell.length <= 100_000))) return false;
  if (!Array.isArray(response.rowNumbers) || response.rowNumbers.length !== rows.length || !response.rowNumbers.every((row) => Number.isInteger(row) && row > 0)) return false;
  return Array.isArray(response.warnings) && response.warnings.every((warning) => {
    if (!warning || typeof warning !== "object") return false;
    const item = warning as Partial<SpreadsheetCellWarning>;
    return item.code === "IMPRECISE_NUMERIC_CODE"
      && Number.isInteger(item.rowIndex) && Number(item.rowIndex) >= 0 && Number(item.rowIndex) < rows.length
      && Number.isInteger(item.rowNumber) && Number(item.rowNumber) > 0
      && Number.isInteger(item.columnIndex) && Number(item.columnIndex) >= 0 && Number(item.columnIndex) < SPREADSHEET_IMPORT_LIMITS.maxColumns;
  });
}

export function parseSpreadsheetBuffer(buffer: ArrayBuffer, selectedSheet?: string): SpreadsheetWorkerSuccess {
  try {
    const metadata = XLSX.read(buffer, { ...SAFE_PARSE_OPTIONS, bookSheets: true });
    const sheetNames = metadata.SheetNames.filter((name): name is string => typeof name === "string" && name.trim().length > 0);
    if (!sheetNames.length) throw new SpreadsheetImportError("MISSING_SHEET");
    if (sheetNames.length > SPREADSHEET_IMPORT_LIMITS.maxSheets) throw new SpreadsheetImportError("SHEET_LIMIT");
    const sheetName = selectedSheetName(sheetNames, selectedSheet);
    if (!sheetName) return { status: "select_sheet", sheetNames };

    const book = XLSX.read(buffer, { ...SAFE_PARSE_OPTIONS, sheets: [sheetName] });
    const sheet = book.Sheets[sheetName];
    if (!sheet) throw new SpreadsheetImportError("MISSING_SHEET");
    validateWorksheetLimits(sheet);
    const range = worksheetRange(sheet);
    const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      raw: true,
      blankrows: true,
    });
    if (data.length > SPREADSHEET_IMPORT_LIMITS.maxRowsIncludingHeader) throw new SpreadsheetImportError("ROW_LIMIT");
    const headerIndex = data.findIndex((row) => row.some((cell) => normalize(String(cell)) === "producto"));
    if (headerIndex < 0) throw new SpreadsheetImportError("MISSING_PRODUCT_HEADER");
    const headers = data[headerIndex].map((cell, index) => String(cell || `Columna ${index + 1}`).trim());
    if (headers.length > SPREADSHEET_IMPORT_LIMITS.maxColumns) throw new SpreadsheetImportError("COLUMN_LIMIT");

    const rows: unknown[][] = [];
    const formattedRows: string[][] = [];
    const rowNumbers: number[] = [];
    const warnings: SpreadsheetCellWarning[] = [];
    data.slice(headerIndex + 1).forEach((row, relativeIndex) => {
      if (!row.some((cell) => String(cell).trim())) return;
      const absoluteRow = range.s.r + headerIndex + 1 + relativeIndex;
      const outputIndex = rows.length;
      const formatted = row.map((value, columnIndex) => {
        const cell = denseCell(sheet, absoluteRow, range.s.c + columnIndex);
        if (isImpreciseNumericIdentifier(cell)) {
          warnings.push({
            code: "IMPRECISE_NUMERIC_CODE",
            rowIndex: outputIndex,
            rowNumber: absoluteRow + 1,
            columnIndex,
          });
        }
        return formattedCell(cell, value);
      });
      rows.push(row);
      formattedRows.push(formatted);
      rowNumbers.push(absoluteRow + 1);
    });
    if (!rows.length) throw new SpreadsheetImportError("NO_PRODUCTS");
    return { status: "ready", sheetName, headers, rows, formattedRows, rowNumbers, warnings };
  } catch (error) {
    if (error instanceof SpreadsheetImportError) throw error;
    throw new SpreadsheetImportError("CORRUPT_SPREADSHEET");
  }
}

export function workerErrorResponse(error: unknown): SpreadsheetWorkerResponse {
  return {
    ok: false,
    error: spreadsheetImportErrorMessage(error),
    errorCode: error instanceof SpreadsheetImportError ? error.code : "CORRUPT_SPREADSHEET",
  };
}
