import assert from "node:assert/strict";
import { Miniflare } from "miniflare";

const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('ok') } }",
  d1Databases: { DB: "nutriplus-test" },
});
const DB = await mf.getD1Database("DB");
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("integration", `${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
const env = {
  DB,
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  IMAGES: { input() { throw new Error("Images are not used in API tests."); } },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function call(path, init = {}) {
  const response = await worker.fetch(new Request(`http://local.test${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) },
  }), env, ctx);
  const body = await response.json();
  return { response, body };
}

const settings = await call("/api/settings");
assert.equal(settings.response.status, 200);

const created = await call("/api/products", {
  method: "POST",
  headers: { "x-mutation-id": "test-create-product-0001" },
  body: JSON.stringify({ name: "Omega Nordic", code: "NP-A01", purchasePriceUsd: 10, weightLb: 0.5, quantityAvailable: 2, minimumStock: 1, minimumStockEnabled: true, mutationId: "test-create-product-0001" }),
});
assert.equal(created.response.status, 201);
assert.equal(created.body.product.version, 1);

const base = created.body.product;
const firstEdit = await call(`/api/products/${base.id}`, {
  method: "PUT",
  headers: { "x-mutation-id": "test-edit-product-0001" },
  body: JSON.stringify({ ...base, name: "Omega 3 Nordic", code: base.code, version: base.version, base, mutationId: "test-edit-product-0001" }),
});
assert.equal(firstEdit.response.status, 200);
assert.equal(firstEdit.body.product.name, "Omega 3 Nordic");

const concurrentEdit = await call(`/api/products/${base.id}`, {
  method: "PUT",
  headers: { "x-mutation-id": "test-edit-product-0002" },
  body: JSON.stringify({ ...base, quantityAvailable: 1, version: base.version, base, mutationId: "test-edit-product-0002" }),
});
assert.equal(concurrentEdit.response.status, 200);
assert.equal(concurrentEdit.body.product.name, "Omega 3 Nordic");
assert.equal(concurrentEdit.body.product.quantityAvailable, 1);

const marked = await call(`/api/products/${base.id}/restock`, { method: "PATCH", body: JSON.stringify({ purchased: true }) });
assert.equal(marked.response.status, 200);
assert.ok(marked.body.product.restockPurchasedAt);

const quote = await call("/api/quotes", {
  method: "POST",
  headers: { "x-mutation-id": "test-create-quote-0001" },
  body: JSON.stringify({ name: "Cotización temporal", code: "WEB-22", purchasePriceUsd: 8, weightLb: 0.25, mutationId: "test-create-quote-0001" }),
});
assert.equal(quote.response.status, 201);

const recent = await call("/api/recent?limit=10");
assert.equal(recent.response.status, 200);
assert.deepEqual(new Set(recent.body.items.map((item) => item.source)), new Set(["inventory", "no_inventory"]));

const importStart = await call("/api/imports", {
  method: "POST",
  body: JSON.stringify({
    fileName: "prueba.xlsx",
    sheetName: "Inventario",
    strategy: "update",
    rows: [
      { rowNumber: 2, name: "Omega 3 Nordic", code: "NP-A01", purchasePriceUsd: 11, weightLb: 0.55, quantityAvailable: 4, minimumStock: 1, hasCode: true, hasPurchasePrice: true, hasWeight: true, hasQuantity: true, hasMinimumStock: true },
      { rowNumber: 3, name: "Magnesio prueba", code: "MG-02", purchasePriceUsd: 7, weightLb: 0.4, quantityAvailable: 0, minimumStock: 2, hasCode: true, hasPurchasePrice: true, hasWeight: true, hasQuantity: true, hasMinimumStock: true },
    ],
  }),
});
assert.equal(importStart.response.status, 201);
let importJob = importStart.body.job;
for (let attempt = 0; attempt < 10 && !["completed", "failed"].includes(importJob.status); attempt += 1) {
  const step = await call(`/api/imports/${importJob.id}/process`, { method: "POST" });
  assert.equal(step.response.status, 200);
  importJob = step.body.job;
}
assert.equal(importJob.status, "completed");
assert.equal(importJob.importedCount, 1);
assert.equal(importJob.updatedCount, 1);

const history = await call("/api/imports");
assert.equal(history.response.status, 200);
const historyEntry = history.body.jobs.find((item) => item.id === importJob.id);
assert.equal(historyEntry.backupProductCount, 1);

const savedSettings = await call("/api/settings", { method: "PUT", body: JSON.stringify(settings.body.settings) });
assert.equal(savedSettings.response.status, 200);
assert.equal(savedSettings.body.verification.inventory, 2);
assert.equal(savedSettings.body.verification.noInventory, 1);
assert.equal(savedSettings.body.verification.failed.length, 0);

await mf.dispose();
console.log("API integration checks passed");
