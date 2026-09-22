import assert from "node:assert/strict";
import test from "node:test";
import { LocalD1Database } from "./helpers/local-bindings.mjs";
import { META_CAPI_DATABASE_SQL } from "../lib/meta-capi-database.ts";
import {
  loadMetaCapiStatus,
  parseMetaCapiOrderNumber,
} from "../lib/meta-capi-status.ts";

test("validates and normalizes order number", () => {
  assert.equal(parseMetaCapiOrderNumber("np-000020"), "NP-000020");
  assert.throws(() => parseMetaCapiOrderNumber("20"), /NP-000000/);
  assert.throws(() => parseMetaCapiOrderNumber(null), /NP-000000/);
});

test("returns only requested order without modifying outbox", async () => {
  const db = new LocalD1Database();

  await db.batch(
    META_CAPI_DATABASE_SQL.map((sql) => db.prepare(sql)),
  );

  db.sqlite.prepare(`
    INSERT INTO meta_capi_jobs (
      id, dedupe_key, event_id, event_name, event_time,
      order_id, order_number, value_crc,
      chatwoot_account_id, chatwoot_conversation_id,
      status, attempts
    ) VALUES (
      'job-20',
      'purchase:order-20',
      'np-purchase-order-20',
      'Purchase',
      '2026-09-22T05:00:00.000Z',
      'order-20',
      'NP-000020',
      23100,
      1,
      85,
      'completed',
      1
    )
  `).run();

  db.sqlite.prepare(`
    INSERT INTO meta_capi_jobs (
      id, dedupe_key, event_id, event_name, event_time,
      order_id, order_number,
      chatwoot_account_id, chatwoot_conversation_id
    ) VALUES (
      'other',
      'purchase:other',
      'np-purchase-other',
      'Purchase',
      '2026-09-22T05:01:00.000Z',
      'other',
      'NP-999999',
      1,
      99
    )
  `).run();

  const before = db.sqlite
    .prepare("SELECT COUNT(*) AS n FROM meta_capi_jobs")
    .get().n;

  const rows = await loadMetaCapiStatus(db, "NP-000020");

  const after = db.sqlite
    .prepare("SELECT COUNT(*) AS n FROM meta_capi_jobs")
    .get().n;

  assert.equal(before, 2);
  assert.equal(after, 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].orderNumber, "NP-000020");
  assert.equal(rows[0].eventName, "Purchase");
  assert.equal(rows[0].valueCrc, 23100);
  assert.equal(rows[0].chatwootConversationId, 85);
  assert.equal(rows[0].status, "completed");
  assert.equal(rows[0].attempts, 1);

  db.close();
});
