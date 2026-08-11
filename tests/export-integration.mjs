import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";

const assetsDir = path.resolve("dist/client/assets");
const chunkName = (await fs.readdir(assetsDir)).find((name) => name.startsWith("export-inventory-") && name.endsWith(".js"));
assert.ok(chunkName, "Export chunk not found");

const captured = [];
const originalFetch = globalThis.fetch;
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;
globalThis.fetch = async (input, init) => {
  const value = typeof input === "string" ? input : input.url;
  if (value.startsWith("/assets/DejaVuSans")) {
    const bytes = await fs.readFile(path.join(assetsDir, path.basename(value)));
    return new Response(bytes, { status: 200 });
  }
  return originalFetch(input, init);
};
URL.createObjectURL = (blob) => { captured.push({ blob, filename: "" }); return `blob:test-${captured.length}`; };
URL.revokeObjectURL = () => undefined;
globalThis.window = {
  location: {
    href: "https://nutriplus.test/",
    origin: "https://nutriplus.test",
    pathname: "/",
    search: "",
    hash: "",
  },
  history: { state: null, replaceState() {}, pushState() {} },
  addEventListener() {},
  removeEventListener() {},
  setTimeout() { return 0; },
};
const documentMock = {
  body: { appendChild() {} },
  head: { appendChild() {} },
  getElementsByTagName() { return []; },
  querySelector() { return null; },
  createElement(tagName) {
    if (tagName !== "a") {
      return {
        rel: "",
        href: "",
        as: "",
        crossOrigin: "",
        addEventListener() {},
        setAttribute() {},
      };
    }
    const record = captured[captured.length - 1];
    return {
      href: "",
      style: {},
      set download(value) { record.filename = value; },
      get download() { return record.filename; },
      click() {},
      remove() {},
    };
  },
};

const { exportInventoryFiles } = await import(new URL(`../dist/client/assets/${chunkName}`, import.meta.url));
globalThis.document = documentMock;
const now = new Date().toISOString();
const product = (id, name, complete = true, code = `CODE-${id}`) => ({
  id, name, code, purchasePriceUsd: complete ? 10 + id : null, weightLb: complete ? 0.4 : null,
  quantityAvailable: id, minimumStock: 2, minimumStockEnabled: true, restockPurchasedAt: null,
  zeroStockSince: null, version: 1, createdAt: now, updatedAt: now,
});
const quote = (id, name) => ({ id, name, code: `WEB-${id}`, purchasePriceUsd: 8 + id, weightLb: 0.25, version: 1, createdAt: now, updatedAt: now });
const settings = { exchangeRateCrc: 520, courierRateUsd: 5.5, extraWeightLb: 0.1, deliveryCrc: 1000, correosCrc: 500, gamProfitCrc: 5000, puertoProfitCrc: 4000, roundingCrc: 100 };

const longName = "Suplemento multivitamínico de nombre excepcionalmente largo ".repeat(8).trim();
const longCode = `CODIGO-${"EXTREMADAMENTE-LARGO-".repeat(7)}FINAL`;
const result = await exportInventoryFiles([
  product(1, "Omega 3"),
  product(2, "Producto incompleto", false),
  product(3, longName, true, longCode),
], [quote(1, "Cotización web")], settings, "both");
assert.deepEqual(result, { complete: 2, incomplete: 1, noInventory: 1 });
assert.equal(captured.length, 2);

const outputDir = "/tmp/nutriplus-export-test";
await fs.mkdir(outputDir, { recursive: true });
for (const item of captured) await fs.writeFile(path.join(outputDir, item.filename), new Uint8Array(await item.blob.arrayBuffer()));
const xlsxPath = path.join(outputDir, captured.find((item) => item.filename.endsWith(".xlsx")).filename);
const pdfPath = path.join(outputDir, captured.find((item) => item.filename.endsWith(".pdf")).filename);
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(xlsxPath);
assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Productos completos", "Productos incompletos", "No inventario"]);
assert.equal(workbook.getWorksheet("No inventario").getCell("A5").value, "Cotización web");
assert.equal(workbook.getWorksheet("Productos completos").getCell("A6").value, longName);
assert.equal(workbook.getWorksheet("Productos completos").getCell("B6").value, longCode);
assert.ok(Number(workbook.getWorksheet("Productos completos").getRow(6).height) > 21);
const pdf = await PDFDocument.load(await fs.readFile(pdfPath));
assert.ok(pdf.getPageCount() >= 3);

URL.createObjectURL = originalCreateObjectUrl;
URL.revokeObjectURL = originalRevokeObjectUrl;
globalThis.fetch = originalFetch;
console.log(JSON.stringify({ xlsxPath, pdfPath, pages: pdf.getPageCount() }));
