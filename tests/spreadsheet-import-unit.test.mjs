import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runSpreadsheetWorker } from "../lib/spreadsheet-import-client.ts";
import { parseSpreadsheetBuffer } from "../lib/spreadsheet-import-parser.ts";
import {
  SPREADSHEET_IMPORT_LIMITS,
  SpreadsheetImportError,
  validateSpreadsheetFile,
} from "../lib/spreadsheet-import-security.ts";

const fixtureUrl = (name) => new URL(`./fixtures/spreadsheets/${name}`, import.meta.url);
const mimeFor = (name) => name.endsWith(".csv")
  ? "text/csv"
  : name.endsWith(".xls")
    ? "application/vnd.ms-excel"
    : name.endsWith(".xlsm")
      ? "application/vnd.ms-excel.sheet.macroEnabled.12"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function fixtureFile(name, type = mimeFor(name)) {
  const data = await readFile(fixtureUrl(name));
  return new File([data], name, { type });
}

async function validatedFixture(name, type) {
  return validateSpreadsheetFile(await fixtureFile(name, type));
}

async function parsedFixture(name, selectedSheet) {
  const { buffer } = await validatedFixture(name);
  return parseSpreadsheetBuffer(buffer, selectedSheet);
}

async function rejectsWithCode(name, code, type) {
  await assert.rejects(
    validateSpreadsheetFile(await fixtureFile(name, type)),
    (error) => error instanceof SpreadsheetImportError && error.code === code,
  );
}

test("reads the four supported formats with the official SheetJS build", async () => {
  for (const name of ["valid.xlsx", "valid.xlsm", "valid.xls", "valid.csv"]) {
    const parsed = await parsedFixture(name);
    assert.equal(parsed.status, "ready", name);
    assert.equal(parsed.sheetName, name === "valid.csv" ? "Sheet1" : "Compu", name);
    assert.ok(parsed.rows.length >= 1, name);
    assert.equal(parsed.headers[0], "Producto", name);
  }
  const xls = await parsedFixture("valid.xls");
  assert.equal(xls.rows[0][0], "Cúrcuma española");
  assert.equal(xls.rows[0][1], "CR-Ñ-01");
  const csv = await parsedFixture("valid.csv");
  assert.equal(csv.rows[0][1], "001234567890");
});

test("selects Compu and Solo Compu compatibly and asks when multiple sheets are ambiguous", async () => {
  assert.equal((await parsedFixture("compu.xlsx")).sheetName, "Compu");
  assert.equal((await parsedFixture("solo-compu.xlsx")).sheetName, "Solo Compu");
  const both = await parsedFixture("both-compu.xlsx");
  assert.equal(both.sheetName, "Compu");
  assert.equal(both.rows[0][0], "Elegir Compu");

  const ambiguous = await parsedFixture("multiple-sheets.xlsx");
  assert.deepEqual(ambiguous, { status: "select_sheet", sheetNames: ["Enero", "Febrero"] });
  const february = await parsedFixture("multiple-sheets.xlsx", "Febrero");
  assert.equal(february.status, "ready");
  assert.equal(february.rows[0][0], "Producto febrero");
});

test("rejects empty, oversized, unsupported, mislabeled, binary, and damaged files before parsing", async () => {
  await rejectsWithCode("empty.xlsx", "EMPTY_FILE");
  await rejectsWithCode("unsupported.txt", "UNSUPPORTED_EXTENSION", "text/plain");
  await rejectsWithCode("fake-extension.xlsx", "MAGIC_MISMATCH");
  await rejectsWithCode("bad-magic.xlsx", "MAGIC_MISMATCH");
  await rejectsWithCode("truncated.xlsx", "CORRUPT_ZIP");
  await rejectsWithCode("corrupt-zip.xlsx", "CORRUPT_ZIP");
  await rejectsWithCode("valid.xlsx", "MIME_MISMATCH", "image/png");

  let read = false;
  await assert.rejects(validateSpreadsheetFile({
    name: "oversized.xlsx",
    type: mimeFor("oversized.xlsx"),
    size: SPREADSHEET_IMPORT_LIMITS.maxFileBytes + 1,
    async arrayBuffer() { read = true; return new ArrayBuffer(0); },
  }), (error) => error instanceof SpreadsheetImportError && error.code === "FILE_TOO_LARGE");
  assert.equal(read, false, "the oversized file must be blocked before reading its bytes");
});

test("blocks suspicious OOXML containers without extracting them", async () => {
  await rejectsWithCode("too-many-zip-entries.xlsx", "ZIP_ENTRY_LIMIT");
  await rejectsWithCode("high-compression-ratio.xlsx", "ZIP_RATIO_LIMIT");
  await rejectsWithCode("too-much-uncompressed.xlsx", "ZIP_SIZE_LIMIT");
  await rejectsWithCode("path-traversal.xlsx", "SUSPICIOUS_ZIP");
  await rejectsWithCode("absolute-path.xlsx", "SUSPICIOUS_ZIP");
});

test("enforces sheet, row, and column limits during the bounded parse", async () => {
  for (const [name, code] of [
    ["too-many-sheets.xlsx", "SHEET_LIMIT"],
    ["too-many-rows.xlsx", "ROW_LIMIT"],
    ["too-many-columns.xlsx", "COLUMN_LIMIT"],
  ]) {
    const { buffer } = await validatedFixture(name);
    assert.throws(
      () => parseSpreadsheetBuffer(buffer),
      (error) => error instanceof SpreadsheetImportError && error.code === code,
      name,
    );
  }
});

test("distinguishes a missing Producto header from a sheet without products", async () => {
  for (const [name, code] of [
    ["missing-product-header.xlsx", "MISSING_PRODUCT_HEADER"],
    ["header-without-products.xlsx", "NO_PRODUCTS"],
  ]) {
    const { buffer } = await validatedFixture(name);
    assert.throws(
      () => parseSpreadsheetBuffer(buffer),
      (error) => error instanceof SpreadsheetImportError && error.code === code,
    );
  }
});

test("does not expose formula text and only uses the stored safe value", async () => {
  const parsed = await parsedFixture("formula-cells.xlsx");
  assert.equal(parsed.status, "ready");
  assert.equal(parsed.rows[0][2], 2);
  assert.doesNotMatch(JSON.stringify(parsed), /1\+1/);
});

test("preserves Spanish text, leading zeroes, alphanumeric identifiers, and long text codes", async () => {
  const spanish = await parsedFixture("spanish-characters.xlsx");
  assert.equal(spanish.rows[0][0], "Niñez, cúrcuma y piñón");
  assert.equal(spanish.rows[0][1], "Ñ-ÁÉÍÓÚ");

  for (const [name, expected] of [
    ["leading-zero-upc.xlsx", "001234567890"],
    ["formatted-leading-zero-number.xlsx", "001234567890"],
    ["alphanumeric-code.xlsx", "ABC-001-CR"],
    ["long-code-text.xlsx", "12345678901234567890"],
  ]) {
    const parsed = await parsedFixture(name);
    assert.equal(parsed.formattedRows[0][1], expected, name);
    assert.equal(parsed.warnings.length, 0, name);
  }
});

test("flags numeric identifiers longer than Excel precision without inventing digits", async () => {
  const parsed = await parsedFixture("long-code-number.xlsx");
  assert.equal(parsed.status, "ready");
  assert.deepEqual(parsed.warnings, [{
    code: "IMPRECISE_NUMERIC_CODE",
    rowIndex: 0,
    rowNumber: 2,
    columnIndex: 1,
  }]);
  assert.equal(typeof parsed.rows[0][1], "number");
});

test("preserves duplicate and incomplete rows for the existing review and last-row-wins flow", async () => {
  const duplicates = await parsedFixture("duplicates.xlsx");
  assert.deepEqual(duplicates.rows.map((row) => row[1]), ["FIRST", "LAST"]);
  const incomplete = await parsedFixture("incomplete.xlsx");
  assert.equal(incomplete.rows[0][2], "");
  assert.equal(incomplete.rows[1][3], "");

  const clientSource = await readFile(new URL("../app/client-app.tsx", import.meta.url), "utf8");
  assert.match(clientSource, /new Map\(named\.map\(\(row\) => \[normalizeName\(row\.name\), row\]\)\)/);
  assert.match(clientSource, /impreciseCodeWarnings\.length > 0/);
});

test("accepts exactly 5,000 products plus the header", async () => {
  const parsed = await parsedFixture("near-5000-products.xlsx");
  assert.equal(parsed.status, "ready");
  assert.equal(parsed.rows.length, 5_000);
  assert.equal(parsed.rowNumbers.at(-1), 5_001);
});

test("terminates an unresponsive Worker after the configured timeout", async () => {
  let terminated = false;
  const silentWorker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage() {},
    terminate() { terminated = true; },
  };
  await assert.rejects(
    runSpreadsheetWorker(new ArrayBuffer(8), undefined, () => silentWorker, 5),
    (error) => error instanceof SpreadsheetImportError && error.code === "WORKER_TIMEOUT",
  );
  assert.equal(terminated, true);
});

test("rejects malformed Worker messages without returning partial products", async () => {
  const malformedWorker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage() { queueMicrotask(() => this.onmessage?.({ data: { ok: true, rows: [["partial"]] } })); },
    terminate() {},
  };
  await assert.rejects(
    runSpreadsheetWorker(new ArrayBuffer(8), undefined, () => malformedWorker, 50),
    (error) => error instanceof SpreadsheetImportError && error.code === "INVALID_WORKER_RESPONSE",
  );
});
