import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");

const journal = JSON.parse(
  await readFile(
    new URL("../drizzle/meta/_journal.json", import.meta.url),
    "utf8",
  ),
);

for (const entry of journal.entries.filter((entry) => entry.idx <= 19)) {
  const sql = await readFile(
    new URL(`../drizzle/${entry.tag}.sql`, import.meta.url),
    "utf8",
  );

  for (
    const statement of sql
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .filter(Boolean)
  ) {
    db.exec(statement);
  }
}

db.prepare(`
  INSERT INTO chatwoot_webhook_jobs (
    id,
    delivery_id,
    event_type,
    chatwoot_account_id
  )
  VALUES (
    'before-0020',
    'delivery-before-0020',
    'contact_updated',
    1
  )
`).run();

const migration = await readFile(
  new URL("../drizzle/0020_meta_capi_outbox.sql", import.meta.url),
  "utf8",
);

for (
  const statement of migration
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean)
) {
  db.exec(statement);
}

assert.ok(
  db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type='table'
      AND name='meta_capi_jobs'
  `).get(),
);

db.prepare(`
  INSERT INTO meta_capi_jobs (
    id,
    dedupe_key,
    event_id,
    event_name,
    event_time,
    order_id,
    order_number,
    value_crc,
    chatwoot_account_id,
    chatwoot_conversation_id
  )
  VALUES (
    'job-1',
    'purchase:order-1',
    'np-purchase-order-1',
    'Purchase',
    '2026-09-21T12:00:00.000Z',
    'order-1',
    'NP-0001',
    23100,
    1,
    900
  )
`).run();

assert.throws(
  () =>
    db.prepare(`
      INSERT INTO meta_capi_jobs (
        id,
        dedupe_key,
        event_id,
        event_name,
        event_time,
        chatwoot_account_id,
        chatwoot_conversation_id
      )
      VALUES (
        'job-2',
        'purchase:order-1',
        'np-purchase-order-2',
        'Purchase',
        '2026-09-21T12:01:00.000Z',
        1,
        900
      )
    `).run(),
  /UNIQUE constraint failed/,
);

assert.throws(
  () =>
    db.prepare(`
      INSERT INTO meta_capi_jobs (
        id,
        dedupe_key,
        event_id,
        event_name,
        event_time,
        chatwoot_account_id,
        chatwoot_conversation_id
      )
      VALUES (
        'job-3',
        'purchase:order-3',
        'np-purchase-order-1',
        'Purchase',
        '2026-09-21T12:02:00.000Z',
        1,
        900
      )
    `).run(),
  /UNIQUE constraint failed/,
);

assert.throws(
  () =>
    db.prepare(`
      INSERT INTO meta_capi_jobs (
        id,
        dedupe_key,
        event_id,
        event_name,
        event_time,
        chatwoot_account_id,
        chatwoot_conversation_id
      )
      VALUES (
        'job-invalid-event',
        'invalid:event',
        'invalid-event',
        'SomethingElse',
        '2026-09-21T12:03:00.000Z',
        1,
        900
      )
    `).run(),
  /CHECK constraint failed/,
);

assert.throws(
  () =>
    db.prepare(`
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
      VALUES (
        'job-invalid-status',
        'invalid:status',
        'invalid-status',
        'Purchase',
        '2026-09-21T12:04:00.000Z',
        1,
        900,
        'unknown'
      )
    `).run(),
  /CHECK constraint failed/,
);

assert.throws(
  () =>
    db.prepare(`
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
      VALUES (
        'job-invalid-attempts',
        'invalid:attempts',
        'invalid-attempts',
        'Purchase',
        '2026-09-21T12:05:00.000Z',
        1,
        900,
        -1
      )
    `).run(),
  /CHECK constraint failed/,
);

assert.equal(
  db.prepare(`
    SELECT count(*) AS total
    FROM chatwoot_webhook_jobs
    WHERE id='before-0020'
  `).get().total,
  1,
);

db.close();

console.log(
  "Migration 0020 adds the durable Meta CAPI outbox, enforces dedupe/check constraints, and preserves existing data",
);
