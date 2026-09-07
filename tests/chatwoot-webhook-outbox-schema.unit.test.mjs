import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LocalD1Database } from "./helpers/local-bindings.mjs";
import { CHATWOOT_WEBHOOK_OUTBOX_SQL, ensureChatwootWebhookOutboxSchema } from "../lib/chatwoot-webhook-outbox.ts";

const normalize = (value) => value.toLowerCase().replace(/if not exists/g, "").replace(/[\s`();]/g, "");

test("runtime outbox schema and formal migration have the same table and indexes", async () => {
  const migration = await readFile(new URL("../drizzle/0019_chatwoot_webhook_outbox.sql", import.meta.url), "utf8");
  const runtime = CHATWOOT_WEBHOOK_OUTBOX_SQL.join("\n");
  for (const token of [
    "chatwoot_webhook_jobs", "delivery_id", "event_type", "chatwoot_account_id", "chatwoot_contact_id",
    "chatwoot_conversation_id", "status", "attempts", "last_error", "next_attempt_at", "lease_token",
    "lease_expires_at", "created_at", "updated_at", "completed_at", "chatwoot_webhook_jobs_delivery_unique",
    "chatwoot_webhook_jobs_due_idx", "chatwoot_webhook_jobs_lease_idx",
  ]) {
    assert.equal(normalize(runtime).includes(normalize(token)), true, `runtime missing ${token}`);
    assert.equal(normalize(migration).includes(normalize(token)), true, `migration missing ${token}`);
  }
  assert.equal(/\b(?:drop|alter|delete)\b/i.test(runtime), false);
  assert.equal(/\b(?:drop|alter|delete)\b/i.test(migration), false);

  const runtimeDb = new LocalD1Database();
  const migrationDb = new LocalD1Database();
  await ensureChatwootWebhookOutboxSchema(runtimeDb);
  for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) migrationDb.sqlite.exec(statement);
  const inspect = (db) => ({
    columns: db.sqlite.prepare("PRAGMA table_info(chatwoot_webhook_jobs)").all().map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk })),
    indexes: db.sqlite.prepare("PRAGMA index_list(chatwoot_webhook_jobs)").all().map(({ name, unique }) => ({ name, unique })).filter((index) => index.name.startsWith("chatwoot_webhook_jobs_")).sort((a, b) => a.name.localeCompare(b.name)),
  });
  assert.deepEqual(inspect(runtimeDb), inspect(migrationDb));
  runtimeDb.close(); migrationDb.close();
});
