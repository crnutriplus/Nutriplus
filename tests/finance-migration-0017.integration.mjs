import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys=ON");
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));

for (const entry of journal.entries.filter((candidate) => candidate.idx <= 16)) {
  const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) sqlite.exec(statement);
}

const product = sqlite.prepare(`INSERT INTO products (
  name,normalized_name,code,quantity_available,minimum_stock,minimum_stock_enabled,version
) VALUES ('Producto previo a Finanzas','producto previo a finanzas','LEGACY-FIN-0017',8,2,1,1)`).run();
const productId = Number(product.lastInsertRowid);
sqlite.prepare("INSERT INTO order_number_allocations (order_id) VALUES (?)").run("order-before-0017");
sqlite.prepare(`INSERT INTO orders (
  id,order_number,order_type,customer_name_snapshot,status,currency,subtotal,discount_total,delivery_fee,total,source,version
) VALUES ('order-before-0017','NP-810001','STANDARD','Cliente previo','DELIVERED','CRC',20000,2000,1000,19000,'MANUAL',3)`).run();
sqlite.prepare(`INSERT INTO order_lines (
  id,order_id,position,product_id,quantity,product_name_snapshot,unit_price_original,unit_price_sold,discount_amount,line_subtotal,line_total,historical_cost_snapshot
) VALUES ('line-before-0017','order-before-0017',1,?,1,'Producto previo a Finanzas',20000,20000,2000,20000,18000,12000)`).run(productId);

const before = sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const beforeNames = before.map((row) => row.name);
const beforeDefinitions = new Map(before.map((row) => [row.name, row.sql]));
const beforeCounts = new Map(beforeNames.map((table) => [table, Number(sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total)]));

const migration = await readFile(new URL("../drizzle/0017_equal_microchip.sql", import.meta.url), "utf8");
sqlite.exec("BEGIN IMMEDIATE");
try {
  for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) sqlite.exec(statement);
  sqlite.exec("COMMIT");
} catch (error) {
  sqlite.exec("ROLLBACK");
  throw error;
}

const newTables = [
  "finance_budgets",
  "finance_expenses",
  "finance_recurring_templates",
  "finance_sale_events",
  "finance_sale_lines",
  "finance_sales",
];
const afterNames = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
assert.equal(afterNames.length, beforeNames.length + newTables.length, "0017 must add exactly six finance tables");
for (const table of newTables) assert.ok(afterNames.includes(table), `${table} must exist after 0017`);
for (const table of beforeNames) {
  assert.ok(afterNames.includes(table), `${table} must remain after 0017`);
  assert.equal(Number(sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total), beforeCounts.get(table), `${table} data must survive 0017`);
  assert.equal(sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql, beforeDefinitions.get(table), `${table} definition must remain unchanged`);
}
assert.equal(sqlite.prepare("SELECT historical_cost_snapshot FROM order_lines WHERE id='line-before-0017'").get().historical_cost_snapshot, 12000);

sqlite.prepare(`INSERT INTO finance_sales (
  id,order_id,order_number,customer_name_snapshot,delivered_at,currency,product_gross_total,discount_total,
  product_net_total,delivery_income,total_income,historical_cogs_total,cost_status,source_operation_id,status
) VALUES ('sale-0017','order-before-0017','NP-810001','Cliente previo','2026-08-29T12:00:00.000Z','CRC',20000,2000,18000,1000,19000,12000,'COMPLETE','deliver-0017','RECOGNIZED')`).run();
assert.throws(() => sqlite.prepare(`INSERT INTO finance_sales (
  id,order_id,order_number,customer_name_snapshot,delivered_at,currency,product_gross_total,discount_total,
  product_net_total,delivery_income,total_income,historical_cogs_total,cost_status,source_operation_id,status
) VALUES ('sale-duplicate','order-before-0017','NP-810001','Cliente previo','2026-08-29T12:01:00.000Z','CRC',20000,2000,18000,1000,19000,12000,'COMPLETE','deliver-duplicate','RECOGNIZED')`).run(), /UNIQUE constraint failed/);

sqlite.prepare(`INSERT INTO finance_expenses (
  id,expense_date,category,description,amount_crc,original_amount_minor,currency,exchange_rate_crc,payment_method,
  source_type,idempotency_key,entry_type,business_scope
) VALUES ('expense-0017','2026-08-29','FUEL','Combustible ruta',5000,5000,'CRC',1,'CASH','MANUAL','expense-op-0017','EXPENSE','BUSINESS')`).run();
assert.throws(() => sqlite.prepare(`INSERT INTO finance_expenses (
  id,expense_date,category,description,amount_crc,original_amount_minor,currency,exchange_rate_crc,payment_method,
  source_type,idempotency_key,entry_type,business_scope
) VALUES ('expense-duplicate','2026-08-29','FUEL','Combustible ruta',5000,5000,'CRC',1,'CASH','MANUAL','expense-op-0017','EXPENSE','BUSINESS')`).run(), /UNIQUE constraint failed/);

sqlite.close();
console.log("Migration 0017 is additive, preserves prior data and enforces finance idempotency guards");
