import assert from "node:assert/strict";
import test from "node:test";
import { LocalD1Database } from "./helpers/local-bindings.mjs";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("site-access", `${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
const secret = "test-chatwoot-webhook-secret";
const env = {
  DB: new LocalD1Database(),
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  IMAGES: { input() { throw new Error("Images are not used in access tests."); } },
  NUTRIPLUS_APP_AUTH_MODE: "enforced",
  NUTRIPLUS_ALLOWED_USER_EMAILS: "owner@nutriplus.test",
  CRM_SERVICE_ID: "site-access-crm",
  CRM_SERVICE_SECRET: "site-access-crm-secret",
  CHATWOOT_WEBHOOK_SECRET: secret,
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function signature(timestamp, raw) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${raw}`));
  return `sha256=${[...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

test("enforced app access denies anonymous pages and business APIs before routing", async () => {
  const page = await worker.fetch(new Request("https://nutriplus.test/"), env, ctx);
  const api = await worker.fetch(new Request("https://nutriplus.test/api/orders", { headers: { accept: "application/json" } }), env, ctx);
  assert.equal(page.status, 302);
  assert.equal(new URL(page.headers.get("location")).pathname, "/signin-with-chatgpt");
  assert.equal(api.status, 401);
});

test("webhook remains reachable only through its HMAC boundary", async () => {
  const raw = JSON.stringify({ event: "unsupported_event", account: { id: 1 } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const denied = await worker.fetch(new Request("https://nutriplus.test/api/integrations/chatwoot/webhook", {
    method: "POST", headers: { "content-type": "application/json" }, body: raw,
  }), env, ctx);
  const accepted = await worker.fetch(new Request("https://nutriplus.test/api/integrations/chatwoot/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-chatwoot-timestamp": timestamp,
      "x-chatwoot-signature": await signature(timestamp, raw),
      "x-chatwoot-delivery": "site-access-valid-001",
    },
    body: raw,
  }), env, ctx);
  assert.equal(denied.status, 401);
  assert.equal(accepted.status, 202);
});

test("a supported webhook returns 202 while its durable outbox processor is scheduled with waitUntil", async () => {
  const raw = JSON.stringify({ event: "contact_updated", account: { id: 1 }, contact: { id: 42, content: "never persisted" } });
  const timestamp = String(Math.floor(Date.now() / 1000)); const pending = [];
  const response = await worker.fetch(new Request("https://nutriplus.test/api/integrations/chatwoot/webhook", {
    method: "POST", headers: {
      "content-type": "application/json", "x-chatwoot-timestamp": timestamp,
      "x-chatwoot-signature": await signature(timestamp, raw), "x-chatwoot-delivery": "site-access-outbox-001",
    }, body: raw,
  }), env, { waitUntil(promise) { pending.push(promise); }, passThroughOnException() {} });
  assert.equal(response.status, 202); assert.ok(pending.length >= 2, "webhook outbox and notification work are both background tasks");
  await Promise.all(pending);
  const row = env.DB.sqlite.prepare("SELECT * FROM chatwoot_webhook_jobs WHERE delivery_id='site-access-outbox-001'").get();
  assert.equal(row.chatwoot_contact_id, 42); assert.equal(JSON.stringify(row).includes("never persisted"), false);
});

test("CRM remains outside browser login but rejects missing service HMAC", async () => {
  const result = await worker.fetch(new Request("https://nutriplus.test/api/crm/customers/resolve?phone=70000000"), env, ctx);
  assert.equal(result.status, 401);
});
