import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { invoiceFileKind, invoiceReadErrorMessage, sha256Fallback } from "../lib/invoice-reader.ts";

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

test("keeps selected invoice files available and renders errors above the intake modal", async () => {
  const intakeSource = await readFile(new URL("../app/inventory-intake.tsx", import.meta.url), "utf8");
  const analyzeSource = intakeSource.slice(intakeSource.indexOf("async function analyzeFiles"), intakeSource.indexOf("async function saveDraft"));
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.doesNotMatch(analyzeSource, /(?:currentTarget|target)\.value\s*=/);
  assert.match(styles, /\.toast\s*\{[^}]*z-index:\s*240\b/s);
  assert.match(styles, /\.intake-modal\s*\{\s*z-index:\s*130\b/);
});
