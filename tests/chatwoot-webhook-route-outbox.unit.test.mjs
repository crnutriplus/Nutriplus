import assert from "node:assert/strict";
import test from "node:test";
import { LocalD1Database } from "./helpers/local-bindings.mjs";
import { CHATWOOT_WEBHOOK_OUTBOX_SQL } from "../lib/chatwoot-webhook-outbox.ts";

const secret = "test-chatwoot-webhook-secret";
const { POST } = await import("../app/api/integrations/chatwoot/webhook/route.ts");

async function signedRequest(raw, { delivery = "route-delivery-1", valid = true } = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000)); const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${raw}`));
  const signature = `sha256=${[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return new Request("https://nutriplus.test/api/integrations/chatwoot/webhook", {
    method: "POST", headers: {
      "content-type": "application/json", "x-chatwoot-timestamp": timestamp,
      "x-chatwoot-signature": valid ? signature : "sha256=invalid", "x-chatwoot-delivery": delivery,
    }, body: raw,
  });
}

function installOutboxSchema(db) {
  for (const statement of CHATWOOT_WEBHOOK_OUTBOX_SQL) db.sqlite.exec(statement);
}

test("the receiver inserts directly when the outbox exists, persists valid work, rejects invalid signatures, and deduplicates without synchronous Chatwoot API work", async () => {
  const db = new LocalD1Database(); globalThis.__NUTRIPLUS_DB__ = db; globalThis.__NUTRIPLUS_CHATWOOT_WEBHOOK_SECRET__ = secret;
  globalThis.__NUTRIPLUS_CHATWOOT_BASE_URL__ = undefined; globalThis.__NUTRIPLUS_CHATWOOT_API_TOKEN__ = undefined;
  installOutboxSchema(db);
  let ddlBatches = 0; const originalBatch = db.batch.bind(db); db.batch = async (statements) => { ddlBatches++; return originalBatch(statements); };
  const raw = JSON.stringify({ event: "contact_updated", account: { id: 1 }, contact: { id: 42, content: "must never enter the outbox" } });
  const response = await POST(await signedRequest(raw));
  assert.equal(response.status, 202); assert.deepEqual(await response.json(), { accepted: true, duplicate: false, event: "contact_updated", supported: true });
  assert.equal(ddlBatches, 0);
  const row = db.sqlite.prepare("SELECT * FROM chatwoot_webhook_jobs").get(); assert.equal(row.chatwoot_contact_id, 42); assert.equal(JSON.stringify(row).includes("must never enter the outbox"), false);
  const invalidRaw = JSON.stringify({ event: "contact_updated", account: { id: 1 }, contact: { id: 43 } });
  const invalid = await POST(await signedRequest(invalidRaw, { delivery: "route-invalid", valid: false }));
  assert.equal(invalid.status, 401); assert.equal(db.sqlite.prepare("SELECT count(*) AS total FROM chatwoot_webhook_jobs WHERE delivery_id='route-invalid'").get().total, 0);
  const duplicate = await POST(await signedRequest(raw)); assert.equal(duplicate.status, 202);
  assert.deepEqual(await duplicate.json(), { accepted: true, duplicate: true, event: "contact_updated", supported: true });
  assert.equal(db.sqlite.prepare("SELECT count(*) AS total FROM chatwoot_webhook_jobs WHERE delivery_id='route-delivery-1'").get().total, 1);
  db.close();
});

test("a missing outbox is bootstrapped only after the first INSERT fails, then acknowledged", async () => {
  const db = new LocalD1Database(); globalThis.__NUTRIPLUS_DB__ = db; globalThis.__NUTRIPLUS_CHATWOOT_WEBHOOK_SECRET__ = secret;
  let ddlBatches = 0; const originalBatch = db.batch.bind(db); db.batch = async (statements) => { ddlBatches++; return originalBatch(statements); };
  const raw = JSON.stringify({ event: "contact_updated", account: { id: 1 }, contact: { id: 42 } });
  const response = await POST(await signedRequest(raw, { delivery: "route-missing-table" }));
  assert.equal(response.status, 202); assert.equal(ddlBatches, 1);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS total FROM chatwoot_webhook_jobs").get().total, 1);
  db.close();
});

test("a D1 failure unrelated to a missing outbox never performs blind bootstrap or acknowledges", async () => {
  const db = new LocalD1Database(); globalThis.__NUTRIPLUS_DB__ = db; globalThis.__NUTRIPLUS_CHATWOOT_WEBHOOK_SECRET__ = secret;
  installOutboxSchema(db);
  let ddlBatches = 0; const originalBatch = db.batch.bind(db); db.batch = async (statements) => { ddlBatches++; return originalBatch(statements); };
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => sql.includes("INSERT OR IGNORE INTO chatwoot_webhook_jobs") ? { bind: () => ({ run: async () => { throw new Error("database is locked"); } }) } : originalPrepare(sql);
  const raw = JSON.stringify({ event: "contact_updated", account: { id: 1 }, contact: { id: 42 } });
  const response = await POST(await signedRequest(raw, { delivery: "route-d1-error" }));
  assert.equal(response.status, 500); assert.equal(ddlBatches, 0);
  db.close();
});

test("the receiver never acknowledges a webhook when isolated outbox bootstrap fails", async () => {
  const db = new LocalD1Database(); globalThis.__NUTRIPLUS_DB__ = db; globalThis.__NUTRIPLUS_CHATWOOT_WEBHOOK_SECRET__ = secret;
  db.batch = async () => { throw new Error("D1 unavailable"); };
  const raw = JSON.stringify({ event: "contact_updated", account: { id: 1 }, contact: { id: 42 } });
  const response = await POST(await signedRequest(raw, { delivery: "route-bootstrap-failure" }));
  assert.equal(response.status, 500);
  db.close();
});
