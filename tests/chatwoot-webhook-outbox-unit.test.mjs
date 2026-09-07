import assert from "node:assert/strict";
import test from "node:test";
import { LocalD1Database } from "./helpers/local-bindings.mjs";
import {
  CHATWOOT_WEBHOOK_OUTBOX_SQL,
  chatwootWebhookJobFromPayload,
  claimNextChatwootWebhookJob,
  drainChatwootWebhookJobs,
  enqueueChatwootWebhookJob,
  ensureChatwootWebhookOutboxSchema,
  processNextChatwootWebhookJob,
  resetChatwootWebhookOutboxRuntimeForTests,
  shouldRunChatwootWebhookOpportunisticDrain,
} from "../lib/chatwoot-webhook-outbox.ts";

function db() {
  const value = new LocalD1Database();
  for (const statement of CHATWOOT_WEBHOOK_OUTBOX_SQL) value.sqlite.exec(statement);
  return value;
}

function contactJob(deliveryId = "delivery-1") {
  return chatwootWebhookJobFromPayload("contact_updated", deliveryId, {
    account: { id: 1 }, contact: { id: 42, name: "not persisted", message: "not persisted" },
  });
}

test("isolated schema bootstrap creates only the outbox and is idempotent", async () => {
  const value = new LocalD1Database();
  value.sqlite.exec("CREATE TABLE existing_business_data (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
  value.sqlite.exec("INSERT INTO existing_business_data VALUES (1, 'preserve')");
  let batches = 0; const originalBatch = value.batch.bind(value);
  value.batch = async (statements) => { batches++; return originalBatch(statements); };
  await ensureChatwootWebhookOutboxSchema(value);
  await ensureChatwootWebhookOutboxSchema(value);
  assert.equal(batches, 1);
  assert.equal(value.sqlite.prepare("SELECT note FROM existing_business_data WHERE id=1").get().note, "preserve");
  assert.equal(value.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chatwoot_webhook_jobs'").get().name, "chatwoot_webhook_jobs");
  value.close();
});

test("normal-traffic drain throttle is per-isolate and never suppresses the first attempt", () => {
  resetChatwootWebhookOutboxRuntimeForTests();
  assert.equal(shouldRunChatwootWebhookOpportunisticDrain(1_000), true);
  assert.equal(shouldRunChatwootWebhookOpportunisticDrain(1_001), false);
  assert.equal(shouldRunChatwootWebhookOpportunisticDrain(61_000), true);
  resetChatwootWebhookOutboxRuntimeForTests();
});

test("queues only canonical IDs and deduplicates a delivery durably", async () => {
  const value = db(); const job = contactJob(); assert.ok(job);
  assert.deepEqual(job, { deliveryId: "delivery-1", eventType: "contact_updated", accountId: 1, contactId: 42, conversationId: null });
  assert.deepEqual(await enqueueChatwootWebhookJob(value, job), { created: true });
  assert.deepEqual(await enqueueChatwootWebhookJob(value, job), { created: false });
  const row = value.sqlite.prepare("SELECT * FROM chatwoot_webhook_jobs").get();
  assert.equal(row.delivery_id, "delivery-1"); assert.equal(row.chatwoot_contact_id, 42);
  assert.equal(Object.hasOwn(row, "message"), false); assert.equal(JSON.stringify(row).includes("not persisted"), false);
  value.close();
});

test("different verified deliveries retain independent jobs", async () => {
  const value = db();
  assert.equal((await enqueueChatwootWebhookJob(value, contactJob("delivery-a"))).created, true);
  assert.equal((await enqueueChatwootWebhookJob(value, contactJob("delivery-b"))).created, true);
  assert.equal(value.sqlite.prepare("SELECT count(*) AS total FROM chatwoot_webhook_jobs").get().total, 2);
  value.close();
});

test("only one concurrent consumer claims a job", async () => {
  const value = db(); await enqueueChatwootWebhookJob(value, contactJob()); let calls = 0;
  const processor = async () => { calls++; };
  const results = await Promise.all([
    processNextChatwootWebhookJob(value, processor),
    processNextChatwootWebhookJob(value, processor),
  ]);
  assert.equal(results.filter((result) => result.processed).length, 1);
  assert.equal(calls, 1);
  assert.equal(value.sqlite.prepare("SELECT count(*) AS total FROM chatwoot_webhook_jobs WHERE status='completed'").get().total, 1);
  value.close();
});

test("failed work is retryable and stores only a sanitized error code", async () => {
  const value = db(); await enqueueChatwootWebhookJob(value, contactJob());
  const start = Date.now();
  const first = await processNextChatwootWebhookJob(value, async () => { throw new Error("token=not-for-storage"); }, start);
  assert.deepEqual(first.completed, false);
  const failed = value.sqlite.prepare("SELECT status,attempts,last_error,next_attempt_at FROM chatwoot_webhook_jobs").get();
  assert.equal(failed.status, "failed"); assert.equal(failed.attempts, 1); assert.equal(failed.last_error, "CHATWOOT_JOB_PROCESSING_FAILED");
  assert.equal(JSON.stringify(failed).includes("not-for-storage"), false);
  let completed = 0;
  const retry = await processNextChatwootWebhookJob(value, async () => { completed++; }, start + 2_001);
  assert.equal(retry.completed, true); assert.equal(completed, 1);
  assert.equal(value.sqlite.prepare("SELECT status FROM chatwoot_webhook_jobs").get().status, "completed");
  value.close();
});

test("an expired processing lease is recoverable and the drain does not process a job twice", async () => {
  const value = db(); await enqueueChatwootWebhookJob(value, contactJob()); const start = Date.now();
  const claimed = await claimNextChatwootWebhookJob(value, start); assert.ok(claimed);
  let calls = 0;
  const drained = await drainChatwootWebhookJobs(value, async () => { calls++; }, 3);
  assert.equal(drained.processed, 0); assert.equal(calls, 0);
  const recovered = await processNextChatwootWebhookJob(value, async () => { calls++; }, start + 120_001);
  assert.equal(recovered.completed, true); assert.equal(calls, 1);
  value.close();
});
