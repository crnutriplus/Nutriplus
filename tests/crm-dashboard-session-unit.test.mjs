import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  CRM_DASHBOARD_SESSION_COOKIE,
  CRM_DASHBOARD_SESSION_TTL_SECONDS,
  clearCrmDashboardSessionCookie,
  createCrmDashboardSession,
  crmDashboardSessionCookie,
  dashboardSessionIdFromRequest,
  getCrmDashboardSession,
  verifyCrmDashboardBootstrapToken,
} from "../lib/crm-dashboard-session.ts";

const SECRET = "0123456789abcdef0123456789abcdef";
const NOW_MS = Date.UTC(2026, 8, 12, 14, 0, 0);
const NOW = Math.floor(NOW_MS / 1000);

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(payload, secret = SECRET, header = { alg: "HS256", typ: "JWT" }) {
  const unsigned = `${encodeJson(header)}.${encodeJson(payload)}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function validPayload(overrides = {}) {
  return {
    iss: "chatwoot",
    aud: "nutriplus-crm",
    sub: "7",
    account_id: 1,
    contact_id: 42,
    conversation_id: 93,
    agent_id: 7,
    iat: NOW,
    exp: NOW + 300,
    jti: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async run() {
    this.db.prepare(this.sql).run(...this.args);
    return { success: true };
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.args) ?? null;
  }
}

class D1Mock {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(`CREATE TABLE crm_dashboard_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      bootstrap_jti TEXT NOT NULL UNIQUE,
      chatwoot_account_id INTEGER NOT NULL,
      chatwoot_contact_id INTEGER NOT NULL,
      chatwoot_conversation_id INTEGER NOT NULL,
      chatwoot_agent_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    )`);
  }
  prepare(sql) {
    return new Statement(this.sqlite, sql);
  }
  close() {
    this.sqlite.close();
  }
}

test("validates Chatwoot HS256 bootstrap claims", async () => {
  const claims = await verifyCrmDashboardBootstrapToken(token(validPayload()), SECRET, NOW_MS);
  assert.deepEqual(claims, {
    accountId: 1,
    contactId: 42,
    conversationId: 93,
    agentId: 7,
    subject: "7",
    jti: "11111111-1111-4111-8111-111111111111",
    issuedAt: NOW,
    expiresAt: NOW + 300,
  });
});

test("rejects invalid bootstrap tokens and unsafe claim windows", async () => {
  await assert.rejects(
    verifyCrmDashboardBootstrapToken(token(validPayload(), "abcdef0123456789abcdef0123456789"), SECRET, NOW_MS),
    /Firma de Dashboard App inválida/,
  );
  await assert.rejects(
    verifyCrmDashboardBootstrapToken(token(validPayload({ iss: "other" })), SECRET, NOW_MS),
    /Emisor o audiencia/,
  );
  await assert.rejects(
    verifyCrmDashboardBootstrapToken(token(validPayload({ aud: "other" })), SECRET, NOW_MS),
    /Emisor o audiencia/,
  );
  await assert.rejects(
    verifyCrmDashboardBootstrapToken(token(validPayload({ iat: NOW - 300, exp: NOW - 61 })), SECRET, NOW_MS),
    /expirado o fuera de ventana/,
  );
  await assert.rejects(
    verifyCrmDashboardBootstrapToken(token(validPayload({ iat: NOW + 61, exp: NOW + 300 })), SECRET, NOW_MS),
    /expirado o fuera de ventana/,
  );
  await assert.rejects(
    verifyCrmDashboardBootstrapToken(token(validPayload({ sub: "8" })), SECRET, NOW_MS),
    /Sujeto de Dashboard App inválido/,
  );
  await assert.rejects(
    verifyCrmDashboardBootstrapToken(token(validPayload({ jti: "not-a-uuid" })), SECRET, NOW_MS),
    /jti de Dashboard App inválido/,
  );
  await assert.rejects(
    verifyCrmDashboardBootstrapToken(token(validPayload()), "too-short", NOW_MS),
    /Dashboard App no está configurado/,
  );
});

test("stores only the session hash, blocks jti replay, and resolves the opaque cookie", async () => {
  const db = new D1Mock();
  try {
    const claims = await verifyCrmDashboardBootstrapToken(token(validPayload()), SECRET, NOW_MS);
    const session = await createCrmDashboardSession(db, claims, NOW_MS);
    assert.match(session.id, /^crm-session-[0-9a-f-]{36}$/i);
    assert.equal(session.accountId, 1);
    assert.equal(session.contactId, 42);
    assert.equal(session.conversationId, 93);
    assert.equal(session.agentId, 7);

    const stored = db.sqlite.prepare("SELECT id,bootstrap_jti FROM crm_dashboard_sessions").get();
    assert.notEqual(stored.id, session.id);
    assert.match(String(stored.id), /^[0-9a-f]{64}$/);
    assert.equal(stored.bootstrap_jti, claims.jti);

    const setCookie = crmDashboardSessionCookie(session.id);
    assert.match(setCookie, new RegExp(`^${CRM_DASHBOARD_SESSION_COOKIE}=`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=None/);
    assert.match(setCookie, new RegExp(`Max-Age=${CRM_DASHBOARD_SESSION_TTL_SECONDS}`));

    const request = new Request("https://nutriplus.test/operations/crm-panel", {
      headers: { cookie: setCookie.split(";")[0] },
    });
    assert.equal(dashboardSessionIdFromRequest(request), session.id);

    const loaded = await getCrmDashboardSession(db, request, NOW_MS + 1000);
    assert.deepEqual(loaded, session);

    await assert.rejects(
      createCrmDashboardSession(db, claims, NOW_MS + 2000),
      /ya fue utilizado/,
    );

    db.sqlite.prepare("UPDATE crm_dashboard_sessions SET revoked_at=? WHERE bootstrap_jti=?")
      .run(new Date(NOW_MS + 3000).toISOString(), claims.jti);
    assert.equal(await getCrmDashboardSession(db, request, NOW_MS + 4000), null);
  } finally {
    db.close();
  }
});

test("rejects expired sessions and malformed cookies", async () => {
  const db = new D1Mock();
  try {
    const claims = await verifyCrmDashboardBootstrapToken(
      token(validPayload({ jti: "22222222-2222-4222-8222-222222222222" })),
      SECRET,
      NOW_MS,
    );
    const session = await createCrmDashboardSession(db, claims, NOW_MS);
    const request = new Request("https://nutriplus.test", {
      headers: { cookie: `${CRM_DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(session.id)}` },
    });

    db.sqlite.prepare("UPDATE crm_dashboard_sessions SET expires_at=? WHERE bootstrap_jti=?")
      .run(new Date(NOW_MS - 1000).toISOString(), claims.jti);
    assert.equal(await getCrmDashboardSession(db, request, NOW_MS), null);

    const malformed = new Request("https://nutriplus.test", {
      headers: { cookie: `${CRM_DASHBOARD_SESSION_COOKIE}=attacker-controlled` },
    });
    assert.equal(dashboardSessionIdFromRequest(malformed), null);
    assert.equal(await getCrmDashboardSession(db, malformed, NOW_MS), null);

    assert.match(clearCrmDashboardSessionCookie(), /Max-Age=0/);
  } finally {
    db.close();
  }
});
