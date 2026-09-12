import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createCrmDashboardSession, crmDashboardSessionCookie } from "../lib/crm-dashboard-session.ts";
import { requireCrmPanelAccess } from "../lib/crm-panel-access.ts";

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async run() { this.db.prepare(this.sql).run(...this.args); return { success: true }; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
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
  prepare(sql) { return new Statement(this.sqlite, sql); }
  close() { this.sqlite.close(); }
}

function claims(jti) {
  const now = Math.floor(Date.now() / 1000);
  return {
    accountId: 1,
    contactId: 42,
    conversationId: 93,
    agentId: 7,
    subject: "7",
    jti,
    issuedAt: now,
    expiresAt: now + 300,
  };
}

test("embedded access ignores attacker query context and uses D1 session context", async () => {
  const db = new D1Mock();
  try {
    const session = await createCrmDashboardSession(
      db,
      claims("33333333-3333-4333-8333-333333333333"),
      Date.now(),
    );

    const request = new Request(
      "https://nutriplus.test/api/operations/crm-panel?account_id=999&contact_id=999&conversation_id=999",
      { headers: { cookie: crmDashboardSessionCookie(session.id).split(";")[0], "oai-authenticated-user-email": "attacker@invalid.test" } },
    );

    const access = await requireCrmPanelAccess(db, request);

    assert.equal(access.mode, "embedded");
    assert.deepEqual(access.context, {
      accountId: 1,
      contactId: 42,
      conversationId: 93,
    });
    assert.equal(access.agentId, 7);
    assert.equal(access.sessionId, session.id);
  } finally {
    db.close();
  }
});

test("embedded access rejects missing or expired sessions", async () => {
  const db = new D1Mock();
  try {
    await assert.rejects(
      requireCrmPanelAccess(db, new Request("https://nutriplus.test/api/operations/crm-panel")),
      (error) => error?.status === 401 && error?.code === "NUTRIPLUS_AUTH_REQUIRED",
    );

    const session = await createCrmDashboardSession(
      db,
      claims("44444444-4444-4444-8444-444444444444"),
      Date.now(),
    );

    db.sqlite.prepare("UPDATE crm_dashboard_sessions SET expires_at=? WHERE bootstrap_jti=?")
      .run(new Date(Date.now() - 1000).toISOString(), "44444444-4444-4444-8444-444444444444");

    const request = new Request("https://nutriplus.test/api/operations/crm-panel", {
      headers: { cookie: crmDashboardSessionCookie(session.id).split(";")[0], "oai-authenticated-user-email": "attacker@invalid.test" },
    });

    await assert.rejects(
      requireCrmPanelAccess(db, request),
      (error) => error?.status === 401 && error?.code === "NUTRIPLUS_AUTH_REQUIRED",
    );
  } finally {
    db.close();
  }
});


test("dashboard cookie takes priority over ChatGPT header", async () => {
  const db = new D1Mock();
  try {
    const session = await createCrmDashboardSession(db, claims("55555555-5555-4555-8555-555555555555"), Date.now());
    const request = new Request("https://nutriplus.test/api/operations/crm-panel?account_id=999&contact_id=999&conversation_id=999", {
      headers: {
        cookie: crmDashboardSessionCookie(session.id).split(";")[0],
        "oai-authenticated-user-email": "attacker@invalid.test",
      },
    });
    const access = await requireCrmPanelAccess(db, request);
    assert.equal(access.mode, "embedded");
    assert.deepEqual(access.context, { accountId: 1, contactId: 42, conversationId: 93 });
  } finally {
    db.close();
  }
});
