import assert from "node:assert/strict";
import { LocalD1Database } from "./helpers/local-bindings.mjs";

const DB = new LocalD1Database();
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("concurrency", `${Date.now()}`);
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

const productPayload = {
  name: "Producto concurrente",
  code: "CC-001",
  purchasePriceUsd: 10,
  weightLb: 0.5,
  quantityAvailable: 2,
  minimumStock: 1,
  minimumStockEnabled: true,
};

await call("/api/settings");

const duplicateCreates = await Promise.all([
  call("/api/products", { method: "POST", headers: { "x-mutation-id": "concurrent-create-a" }, body: JSON.stringify({ ...productPayload, mutationId: "concurrent-create-a" }) }),
  call("/api/products", { method: "POST", headers: { "x-mutation-id": "concurrent-create-b" }, body: JSON.stringify({ ...productPayload, mutationId: "concurrent-create-b" }) }),
]);
duplicateCreates.forEach(({ response }) => assert.ok([200, 201].includes(response.status)));
assert.equal(duplicateCreates[0].body.product.id, duplicateCreates[1].body.product.id);
const base = duplicateCreates[0].body.product;

const sameMutation = await Promise.all([
  call("/api/products", { method: "POST", headers: { "x-mutation-id": "same-operation-0001" }, body: JSON.stringify({ ...productPayload, name: "Operación única", code: "ONE-001", mutationId: "same-operation-0001" }) }),
  call("/api/products", { method: "POST", headers: { "x-mutation-id": "same-operation-0001" }, body: JSON.stringify({ ...productPayload, name: "Operación única", code: "ONE-001", mutationId: "same-operation-0001" }) }),
]);
sameMutation.forEach(({ response }) => assert.ok([200, 201].includes(response.status)));
assert.equal(sameMutation[0].body.product.id, sameMutation[1].body.product.id);

const concurrentEdits = await Promise.all([
  call(`/api/products/${base.id}`, {
    method: "PUT",
    headers: { "x-mutation-id": "merge-name-0001" },
    body: JSON.stringify({ ...base, name: "Producto combinado", version: base.version, base, mutationId: "merge-name-0001" }),
  }),
  call(`/api/products/${base.id}`, {
    method: "PUT",
    headers: { "x-mutation-id": "merge-quantity-0001" },
    body: JSON.stringify({ ...base, quantityAvailable: 5, version: base.version, base, mutationId: "merge-quantity-0001" }),
  }),
]);
concurrentEdits.forEach(({ response }) => assert.equal(response.status, 200));
const merged = await call("/api/products?code=CC-001");
assert.equal(merged.body.product.name, "Producto combinado");
assert.equal(merged.body.product.quantityAvailable, 5);

const raceTarget = await call("/api/products", {
  method: "POST",
  body: JSON.stringify({ ...productPayload, name: "Editar o eliminar", code: "RACE-001" }),
});
const raceBase = raceTarget.body.product;
const editDeleteRace = await Promise.all([
  call(`/api/products/${raceBase.id}`, {
    method: "PUT",
    body: JSON.stringify({ ...raceBase, name: "Edición simultánea", version: raceBase.version, base: raceBase }),
  }),
  call(`/api/products/${raceBase.id}`, { method: "DELETE" }),
]);
editDeleteRace.forEach(({ response }) => assert.equal(response.status, 200));
assert.equal((await call("/api/products?code=RACE-001")).body.product, null);

const quantityProducts = [];
for (const [name, code] of [["Cantidad uno", "QTY-001"], ["Cantidad dos", "QTY-A2"]]) {
  const created = await call("/api/products", { method: "POST", body: JSON.stringify({ ...productPayload, name, code }) });
  quantityProducts.push(created.body.product);
}
const quantities = await call("/api/products/quantities", {
  method: "POST",
  headers: { "x-mutation-id": "quick-quantity-add-0001" },
  body: JSON.stringify({ entries: [{ code: "QTY-001", quantityAdded: 7 }, { code: "qty-a2", quantityAdded: 0 }], mutationId: "quick-quantity-add-0001" }),
});
assert.equal(quantities.response.status, 200, JSON.stringify(quantities.body));
assert.equal(quantities.body.updated, 2);
assert.equal((await call("/api/products?code=QTY-001")).body.product.quantityAvailable, 9);
assert.equal((await call("/api/products?code=QTY-A2")).body.product.quantityAvailable, 2);
const secondAddition = await call("/api/products/quantities", {
  method: "POST",
  headers: { "x-mutation-id": "quick-quantity-add-0002" },
  body: JSON.stringify({ entries: [{ code: "QTY-001", quantityAdded: 5 }], mutationId: "quick-quantity-add-0002" }),
});
assert.equal(secondAddition.response.status, 200);
assert.equal((await call("/api/products?code=QTY-001")).body.product.quantityAvailable, 14);
const retriedAddition = await call("/api/products/quantities", {
  method: "POST",
  headers: { "x-mutation-id": "quick-quantity-add-0002" },
  body: JSON.stringify({ entries: [{ code: "QTY-001", quantityAdded: 5 }], mutationId: "quick-quantity-add-0002" }),
});
assert.equal(retriedAddition.response.status, 200);
assert.equal((await call("/api/products?code=QTY-001")).body.product.quantityAvailable, 14);

const bulkDeleted = await call("/api/products/bulk-delete", {
  method: "POST",
  body: JSON.stringify({ ids: quantityProducts.map((product) => product.id) }),
});
assert.equal(bulkDeleted.response.status, 200);
assert.equal(bulkDeleted.body.deleted, 2);

const importRows = Array.from({ length: 600 }, (_, index) => ({
  rowNumber: index + 2,
  name: `Importado ${String(index + 1).padStart(3, "0")}`,
  code: `IMP-${String(index + 1).padStart(3, "0")}`,
  purchasePriceUsd: 5 + index / 100,
  weightLb: 0.25,
  quantityAvailable: index % 8,
  minimumStock: 2,
  hasCode: true,
  hasPurchasePrice: true,
  hasWeight: true,
  hasQuantity: true,
  hasMinimumStock: true,
}));
const importStart = await call("/api/imports", {
  method: "POST",
  body: JSON.stringify({ fileName: "concurrencia.xlsx", sheetName: "Inventario", strategy: "update", rows: importRows }),
});
let importJob = importStart.body.job;
for (let round = 0; round < 12 && !["completed", "failed"].includes(importJob.status); round += 1) {
  const steps = await Promise.all(Array.from({ length: 4 }, () => call(`/api/imports/${importJob.id}/process`, { method: "POST" })));
  steps.forEach(({ response }) => assert.equal(response.status, 200));
  importJob = (await call(`/api/imports/${importJob.id}`)).body.job;
}
assert.equal(importJob.status, "completed");
assert.equal(importJob.importedCount, 600);
assert.equal(importJob.processedRows, 600);

const protectedBefore = (await call("/api/products?code=IMP-001")).body.product;
const protectedImport = await call("/api/imports", {
  method: "POST",
  body: JSON.stringify({
    fileName: "proteccion.xlsx",
    sheetName: "Inventario",
    strategy: "update",
    rows: [{ ...importRows[0], purchasePriceUsd: 99 }],
  }),
});
await new Promise((resolve) => setTimeout(resolve, 12));
const manualEdit = await call(`/api/products/${protectedBefore.id}`, {
  method: "PUT",
  body: JSON.stringify({ ...protectedBefore, purchasePriceUsd: 12, version: protectedBefore.version, base: protectedBefore }),
});
assert.equal(manualEdit.response.status, 200);
let protectedJob = protectedImport.body.job;
for (let round = 0; round < 5 && protectedJob.status !== "completed"; round += 1) {
  protectedJob = (await call(`/api/imports/${protectedJob.id}/process`, { method: "POST" })).body.job;
}
assert.equal(protectedJob.status, "completed");
assert.equal(protectedJob.conflictCount, 1);
assert.equal((await call("/api/products?code=IMP-001")).body.product.purchasePriceUsd, 12);

const deletionStarts = await Promise.all([
  call("/api/products/delete-all", { method: "POST" }),
  call("/api/products/delete-all", { method: "POST" }),
]);
deletionStarts.forEach(({ response }) => assert.ok([200, 201].includes(response.status)));
assert.equal(deletionStarts[0].body.job.id, deletionStarts[1].body.job.id);
let deletionJob = deletionStarts[0].body.job;
const queuedImport = await call("/api/imports", {
  method: "POST",
  body: JSON.stringify({
    fileName: "despues-de-borrar.xlsx",
    sheetName: "Inventario",
    strategy: "update",
    rows: [{ ...importRows[0], name: "Producto después de borrar", code: "POST-DELETE-001" }],
  }),
});
const waitingImport = await call(`/api/imports/${queuedImport.body.job.id}/process`, { method: "POST" });
assert.equal(waitingImport.response.status, 200);
assert.equal(waitingImport.body.waitingForDeletion, true);
assert.equal(waitingImport.body.job.status, "queued");
await new Promise((resolve) => setTimeout(resolve, 12));
const preserveBase = (await call("/api/products?code=CC-001")).body.product;
const preserveEdit = await call(`/api/products/${preserveBase.id}`, {
  method: "PUT",
  body: JSON.stringify({ ...preserveBase, name: "Producto preservado", version: preserveBase.version, base: preserveBase }),
});
assert.equal(preserveEdit.response.status, 200);
for (let round = 0; round < 10 && !["completed", "failed"].includes(deletionJob.status); round += 1) {
  const steps = await Promise.all(Array.from({ length: 4 }, () => call(`/api/products/delete-all/${deletionJob.id}/process`, { method: "POST" })));
  steps.forEach(({ response }) => assert.equal(response.status, 200));
  deletionJob = steps.map((step) => step.body.job).sort((left, right) => right.processedProducts - left.processedProducts)[0];
  if (deletionJob.status !== "completed") deletionJob = (await call("/api/products/delete-all")).body.jobs.find((job) => job.id === deletionJob.id);
}
assert.equal(deletionJob.status, "completed");
assert.equal(deletionJob.processedProducts, deletionJob.totalProducts);
assert.equal(deletionJob.preservedProducts, 1);
const remaining = await call("/api/products?limit=5000");
assert.deepEqual(remaining.body.products.map((product) => product.name), ["Producto preservado"]);

let queuedJob = queuedImport.body.job;
for (let round = 0; round < 5 && queuedJob.status !== "completed"; round += 1) {
  queuedJob = (await call(`/api/imports/${queuedJob.id}/process`, { method: "POST" })).body.job;
}
assert.equal(queuedJob.status, "completed");
assert.equal((await call("/api/products?code=POST-DELETE-001")).body.product.name, "Producto después de borrar");

const restored = await call(`/api/imports/${deletionJob.backupImportId}/restore`, { method: "POST" });
assert.equal(restored.response.status, 200);
assert.equal(restored.body.restored, true);
assert.equal(restored.body.products, deletionJob.totalProducts);
assert.equal((await call("/api/products?limit=5000")).body.products.length, deletionJob.totalProducts);
assert.equal((await call("/api/products?code=POST-DELETE-001")).body.product, null);

DB.close();
console.log("Concurrency, queued imports, restore, bulk quantities, and bulk deletion checks passed");
