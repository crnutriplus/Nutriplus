import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import * as cptable from "xlsx/dist/cpexcel.full.mjs";
import { zipSync } from "fflate";

XLSX.set_cptable(cptable);

const output = fileURLToPath(new URL("./", import.meta.url));
const bytes = (value) => value instanceof Uint8Array ? value : new Uint8Array(value);
const save = (name, value) => writeFile(new URL(name, import.meta.url), bytes(value));

function workbook(sheets) {
  const book = XLSX.utils.book_new();
  for (const [name, data] of sheets) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(data, { dense: true }), name);
  return book;
}

async function saveWorkbook(name, book, bookType) {
  await save(name, XLSX.write(book, { type: "buffer", bookType, compression: true }));
}

const headers = ["Producto", "Código", "Precio compra", "Libras", "Cant", "Stock mínimo"];
const products = [
  ["Omega 3", "012345678905", 12.5, 0.4, 3, 1],
  ["Vitamina C", "VIT-C-500", 8.75, 0.25, 4, 2],
];

await saveWorkbook("valid.xlsx", workbook([["Compu", [headers, ...products]]]), "xlsx");
await saveWorkbook("valid.xlsm", workbook([["Compu", [headers, ...products]]]), "xlsm");
await saveWorkbook("valid.xls", workbook([["Compu", [headers, ["Cúrcuma española", "CR-Ñ-01", 9.5, 0.3, 2, 1]]]]), "xls");
await save("valid.csv", new TextEncoder().encode("Producto,Código,Precio compra,Libras,Cant,Stock mínimo\nOmega 3,001234567890,12.5,0.4,3,1\nMagnesio,MG-Ñ-02,10,0.5,2,1\n"));
await saveWorkbook("compu.xlsx", workbook([["Compu", [headers, ...products]]]), "xlsx");
await saveWorkbook("solo-compu.xlsx", workbook([["Solo Compu", [headers, ...products]]]), "xlsx");
await saveWorkbook("both-compu.xlsx", workbook([
  ["Solo Compu", [headers, ["No elegir", "NO", 1, 1, 1, 1]]],
  ["Compu", [headers, ["Elegir Compu", "SI", 2, 2, 2, 2]]],
]), "xlsx");
await saveWorkbook("multiple-sheets.xlsx", workbook([
  ["Enero", [headers, ["Producto enero", "ENE-1", 1, 1, 1, 1]]],
  ["Febrero", [headers, ["Producto febrero", "FEB-1", 2, 2, 2, 2]]],
]), "xlsx");
await saveWorkbook("missing-product-header.xlsx", workbook([["Compu", [["Nombre alterno", "Código"], ["Sin encabezado", "ABC"]]]]), "xlsx");
await saveWorkbook("header-without-products.xlsx", workbook([["Compu", [headers]]]), "xlsx");
await save("empty.xlsx", new Uint8Array());

const validBytes = bytes(XLSX.write(workbook([["Compu", [headers, ...products]]]), { type: "buffer", bookType: "xlsx", compression: true }));
await save("truncated.xlsx", validBytes.subarray(0, 64));
await save("fake-extension.xlsx", new TextEncoder().encode("Producto,Código\nNo es XLSX,ABC\n"));
await save("bad-magic.xlsx", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
await save("corrupt-zip.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]));
await save("path-traversal.xlsx", zipSync({ "../evil.xml": new TextEncoder().encode("malicious") }, { level: 0 }));
await save("absolute-path.xlsx", zipSync({ "/evil.xml": new TextEncoder().encode("malicious") }, { level: 0 }));

const manyEntries = {};
for (let index = 0; index < 201; index += 1) manyEntries[`xl/worksheets/item-${index}.xml`] = new Uint8Array();
await save("too-many-zip-entries.xlsx", zipSync(manyEntries, { level: 0 }));
await save("high-compression-ratio.xlsx", zipSync({
  "[Content_Types].xml": new TextEncoder().encode("<Types/>"),
  "xl/workbook.xml": new TextEncoder().encode("<workbook/>"),
  "xl/worksheets/sheet1.xml": new Uint8Array(512 * 1024).fill(65),
}, { level: 9 }));

const oversizedMetadata = zipSync({
  "[Content_Types].xml": new TextEncoder().encode("<Types/>"),
  "xl/workbook.xml": new TextEncoder().encode("<workbook/>"),
  "xl/worksheets/sheet1.xml": new TextEncoder().encode("<worksheet/>")
}, { level: 0 });
const oversizedView = new DataView(oversizedMetadata.buffer, oversizedMetadata.byteOffset, oversizedMetadata.byteLength);
for (let offset = 0; offset + 46 <= oversizedMetadata.byteLength; offset += 1) {
  if (oversizedView.getUint32(offset, true) !== 0x02014b50) continue;
  const nameLength = oversizedView.getUint16(offset + 28, true);
  const name = new TextDecoder().decode(oversizedMetadata.subarray(offset + 46, offset + 46 + nameLength));
  if (name === "xl/worksheets/sheet1.xml") oversizedView.setUint32(offset + 24, 50 * 1024 * 1024 + 1, true);
}
await save("too-much-uncompressed.xlsx", oversizedMetadata);

const tooManyRows = [headers];
for (let index = 0; index < 5_001; index += 1) tooManyRows.push([`Producto ${index}`, `ROW-${index}`, index + 1, 0.1, 1, 0]);
await saveWorkbook("too-many-rows.xlsx", workbook([["Compu", tooManyRows]]), "xlsx");

const columns = Array.from({ length: 65 }, (_, index) => index === 0 ? "Producto" : `Columna ${index + 1}`);
await saveWorkbook("too-many-columns.xlsx", workbook([["Compu", [columns, ["Producto ancho", ...Array.from({ length: 64 }, (_, index) => index)]]]]), "xlsx");

const manySheets = [];
for (let index = 0; index < 11; index += 1) manySheets.push([`Hoja ${index + 1}`, [headers, [`Producto ${index}`, `S-${index}`, 1, 1, 1, 1]]]);
await saveWorkbook("too-many-sheets.xlsx", workbook(manySheets), "xlsx");

const formulaBook = workbook([["Compu", [headers, ["Fórmula con caché segura", "FORM-1", 2, 0.2, 1, 1]]]]);
formulaBook.Sheets.Compu.C2 = { t: "n", f: "1+1", v: 2 };
await saveWorkbook("formula-cells.xlsx", formulaBook, "xlsx");
await saveWorkbook("spanish-characters.xlsx", workbook([["Compu", [headers, ["Niñez, cúrcuma y piñón", "Ñ-ÁÉÍÓÚ", 7.25, 0.2, 1, 0]]]]), "xlsx");
await saveWorkbook("leading-zero-upc.xlsx", workbook([["Compu", [headers, ["Código con cero", "001234567890", 1, 0.1, 1, 0]]]]), "xlsx");
const formattedCodeBook = workbook([["Compu", [headers, ["Código numérico formateado", 1234567890, 1, 0.1, 1, 0]]]]);
formattedCodeBook.Sheets.Compu["!data"][1][1].z = "000000000000";
await saveWorkbook("formatted-leading-zero-number.xlsx", formattedCodeBook, "xlsx");
await saveWorkbook("alphanumeric-code.xlsx", workbook([["Compu", [headers, ["Código alfanumérico", "ABC-001-CR", 1, 0.1, 1, 0]]]]), "xlsx");
await saveWorkbook("long-code-text.xlsx", workbook([["Compu", [headers, ["Código largo texto", "12345678901234567890", 1, 0.1, 1, 0]]]]), "xlsx");
await saveWorkbook("long-code-number.xlsx", workbook([["Compu", [headers, ["Código largo numérico", 12345678901234567, 1, 0.1, 1, 0]]]]), "xlsx");
await saveWorkbook("duplicates.xlsx", workbook([["Compu", [headers, ["Producto repetido", "FIRST", 1, 0.1, 1, 0], ["Producto repetido", "LAST", 2, 0.2, 2, 1]]]]), "xlsx");
await saveWorkbook("incomplete.xlsx", workbook([["Compu", [headers, ["Sin precio", "INC-1", "", 0.1, 1, 0], ["Sin peso", "INC-2", 1, "", 1, 0]]]]), "xlsx");

const nearLimit = [headers];
for (let index = 0; index < 5_000; index += 1) nearLimit.push([`Producto límite ${index.toString().padStart(4, "0")}`, `LIM-${index.toString().padStart(5, "0")}`, (index % 97) + 1, ((index % 13) + 1) / 10, index % 20, index % 5]);
await saveWorkbook("near-5000-products.xlsx", workbook([["Compu", nearLimit]]), "xlsx");

await save("unsupported.txt", new TextEncoder().encode("Producto,Código\nTexto,ABC\n"));

console.log(`Fixtures generated in ${output}`);
