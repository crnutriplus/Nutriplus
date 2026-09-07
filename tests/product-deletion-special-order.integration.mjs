import assert from "node:assert/strict";
import { LocalD1Database } from "./helpers/local-bindings.mjs";

const DB = new LocalD1Database();
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("product-deletion-special-order", `${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
const env = {
  DB,
  NUTRIPLUS_APP_AUTH_MODE: "disabled",
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  IMAGES: { input() { throw new Error("Images are not used in API tests."); } },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function call(path, init = {}) {
  const response = await worker.fetch(new Request(`http://local.test${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) },
  }), env, ctx);
  return { response, body: await response.json() };
}

const protectedProduct = await call("/api/products", {
  method: "POST",
  body: JSON.stringify({
    name: "Producto con recibo de encargo",
    code: "SPECIAL-DELETE-GUARD",
    purchasePriceUsd: 10,
    weightLb: 0.5,
    quantityAvailable: 1,
    minimumStock: 0,
    minimumStockEnabled: false,
  }),
});
assert.equal(protectedProduct.response.status, 201);

const removableProduct = await call("/api/products", {
  method: "POST",
  body: JSON.stringify({
    name: "Producto eliminable",
    code: "DELETE-OK",
    purchasePriceUsd: 10,
    weightLb: 0.5,
    quantityAvailable: 1,
    minimumStock: 0,
    minimumStockEnabled: false,
  }),
});
assert.equal(removableProduct.response.status, 201);

await DB.prepare(`INSERT INTO orders (
  id,order_number,customer_name_snapshot,status,currency,subtotal,discount_total,delivery_fee,total,source,created_at,updated_at
) VALUES ('order-special-delete-guard','NP-SPECIAL-DELETE-GUARD','Cliente histórico','DRAFT','CRC',0,0,0,0,'MANUAL',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run();
await DB.prepare(`INSERT INTO order_lines (
  id,order_id,position,product_id,quantity,product_name_snapshot,unit_price_sold,discount_amount,line_subtotal,line_total,created_at,updated_at
) VALUES ('line-special-delete-guard','order-special-delete-guard',1,?,1,'Producto histórico',0,0,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
  .bind(protectedProduct.body.product.id).run();
await DB.prepare(`INSERT INTO special_order_receipts (
  id,order_id,resolution_mode,operation_id,resolved_at,created_at
) VALUES ('receipt-special-delete-guard','order-special-delete-guard','ALREADY_INVENTORY','operation-special-delete-guard',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run();
await DB.prepare(`INSERT INTO special_order_receipt_lines (
  id,receipt_id,order_line_id,product_id,quantity_received,inventory_movement_created,created_at
) VALUES ('receipt-line-special-delete-guard','receipt-special-delete-guard','line-special-delete-guard',?,1,0,CURRENT_TIMESTAMP)`)
  .bind(protectedProduct.body.product.id).run();

let deletion = await call("/api/products/delete-all", { method: "POST" });
assert.equal(deletion.response.status, 201, JSON.stringify(deletion.body));
for (let round = 0; round < 4 && deletion.body.job.status !== "completed"; round += 1) {
  deletion = await call(`/api/products/delete-all/${deletion.body.job.id}/process`, { method: "POST" });
  assert.equal(deletion.response.status, 200, JSON.stringify(deletion.body));
}

assert.equal(deletion.body.job.status, "completed");
assert.equal(deletion.body.job.deletedProducts, 1);
assert.equal(deletion.body.job.preservedProducts, 1);
assert.equal((await call("/api/products?code=SPECIAL-DELETE-GUARD")).body.product.id, protectedProduct.body.product.id);
assert.equal((await call("/api/products?code=DELETE-OK")).body.product, null);

DB.close();
console.log("Bulk deletion preserves products with historical special-order receipts");
