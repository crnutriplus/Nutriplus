import assert from "node:assert/strict";
import test from "node:test";
import { LocalD1Database } from "./helpers/local-bindings.mjs";

import { META_CAPI_DATABASE_SQL } from "../lib/meta-capi-database.ts";
import {
  claimNextMetaCapiJob,
  drainMetaCapiJobs,
  enqueueMetaCapiJob,
  ensureMetaCapiOutboxSchema,
  processNextMetaCapiJob,
  prepareMetaCapiPurchaseInsertForOrder,
  resetMetaCapiOutboxRuntimeForTests,
  shouldRunMetaCapiOpportunisticDrain,
} from "../lib/meta-capi-outbox.ts";

function db() {
  const value = new LocalD1Database();
  for (const statement of META_CAPI_DATABASE_SQL) {
    value.sqlite.exec(statement);
  }
  return value;
}

function lead(overrides = {}) {
  return {
    dedupeKey: "lead:1:75",
    eventId: "np-lead-1-75",
    eventName: "LeadSubmitted",
    eventTime: "2026-09-20T00:00:00.000Z",
    orderId: "order-1",
    accountId: 1,
    conversationId: 75,
    ...overrides,
  };
}

test("isolated schema bootstrap creates only CAPI outbox and is idempotent", async () => {
  const value = new LocalD1Database();

  value.sqlite.exec(
    "CREATE TABLE existing_business_data (id INTEGER PRIMARY KEY, note TEXT NOT NULL)",
  );
  value.sqlite.exec(
    "INSERT INTO existing_business_data VALUES (1, 'preserve')",
  );

  let batches = 0;
  const originalBatch = value.batch.bind(value);
  value.batch = async (statements) => {
    batches++;
    return originalBatch(statements);
  };

  await ensureMetaCapiOutboxSchema(value);
  await ensureMetaCapiOutboxSchema(value);

  assert.equal(batches, 1);
  assert.equal(
    value.sqlite
      .prepare("SELECT note FROM existing_business_data WHERE id=1")
      .get().note,
    "preserve",
  );
  assert.equal(
    value.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='meta_capi_jobs'",
      )
      .get().name,
    "meta_capi_jobs",
  );

  value.close();
});

test("normal traffic drain throttle allows first attempt and throttles the isolate", () => {
  resetMetaCapiOutboxRuntimeForTests();

  assert.equal(shouldRunMetaCapiOpportunisticDrain(1_000), true);
  assert.equal(shouldRunMetaCapiOpportunisticDrain(1_001), false);
  assert.equal(shouldRunMetaCapiOpportunisticDrain(61_000), true);

  resetMetaCapiOutboxRuntimeForTests();
});

test("durably deduplicates the same business conversion", async () => {
  const value = db();

  assert.deepEqual(await enqueueMetaCapiJob(value, lead()), {
    created: true,
  });

  assert.deepEqual(
    await enqueueMetaCapiJob(
      value,
      lead({ eventId: "np-lead-retry-different-id" }),
    ),
    { created: false },
  );

  const row = value.sqlite
    .prepare("SELECT * FROM meta_capi_jobs")
    .get();

  assert.equal(row.dedupe_key, "lead:1:75");
  assert.equal(row.event_id, "np-lead-1-75");
  assert.equal(row.chatwoot_conversation_id, 75);

  value.close();
});

test("outbox stores only canonical conversion data, not arbitrary conversation content", async () => {
  const value = db();

  await enqueueMetaCapiJob(value, {
    ...lead(),
    message: "diagnostico o texto que nunca debe persistirse",
    productInterest: "contenido sensible",
  });

  const row = value.sqlite
    .prepare("SELECT * FROM meta_capi_jobs")
    .get();

  const serialized = JSON.stringify(row);

  assert.equal(serialized.includes("diagnostico"), false);
  assert.equal(serialized.includes("contenido sensible"), false);

  value.close();
});

test("independent conversions retain independent jobs", async () => {
  const value = db();

  assert.equal((await enqueueMetaCapiJob(value, lead())).created, true);

  assert.equal(
    (
      await enqueueMetaCapiJob(
        value,
        lead({
          dedupeKey: "purchase:order-1",
          eventId: "np-purchase-order-1",
          eventName: "Purchase",
          orderNumber: "NP-0001",
          valueCrc: 23100,
        }),
      )
    ).created,
    true,
  );

  assert.equal(
    value.sqlite
      .prepare("SELECT count(*) AS total FROM meta_capi_jobs")
      .get().total,
    2,
  );

  value.close();
});

test("only one concurrent consumer claims a CAPI job", async () => {
  const value = db();
  await enqueueMetaCapiJob(value, lead());

  let calls = 0;
  const processor = async () => {
    calls++;
  };

  const results = await Promise.all([
    processNextMetaCapiJob(value, processor),
    processNextMetaCapiJob(value, processor),
  ]);

  assert.equal(
    results.filter((result) => result.processed).length,
    1,
  );
  assert.equal(calls, 1);
  assert.equal(
    value.sqlite
      .prepare(
        "SELECT count(*) AS total FROM meta_capi_jobs WHERE status='completed'",
      )
      .get().total,
    1,
  );

  value.close();
});

test("failed work retries and stores only a sanitized error code", async () => {
  const value = db();
  await enqueueMetaCapiJob(value, lead());

  const start = Date.now();

  const first = await processNextMetaCapiJob(
    value,
    async () => {
      throw new Error("access_token=must-never-be-stored");
    },
    start,
  );

  assert.equal(first.completed, false);

  const failed = value.sqlite
    .prepare(
      "SELECT status,attempts,last_error,next_attempt_at FROM meta_capi_jobs",
    )
    .get();

  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 1);
  assert.equal(
    failed.last_error,
    "META_CAPI_JOB_PROCESSING_FAILED",
  );
  assert.equal(
    JSON.stringify(failed).includes("must-never-be-stored"),
    false,
  );

  let completed = 0;

  const retry = await processNextMetaCapiJob(
    value,
    async () => {
      completed++;
    },
    start + 2_001,
  );

  assert.equal(retry.completed, true);
  assert.equal(completed, 1);
  assert.equal(
    value.sqlite
      .prepare("SELECT status FROM meta_capi_jobs")
      .get().status,
    "completed",
  );

  value.close();
});

test("expired processing lease is recoverable without double-processing", async () => {
  const value = db();
  await enqueueMetaCapiJob(value, lead());

  const start = Date.now();
  const claimed = await claimNextMetaCapiJob(value, start);
  assert.ok(claimed);

  let calls = 0;

  const drained = await drainMetaCapiJobs(
    value,
    async () => {
      calls++;
    },
    3,
  );

  assert.equal(drained.processed, 0);
  assert.equal(calls, 0);

  const recovered = await processNextMetaCapiJob(
    value,
    async () => {
      calls++;
    },
    start + 120_001,
  );

  assert.equal(recovered.completed, true);
  assert.equal(calls, 1);

  value.close();
});


test("Purchase is queued only when the order has a Chatwoot conversation and PRIMARY wins", async () => {
  const value = db();

  value.sqlite.exec(`
    CREATE TABLE chatwoot_conversation_order_links (
      id TEXT PRIMARY KEY NOT NULL,
      chatwoot_account_id INTEGER NOT NULL,
      chatwoot_conversation_id INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      link_role TEXT NOT NULL
    )
  `);

  let result = await prepareMetaCapiPurchaseInsertForOrder(
    value,
    {
      orderId: "order-100",
      orderNumber: "NP-0100",
      eventTime: "2026-09-20T00:30:00.000Z",
      valueCrc: 23100,
    },
  ).run();

  assert.equal(result.meta.changes, 0);
  assert.equal(
    value.sqlite
      .prepare("SELECT count(*) AS total FROM meta_capi_jobs")
      .get().total,
    0,
  );

  value.sqlite.exec(`
    INSERT INTO chatwoot_conversation_order_links
      (id,chatwoot_account_id,chatwoot_conversation_id,order_id,link_role)
    VALUES
      ('related',1,100,'order-100','RELATED'),
      ('primary',1,200,'order-100','PRIMARY')
  `);

  result = await prepareMetaCapiPurchaseInsertForOrder(
    value,
    {
      orderId: "order-100",
      orderNumber: "NP-0100",
      eventTime: "2026-09-20T00:30:00.000Z",
      valueCrc: 23100,
    },
  ).run();

  assert.equal(result.meta.changes, 1);

  const row = value.sqlite
    .prepare("SELECT * FROM meta_capi_jobs")
    .get();

  assert.equal(row.event_name, "Purchase");
  assert.equal(row.dedupe_key, "purchase:order-100");
  assert.equal(row.event_id, "np-purchase-order-100");
  assert.equal(row.order_number, "NP-0100");
  assert.equal(row.value_crc, 23100);
  assert.equal(row.chatwoot_conversation_id, 200);

  const replay = await prepareMetaCapiPurchaseInsertForOrder(
    value,
    {
      orderId: "order-100",
      orderNumber: "NP-0100",
      eventTime: "2026-09-20T00:31:00.000Z",
      valueCrc: 99999,
    },
  ).run();

  assert.equal(replay.meta.changes, 0);
  assert.equal(
    value.sqlite
      .prepare("SELECT count(*) AS total FROM meta_capi_jobs")
      .get().total,
    1,
  );

  value.close();
});

test("unsupported messaging channel is terminal and is not retried", async () => {
  const value = db();
  await enqueueMetaCapiJob(value, lead());

  const result = await processNextMetaCapiJob(
    value,
    async () => {
      throw Object.assign(
        new Error("unsupported channel"),
        {
          code: "META_CAPI_MESSAGING_CHANNEL_UNSUPPORTED",
          terminal: true,
        },
      );
    },
  );

  assert.equal(result.processed, true);
  assert.equal(result.completed, true);
  assert.equal(result.skipped, true);

  const row = value.sqlite
    .prepare(
      "SELECT status,attempts,last_error FROM meta_capi_jobs",
    )
    .get();

  assert.equal(row.status, "completed");
  assert.equal(row.attempts, 1);
  assert.equal(
    row.last_error,
    "META_CAPI_MESSAGING_CHANNEL_UNSUPPORTED",
  );

  const second = await processNextMetaCapiJob(
    value,
    async () => {
      throw new Error("must not run");
    },
  );

  assert.equal(second.processed, false);

  value.close();
});
