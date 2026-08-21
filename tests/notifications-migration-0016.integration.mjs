import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { NOTIFICATION_DATABASE_TRIGGER_SQL } from "../lib/notifications-database.ts";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys=ON");
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));

for (const entry of journal.entries.filter((candidate) => candidate.idx <= 15)) {
  const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) sqlite.exec(statement);
}

const existingProduct = sqlite.prepare(`INSERT INTO products (
  name,normalized_name,code,quantity_available,minimum_stock,minimum_stock_enabled,version
) VALUES ('Producto existente 0016','producto existente 0016','LEGACY-NOTIFY-0016',7,2,1,1)`).run();
const productId = Number(existingProduct.lastInsertRowid);
sqlite.prepare("INSERT INTO order_number_allocations (order_id) VALUES (?)").run("order-before-0016");
sqlite.prepare(`INSERT INTO orders (
  id,order_number,order_type,customer_name_snapshot,status,currency,subtotal,discount_total,delivery_fee,total,source,version
) VALUES ('order-before-0016','NP-800001','STANDARD','Cliente existente','DRAFT','CRC',5000,0,0,5000,'MANUAL',1)`).run();
sqlite.prepare(`INSERT INTO order_lines (
  id,order_id,position,product_id,quantity,product_name_snapshot,unit_price_sold,discount_amount,line_subtotal,line_total
) VALUES ('line-before-0016','order-before-0016',1,?,1,'Producto existente 0016',5000,0,5000,5000)`).run(productId);

const before = sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const beforeNames = before.map((row) => row.name);
const beforeDefinitions = new Map(before.map((row) => [row.name, row.sql]));
const beforeCounts = new Map(beforeNames.map((table) => [table, Number(sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total)]));

const migration = await readFile(new URL("../drizzle/0016_round_scarlet_witch.sql", import.meta.url), "utf8");
sqlite.exec("BEGIN IMMEDIATE");
try {
  for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) sqlite.exec(statement);
  sqlite.exec("COMMIT");
} catch (error) {
  sqlite.exec("ROLLBACK");
  throw error;
}
for (const statement of NOTIFICATION_DATABASE_TRIGGER_SQL) sqlite.exec(statement);

const newTables = [
  "notification_events",
  "notifications",
  "notification_preferences",
  "push_subscriptions",
  "notification_deliveries",
  "notification_resource_states",
];
const afterNames = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
assert.equal(afterNames.length, beforeNames.length + newTables.length, "0016 must add exactly six persistent notification tables");
for (const table of newTables) assert.ok(afterNames.includes(table), `${table} must exist after 0016`);

for (const table of beforeNames) {
  assert.ok(afterNames.includes(table), `${table} must remain after 0016`);
  assert.equal(Number(sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total), beforeCounts.get(table), `${table} data must survive 0016`);
  assert.equal(sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql, beforeDefinitions.get(table), `${table} definition must remain unchanged`);
}

assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM products WHERE id=?").get(productId).total, 1);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM orders WHERE id='order-before-0016'").get().total, 1);
assert.deepEqual({ ...sqlite.prepare("SELECT push_enabled,low_stock_enabled,out_of_stock_enabled,orders_enabled,special_orders_enabled FROM notification_preferences WHERE id=1").get() }, {
  push_enabled: 0,
  low_stock_enabled: 1,
  out_of_stock_enabled: 1,
  orders_enabled: 1,
  special_orders_enabled: 1,
});
assert.deepEqual({ ...sqlite.prepare("SELECT state_value,cycle FROM notification_resource_states WHERE entity_type='product' AND entity_id=? AND state_key='stock'").get(String(productId)) }, {
  state_value: "NORMAL",
  cycle: 0,
});

sqlite.prepare(`INSERT INTO notification_events (
  id,event_type,entity_type,entity_id,dedupe_key,payload_json
) VALUES ('event-0016','inventory.low_stock','product',?,'migration-dedupe-0016','{}')`).run(String(productId));
assert.throws(() => sqlite.prepare(`INSERT INTO notification_events (
  id,event_type,entity_type,entity_id,dedupe_key,payload_json
) VALUES ('event-0016-duplicate','inventory.low_stock','product',?,'migration-dedupe-0016','{}')`).run(String(productId)), /UNIQUE constraint failed/);
sqlite.prepare("DELETE FROM notification_events WHERE id='event-0016'").run();

sqlite.prepare("UPDATE products SET quantity_available=2,version=version+1 WHERE id=?").run(productId);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM notification_events WHERE event_type='inventory.low_stock' AND entity_id=?").get(String(productId)).total, 1, "crossing the threshold after migration must create one durable event");

sqlite.close();
console.log("Migration 0016 is additive, preserves v2.16 data, seeds preferences/state, and installs durable notification guards");
