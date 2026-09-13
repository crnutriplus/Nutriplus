import assert from "node:assert/strict";
import test from "node:test";
import { siteAccessDecision, siteUnauthorizedResponse } from "../lib/site-access.ts";

const options = {
  mode: "enforced",
  allowedEmails: "owner@nutriplus.test",
};

function request(path, init = {}) {
  return new Request(`https://nutriplus.test${path}`, init);
}

test("denies anonymous application pages and business APIs", () => {
  for (const path of ["/", "/api/orders", "/api/products", "/api/inventory-intake", "/api/finance", "/operations/crm-panel", "/api/operations/crm-panel", "/api/operations/crm-panel/embed/session/extra"]) {
    const decision = siteAccessDecision(request(path), options);
    assert.equal(decision.allowed, false, path);
  }
  const page = siteUnauthorizedResponse(request("/orders"));
  assert.equal(page.status, 302);
  assert.equal(new URL(page.headers.get("location")).pathname, "/signin-with-chatgpt");
  assert.equal(siteUnauthorizedResponse(request("/api/orders")).status, 401);
});

test("allows only approved ChatGPT identities", () => {
  const approved = siteAccessDecision(request("/", { headers: { "oai-authenticated-user-email": "OWNER@nutriplus.test" } }), options);
  const rejected = siteAccessDecision(request("/", { headers: { "oai-authenticated-user-email": "other@nutriplus.test" } }), options);
  assert.deepEqual(approved, { allowed: true, reason: "user" });
  assert.deepEqual(rejected, { allowed: false, reason: "not_allowed" });
});

test("keeps only the security-checked integration routes outside user login", () => {
  assert.deepEqual(siteAccessDecision(request("/api/integrations/chatwoot/webhook", { method: "POST" }), options), { allowed: true, reason: "webhook" });
  assert.deepEqual(siteAccessDecision(request("/api/operations/crm-panel/embed/session", { method: "POST", headers: { origin: "https://nutriplus.test" } }), options), { allowed: true, reason: "crm_embed" });
  assert.deepEqual(siteAccessDecision(request("/api/crm/customers/resolve"), options), { allowed: true, reason: "crm" });
  assert.deepEqual(siteAccessDecision(request("/nutriplus-logo.jpg"), options), { allowed: true, reason: "static" });
});

test("fails closed when enforcement is enabled without an allowlist", () => {
  assert.deepEqual(siteAccessDecision(request("/", { headers: { "oai-authenticated-user-email": "owner@nutriplus.test" } }), { mode: "enforced" }), { allowed: false, reason: "misconfigured" });
  assert.deepEqual(siteAccessDecision(request("/"), {}), { allowed: false, reason: "misconfigured" });
  assert.deepEqual(siteAccessDecision(request("/"), { mode: "disabled" }), { allowed: true, reason: "not_enforced" });
});
