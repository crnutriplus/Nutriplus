import assert from "node:assert/strict";
import test from "node:test";
import { LocalD1Database } from "./helpers/local-bindings.mjs";
import { ensureDatabase } from "../db/index.ts";

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

test("the receiver persists valid work, rejects invalid signatures, and deduplicates without synchronous Chatwoot API work", async () => {
  const db = new LocalD1Database(); globalThis.__NUTRIPLUS_DB__ = db; globalThis.__NUTRIPLUS_CHATWOOT_WEBHOOK_SECRET__ = secret;
  globalThis.__NUTRIPLUS_CHATWOOT_BASE_URL__ = undefined; globalThis.__NUTRIPLUS_CHATWOOT_API_TOKEN__ = undefined;
  await ensureDatabase();
  const raw = JSON.stringify({ event: "contact_updated", account: { id: 1 }, contact: { id: 42, content: "must never enter the outbox" } });
  const response = await POST(await signedRequest(raw));
  assert.equal(response.status, 202); assert.deepEqual(await response.json(), { accepted: true, duplicate: false, event: "contact_updated", supported: true });
  const row = db.sqlite.prepare("SELECT * FROM chatwoot_webhook_jobs").get(); assert.equal(row.chatwoot_contact_id, 42); assert.equal(JSON.stringify(row).includes("must never enter the outbox"), false);
  const invalidRaw = JSON.stringify({ event: "contact_updated", account: { id: 1 }, contact: { id: 43 } });
  const invalid = await POST(await signedRequest(invalidRaw, { delivery: "route-invalid", valid: false }));
  assert.equal(invalid.status, 401); assert.equal(db.sqlite.prepare("SELECT count(*) AS total FROM chatwoot_webhook_jobs WHERE delivery_id='route-invalid'").get().total, 0);
  const duplicate = await POST(await signedRequest(raw)); assert.equal(duplicate.status, 202);
  assert.deepEqual(await duplicate.json(), { accepted: true, duplicate: true, event: "contact_updated", supported: true });
  assert.equal(db.sqlite.prepare("SELECT count(*) AS total FROM chatwoot_webhook_jobs WHERE delivery_id='route-delivery-1'").get().total, 1);
  db.close();
});
