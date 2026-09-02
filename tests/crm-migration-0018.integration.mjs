import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries.filter((entry) => entry.idx <= 17)) {
  const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) db.exec(statement);
}
db.prepare("INSERT INTO order_number_allocations (order_id) VALUES (?)").run("order-before-0018");
db.prepare(`INSERT INTO orders (id,order_number,order_type,customer_name_snapshot,status,currency,subtotal,discount_total,delivery_fee,total,source,version) VALUES ('order-before-0018','NP-820001','STANDARD','Cliente anterior','DRAFT','CRC',1,0,0,1,'MANUAL',1)`).run();
const before = db.prepare("SELECT COUNT(*) AS total FROM orders").get().total;
const migration = await readFile(new URL("../drizzle/0018_friendly_bedlam.sql", import.meta.url), "utf8");
for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) db.exec(statement);
for (const table of ["customers","customer_external_identities","chatwoot_contact_links","chatwoot_conversation_order_links","crm_operations"]) assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), `${table} must exist`);
assert.equal(db.prepare("SELECT COUNT(*) AS total FROM orders").get().total, before, "existing orders must remain intact");
db.prepare("INSERT INTO customers (id,name,phone_normalized) VALUES ('customer-1','Cliente','+50670000000')").run();
assert.throws(() => db.prepare("INSERT INTO customers (id,name,phone_normalized) VALUES ('customer-2','Duplicado','+50670000000')").run(), /UNIQUE constraint failed/);
db.prepare("INSERT INTO customer_external_identities (id,customer_id,provider,external_account,external_id) VALUES ('identity-1','customer-1','instagram','inbox-1','ig-1')").run();
assert.throws(() => db.prepare("INSERT INTO customer_external_identities (id,customer_id,provider,external_account,external_id) VALUES ('identity-2','customer-1','instagram','inbox-1','ig-1')").run(), /UNIQUE constraint failed/);
db.close(); console.log("Migration 0018 preserves orders and enforces CRM identity constraints");
