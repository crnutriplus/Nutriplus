import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries.filter((entry) => entry.idx <= 18)) {
  const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) db.exec(statement);
}
db.prepare("INSERT INTO crm_operations (operation_id,operation_type,request_hash,status) VALUES ('before-0019','TEST','hash','COMPLETED')").run();
const migration = await readFile(new URL("../drizzle/0019_chatwoot_webhook_outbox.sql", import.meta.url), "utf8");
for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) db.exec(statement);
assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chatwoot_webhook_jobs'").get());
db.prepare("INSERT INTO chatwoot_webhook_jobs (id,delivery_id,event_type,chatwoot_account_id,chatwoot_contact_id) VALUES ('job-1','delivery-1','contact_updated',1,42)").run();
assert.throws(() => db.prepare("INSERT INTO chatwoot_webhook_jobs (id,delivery_id,event_type,chatwoot_account_id) VALUES ('job-2','delivery-1','contact_updated',1)").run(), /UNIQUE constraint failed/);
assert.equal(db.prepare("SELECT count(*) AS total FROM crm_operations WHERE operation_id='before-0019'").get().total, 1);
db.close(); console.log("Migration 0019 adds a durable Chatwoot webhook outbox without changing existing CRM data");
