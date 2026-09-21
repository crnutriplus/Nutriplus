import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LocalD1Database } from "./helpers/local-bindings.mjs";

import { META_CAPI_DATABASE_SQL } from "../lib/meta-capi-database.ts";
import { ensureMetaCapiOutboxSchema } from "../lib/meta-capi-outbox.ts";

const normalize = (value) =>
  value
    .toLowerCase()
    .replace(/if not exists/g, "")
    .replace(/[\s`();"]/g, "");

function inspect(db) {
  return {
    columns: db.sqlite
      .prepare("PRAGMA table_info(meta_capi_jobs)")
      .all()
      .map(({ name, type, notnull, dflt_value, pk }) => ({
        name,
        type,
        notnull,
        dflt_value,
        pk,
      })),

    indexes: db.sqlite
      .prepare("PRAGMA index_list(meta_capi_jobs)")
      .all()
      .map(({ name, unique }) => ({ name, unique }))
      .filter((index) =>
        index.name.startsWith("meta_capi_jobs_"),
      )
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function verifyConstraints(db, suffix) {
  db.sqlite.prepare(`
    INSERT INTO meta_capi_jobs (
      id,
      dedupe_key,
      event_id,
      event_name,
      event_time,
      chatwoot_account_id,
      chatwoot_conversation_id
    )
    VALUES (?, ?, ?, 'Purchase', ?, 1, 900)
  `).run(
    `valid-${suffix}`,
    `purchase:valid-${suffix}`,
    `np-purchase-valid-${suffix}`,
    "2026-09-21T12:00:00.000Z",
  );

  assert.throws(
    () =>
      db.sqlite.prepare(`
        INSERT INTO meta_capi_jobs (
          id,
          dedupe_key,
          event_id,
          event_name,
          event_time,
          chatwoot_account_id,
          chatwoot_conversation_id
        )
        VALUES (?, ?, ?, 'InvalidEvent', ?, 1, 900)
      `).run(
        `bad-event-${suffix}`,
        `bad-event:${suffix}`,
        `bad-event-${suffix}`,
        "2026-09-21T12:01:00.000Z",
      ),
    /CHECK constraint failed/,
  );

  assert.throws(
    () =>
      db.sqlite.prepare(`
        INSERT INTO meta_capi_jobs (
          id,
          dedupe_key,
          event_id,
          event_name,
          event_time,
          chatwoot_account_id,
          chatwoot_conversation_id,
          status
        )
        VALUES (?, ?, ?, 'Purchase', ?, 1, 900, 'invalid')
      `).run(
        `bad-status-${suffix}`,
        `bad-status:${suffix}`,
        `bad-status-${suffix}`,
        "2026-09-21T12:02:00.000Z",
      ),
    /CHECK constraint failed/,
  );

  assert.throws(
    () =>
      db.sqlite.prepare(`
        INSERT INTO meta_capi_jobs (
          id,
          dedupe_key,
          event_id,
          event_name,
          event_time,
          chatwoot_account_id,
          chatwoot_conversation_id,
          attempts
        )
        VALUES (?, ?, ?, 'Purchase', ?, 1, 900, -1)
      `).run(
        `bad-attempts-${suffix}`,
        `bad-attempts:${suffix}`,
        `bad-attempts-${suffix}`,
        "2026-09-21T12:03:00.000Z",
      ),
    /CHECK constraint failed/,
  );
}

test(
  "runtime Meta CAPI schema and formal migration are functionally equivalent",
  async () => {
    const migration = await readFile(
      new URL("../drizzle/0020_meta_capi_outbox.sql", import.meta.url),
      "utf8",
    );

    const runtime = META_CAPI_DATABASE_SQL.join("\n");

    for (const token of [
      "meta_capi_jobs",
      "dedupe_key",
      "event_id",
      "event_name",
      "event_time",
      "order_id",
      "order_number",
      "value_crc",
      "chatwoot_account_id",
      "chatwoot_conversation_id",
      "status",
      "attempts",
      "last_error",
      "next_attempt_at",
      "lease_token",
      "lease_expires_at",
      "created_at",
      "updated_at",
      "completed_at",
      "meta_capi_jobs_dedupe_unique",
      "meta_capi_jobs_event_id_unique",
      "meta_capi_jobs_due_idx",
      "meta_capi_jobs_lease_idx",
      "meta_capi_jobs_order_idx",
      "LeadSubmitted",
      "Purchase",
      "pending",
      "processing",
      "completed",
      "failed",
    ]) {
      assert.equal(
        normalize(runtime).includes(normalize(token)),
        true,
        `runtime missing ${token}`,
      );

      assert.equal(
        normalize(migration).includes(normalize(token)),
        true,
        `migration missing ${token}`,
      );
    }

    assert.equal(
      /\b(?:drop|alter|delete)\b/i.test(runtime),
      false,
    );

    assert.equal(
      /\b(?:drop|alter|delete)\b/i.test(migration),
      false,
    );

    const runtimeDb = new LocalD1Database();
    const migrationDb = new LocalD1Database();

    await ensureMetaCapiOutboxSchema(runtimeDb);

    for (
      const statement of migration
        .split("--> statement-breakpoint")
        .map((part) => part.trim())
        .filter(Boolean)
    ) {
      migrationDb.sqlite.exec(statement);
    }

    assert.deepEqual(
      inspect(runtimeDb),
      inspect(migrationDb),
    );

    verifyConstraints(runtimeDb, "runtime");
    verifyConstraints(migrationDb, "migration");

    runtimeDb.close();
    migrationDb.close();
  },
);
