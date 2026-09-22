import assert from "node:assert/strict";
import test from "node:test";
import { LocalD1Database } from "./helpers/local-bindings.mjs";

test("Meta CAPI status route is read-only and validates input", async () => {
  const db = new LocalD1Database();
  globalThis.__NUTRIPLUS_DB__ = db;

  try {
    const { ensureDatabase } = await import("../db/index.ts");
    await ensureDatabase();

    db.sqlite.prepare(`
      INSERT INTO meta_capi_jobs (
        id, dedupe_key, event_id, event_name, event_time,
        order_id, order_number, value_crc,
        chatwoot_account_id, chatwoot_conversation_id,
        status, attempts
      ) VALUES (
        'route-job', 'purchase:route-order',
        'np-purchase-route-order', 'Purchase',
        '2026-09-22T05:00:00.000Z',
        'route-order', 'NP-000020', 23100,
        1, 85, 'completed', 1
      )
    `).run();

    const { GET } = await import(
      "../app/api/operations/meta-capi-status/route.ts"
    );

    const bad = await GET(new Request(
      "https://nutriplus.test/api/operations/meta-capi-status?orderNumber=20"
    ));
    assert.equal(bad.status, 400);

    const before = db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM meta_capi_jobs")
      .get().n;

    const ok = await GET(new Request(
      "https://nutriplus.test/api/operations/meta-capi-status?orderNumber=NP-000020"
    ));

    assert.equal(ok.status, 200);
    const body = await ok.json();

    assert.equal(body.orderNumber, "NP-000020");
    assert.equal(body.count, 1);
    assert.equal(body.jobs[0].eventName, "Purchase");
    assert.equal(body.jobs[0].status, "completed");
    assert.equal(body.jobs[0].chatwootConversationId, 85);

    const after = db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM meta_capi_jobs")
      .get().n;

    assert.equal(after, before);
  } finally {
    db.close();
    delete globalThis.__NUTRIPLUS_DB__;
  }
});
