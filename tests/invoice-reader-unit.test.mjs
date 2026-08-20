import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { invoiceFileKind, invoiceReadErrorMessage, sha256Fallback } from "../lib/invoice-reader.ts";
import { parseInvoicePages } from "../lib/invoice-parser.ts";

test("recognizes PDFs even when the phone omits or generalizes the MIME type", () => {
  assert.equal(invoiceFileKind({ name: "factura.pdf", type: "" }), "pdf");
  assert.equal(invoiceFileKind({ name: "FACTURA.PDF", type: "application/octet-stream" }), "pdf");
  assert.equal(invoiceFileKind({ name: "captura.jpg", type: "" }), "image");
  assert.equal(invoiceFileKind({ name: "factura.txt", type: "text/plain" }), null);
});

test("translates a lost file handle into a useful Spanish error", () => {
  const message = invoiceReadErrorMessage(
    new DOMException("A requested file or directory could not be found at the time an operation was processed.", "NotFoundError"),
    "factura.pdf",
  );
  assert.match(message, /dejó de estar disponible/i);
  assert.match(message, /volvé a seleccionarlo/i);
  assert.doesNotMatch(message, /requested file or directory/i);
});

test("keeps a valid SHA-256 fingerprint when Web Crypto is unavailable", () => {
  assert.equal(
    sha256Fallback(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("keeps invoice UI state explicit, closes without deleting, and exposes reversible line actions", async () => {
  const intakeSource = await readFile(new URL("../app/inventory-intake.tsx", import.meta.url), "utf8");
  const analyzeSource = intakeSource.slice(intakeSource.indexOf("async function analyzeFiles"), intakeSource.indexOf("async function saveDraft"));
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.doesNotMatch(analyzeSource, /(?:currentTarget|target)\.value\s*=/);
  assert.match(styles, /\.toast\s*\{[^}]*z-index:\s*240\b/s);
  assert.match(styles, /\.intake-modal\s*\{\s*z-index:\s*130\b/);
  assert.match(intakeSource, /Confirmar código de barras/);
  assert.match(intakeSource, /Cambiar factura/);
  assert.doesNotMatch(intakeSource, /Cambiar paquete/);
  assert.match(intakeSource, /function closeInvoiceView\(\)[\s\S]*resetInvoiceReview\(\)[\s\S]*onClose\(\)/);
  assert.match(intakeSource, /Cerrar factura/);
  assert.match(intakeSource, /Omitir/);
  assert.match(intakeSource, /Reactivar/);
  assert.match(intakeSource, /Historial de facturas/);
  assert.doesNotMatch(intakeSource, /¿Cancelar toda la carga\?/);
  assert.match(intakeSource, /deletedLineIds/);
});

test("reads the exact iHerb Spanish order, date, and tracking labels", () => {
  const parsed = parseInvoicePages([{ pageNumber: 1, confidence: 100, source: "pdf_text", text: `
www.iHerb.com
Número de compra: 945586803
Fecha de la compra: 03 Julio 2026
Método de envío / Información
de seguimiento
Envío acelerado /
1LSCXLZ0066WJ4P
Cantidad 1 Centrum, suplemento multivitamínico para mujeres, 65 comprimidos CEM-75565
` }]);
  assert.equal(parsed.provider, "iherb");
  assert.equal(parsed.orderNumber, "945586803");
  assert.equal(parsed.documentDate, "03 Julio 2026");
  assert.equal(parsed.shipmentNumber, "1LSCXLZ0066WJ4P");
});

test("reads Amazon Spanish order labels including common OCR variants", () => {
  for (const label of ["N.º de pedido", "N.° de pedido", "N.P de pedido"]) {
    const parsed = parseInvoicePages([{ pageNumber: 1, confidence: 90, source: "ocr", text: `
Amazon Resumen del pedido
Pedido realizado 25 de julio de 2026 — ${label} 112-7504724-5768234
Cantidad 1 Vitamin B9 gotas líquidas 500 mcg
` }]);
    assert.equal(parsed.provider, "amazon");
    assert.equal(parsed.orderNumber, "112-7504724-5768234");
    assert.equal(parsed.documentDate, "25 de julio de 2026");
  }
});

test("reads metadata extracted from both user-provided invoices", async () => {
  const [amazonText, iherbText] = await Promise.all([
    readFile(new URL("./fixtures/amazon-real-ocr.txt", import.meta.url), "utf8"),
    readFile(new URL("./fixtures/iherb-real-text.txt", import.meta.url), "utf8"),
  ]);
  const amazon = parseInvoicePages([{ pageNumber: 1, confidence: 90, source: "ocr", text: amazonText }]);
  assert.equal(amazon.provider, "amazon");
  assert.equal(amazon.orderNumber, "112-7504724-5768234");
  assert.equal(amazon.documentDate, "25 de julio de 2026");
  assert.equal(amazon.lines.length, 4);
  assert.match(amazon.lines[0].name, /Scent Fill Ambientador/i);
  assert.match(amazon.lines[3].name, /Amazon Basics Gel Eliminador/i);

  const iherb = parseInvoicePages([{ pageNumber: 1, confidence: 100, source: "pdf_text", text: iherbText }]);
  assert.equal(iherb.provider, "iherb");
  assert.equal(iherb.orderNumber, "945586803");
  assert.equal(iherb.documentDate, "03 Julio 2026");
  assert.equal(iherb.shipmentNumber, "1LSCXLZ0066WJ4P");
  assert.deepEqual(iherb.lines.map((line) => line.billedQuantity), [1, 1, 2, 1]);
  assert.deepEqual(iherb.lines.map((line) => line.secondaryId), ["CEM-75565", "NOW-03773", "SNS-02782", "NOR-56780"]);
});
