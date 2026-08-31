import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const intake = await readFile(new URL("../app/inventory-intake.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../app/client-app.tsx", import.meta.url), "utf8");

test("inline invoice product reuses pricing and the existing scanner without leaving the invoice", () => {
  assert.match(intake, /calculatePrices\(purchase, weight, settings\)/);
  assert.match(intake, /onRequestScan\(`inline:\$\{createProductLine\.id\}`\)/);
  assert.match(intake, /scannedBarcode\.lineId\.startsWith\("inline:"\)/);
  assert.match(intake, /setNewProduct\(\(current\) => \(\{ \.\.\.current, code: checked\.normalized/);
  assert.match(client, /onRequestScan=\{\(lineId\) => \{ setIntakeScanTarget\(lineId\); setScannerIntent\("intake"\); \}\}/);
});

test("inline creation requires persisted pricing inputs and autoselects without inventory movement", () => {
  assert.match(intake, /purchasePriceUsd: newProduct\.purchasePriceUsd === "" \? null : Number/);
  assert.match(intake, /weightLb: newProduct\.weightLb === "" \? null : Number/);
  assert.match(intake, /matchProductId: product\.id[\s\S]*action: "existing", status: "confirmed"/);
  assert.match(intake, /quantityAvailable: 0/);
  assert.match(intake, /disabled=\{creatingProduct \|\| !newProduct\.name\.trim\(\) \|\| !inlinePricing \|\| minimumStockEnabled && \(!Number\.isInteger\(Number\(minimumStock\)\) \|\| Number\(minimumStock\) < 0\)\}/);
});

test("pending verification is scoped to its invoice and a server-confirmed orphan is recoverable", () => {
  assert.match(intake, /pendingVerification\?\.documentId === document\?\.id \? pendingVerification : null/);
  assert.match(intake, /if \(response\.status === 404\) \{[\s\S]*clearPendingOperation\(target\)/);
  assert.match(intake, /Boolean\(documentPendingVerification\)/);
  const productCreation = intake.indexOf("async function saveInlineProduct()");
  const productCreationEnd = intake.indexOf("const resetInvoiceReview", productCreation);
  assert.ok(productCreation >= 0 && productCreationEnd > productCreation);
  assert.equal(intake.slice(productCreation, productCreationEnd).includes("nutriplus-pending-intake-operation"), false);
});
