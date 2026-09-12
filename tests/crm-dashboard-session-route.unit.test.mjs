import assert from "node:assert/strict";
import test from "node:test";
import { LocalD1Database } from "./helpers/local-bindings.mjs";

const secret = "dashboard-secret-for-tests-0123456789abcdef";
const enc = new TextEncoder();

function b64(v) { return Buffer.from(v).toString("base64url"); }
async function jwt(payload, keyText = secret) {
  const h = b64(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const p = b64(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", enc.encode(keyText), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64(new Uint8Array(sig))}`;
}
function claims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iss:"chatwoot", aud:"nutriplus-crm", sub:"7", account_id:1, agent_id:7, conversation_id:900, contact_id:77, iat:now, exp:now+300, jti:crypto.randomUUID(), ...overrides };
}
function req(token) {
  return new Request("https://nutriplus.test/api/operations/crm-panel/embed/session", {
    method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ token })
  });
}

test("dashboard exchange creates secure session, blocks replay and rejects bad context/signature", async () => {
  const db = new LocalD1Database();
  globalThis.__NUTRIPLUS_DB__ = db;
  globalThis.__NUTRIPLUS_DASHBOARD_APP_SECRET__ = secret;
  globalThis.__NUTRIPLUS_CHATWOOT_BASE_URL__ = "https://chatwoot.test";
  globalThis.__NUTRIPLUS_CHATWOOT_API_TOKEN__ = "test-api-token";
  const originalFetch = globalThis.fetch;
  let contactId = 77;
  globalThis.fetch = async () => Response.json({ account_id:1, meta:{ sender:{ id:contactId } } });

  try {
    const { ensureDatabase } = await import("../db/index.ts");
    await ensureDatabase();
    await db.prepare("INSERT INTO customers (id,name) VALUES (?,?)").bind("customer-dashboard","Cliente Dashboard").run();
    await db.prepare("INSERT INTO chatwoot_contact_links (id,chatwoot_account_id,chatwoot_contact_id,customer_id) VALUES (?,?,?,?)")
      .bind("dashboard-link",1,77,"customer-dashboard").run();

    const { POST } = await import("../app/api/operations/crm-panel/embed/session/route.ts");
    const jti = crypto.randomUUID();
    const token = await jwt(claims({ jti }));

    const ok = await POST(req(token));
    assert.equal(ok.status, 201);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(JSON.stringify(body).includes("crm-session-"), false);

    const cookie = ok.headers.get("set-cookie") ?? "";
    assert.match(cookie, /^nutriplus_crm_session=crm-session-/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /SameSite=None/i);

    const opaque = decodeURIComponent(cookie.match(/^nutriplus_crm_session=([^;]+)/)?.[1] ?? "");
    const stored = db.sqlite.prepare("SELECT id,bootstrap_jti FROM crm_dashboard_sessions").get();
    assert.equal(stored.bootstrap_jti, jti);
    assert.notEqual(stored.id, opaque);
    assert.match(String(stored.id), /^[0-9a-f]{64}$/);

    const replay = await POST(req(token));
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).error.code, "CRM_DASHBOARD_BOOTSTRAP_REPLAYED");

    contactId = 99;
    const mismatch = await POST(req(await jwt(claims())));
    assert.equal(mismatch.status, 404);
    assert.equal((await mismatch.json()).error.code, "CRM_PANEL_CONTEXT_MISMATCH");

    const bad = await POST(req(await jwt(claims(), "wrong-dashboard-secret-0123456789abcdef")));
    assert.equal(bad.status, 401);
    assert.equal((await bad.json()).error.code, "CRM_DASHBOARD_SIGNATURE_INVALID");

    assert.equal(db.sqlite.prepare("SELECT count(*) AS total FROM crm_dashboard_sessions").get().total, 1);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});
