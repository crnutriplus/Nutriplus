import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));

for (const entry of journal.entries.filter((entry) => entry.idx <= 19)) {
  const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) db.exec(statement);
}

db.prepare("INSERT INTO crm_operations (operation_id,operation_type,request_hash,status) VALUES ('before-0020','TEST','hash','COMPLETED')").run();

const migration = await readFile(new URL("../drizzle/0020_crm_dashboard_sessions.sql", import.meta.url), "utf8");
for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) db.exec(statement);

assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_dashboard_sessions'").get());

const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='crm_dashboard_sessions' ORDER BY name").all().map((row) => row.name);
assert.ok(indexes.includes("crm_dashboard_sessions_jti_unique"));
assert.ok(indexes.includes("crm_dashboard_sessions_expiry_idx"));
assert.ok(indexes.includes("crm_dashboard_sessions_context_idx"));

db.prepare("INSERT INTO crm_dashboard_sessions (id,bootstrap_jti,chatwoot_account_id,chatwoot_contact_id,chatwoot_conversation_id,chatwoot_agent_id,expires_at) VALUES ('session-1','jti-1',1,42,93,7,'2099-01-01T00:00:00Z')").run();
assert.throws(() => db.prepare("INSERT INTO crm_dashboard_sessions (id,bootstrap_jti,chatwoot_account_id,chatwoot_contact_id,chatwoot_conversation_id,chatwoot_agent_id,expires_at) VALUES ('session-2','jti-1',1,42,94,7,'2099-01-01T00:00:00Z')").run(), /UNIQUE constraint failed/);

assert.equal(db.prepare("SELECT count(*) AS total FROM crm_operations WHERE operation_id='before-0020'").get().total, 1);

db.close();
console.log("Migration 0020 adds durable CRM dashboard sessions with one-time bootstrap jti protection");
