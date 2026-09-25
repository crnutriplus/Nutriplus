import assert from "node:assert/strict";
import test from "node:test";
import {
  crmDashboardParentOrigin,
  isSuccessfulCrmDashboardSessionExchange,
  isTrustedCrmDashboardMessage,
  notifyCrmDashboardReady,
  parseCrmDashboardBootstrapMessage,
} from "../lib/crm-dashboard-handshake.ts";

test("normalizes the configured Chatwoot URL to an origin", () => {
  assert.equal(
    crmDashboardParentOrigin("https://crm.crnutriplus.com/some/path"),
    "https://crm.crnutriplus.com",
  );
  assert.equal(crmDashboardParentOrigin(undefined), null);
  assert.equal(crmDashboardParentOrigin("not a url"), null);
});

test("accepts only the exact Chatwoot origin and parent window", () => {
  const parentWindow = {};
  assert.equal(
    isTrustedCrmDashboardMessage(
      { origin: "https://crm.crnutriplus.com", source: parentWindow },
      "https://crm.crnutriplus.com",
      parentWindow,
    ),
    true,
  );
  assert.equal(
    isTrustedCrmDashboardMessage(
      { origin: "https://evil.example", source: parentWindow },
      "https://crm.crnutriplus.com",
      parentWindow,
    ),
    false,
  );
  assert.equal(
    isTrustedCrmDashboardMessage(
      { origin: "https://crm.crnutriplus.com", source: {} },
      "https://crm.crnutriplus.com",
      parentWindow,
    ),
    false,
  );
});

test("parses only the exact serialized bootstrap event with a bounded token", () => {
  assert.equal(
    parseCrmDashboardBootstrapMessage(
      JSON.stringify({
        event: "nutriplus-dashboard-bootstrap",
        data: { token: "  jwt-token  " },
      }),
    ),
    "jwt-token",
  );
  assert.equal(parseCrmDashboardBootstrapMessage("{"), null);
  assert.equal(
    parseCrmDashboardBootstrapMessage(
      JSON.stringify({ event: "other-event", data: { token: "jwt-token" } }),
    ),
    null,
  );
  assert.equal(
    parseCrmDashboardBootstrapMessage({
      event: "nutriplus-dashboard-bootstrap",
      data: { token: "jwt-token" },
    }),
    null,
  );
  assert.equal(
    parseCrmDashboardBootstrapMessage(
      JSON.stringify({
        event: "nutriplus-dashboard-bootstrap",
        data: { token: "x".repeat(8193) },
      }),
    ),
    null,
  );
});

test("accepts only HTTP 201 for dashboard session exchange", () => {
  assert.equal(isSuccessfulCrmDashboardSessionExchange(201), true);
  assert.equal(isSuccessfulCrmDashboardSessionExchange(200), false);
  assert.equal(isSuccessfulCrmDashboardSessionExchange(204), false);
  assert.equal(isSuccessfulCrmDashboardSessionExchange(400), false);
});

test("notifies both the web parent and native bridge with ready only", () => {
  const parentMessages = [];
  const nativeMessages = [];

  notifyCrmDashboardReady(
    {
      postMessage(data, origin) {
        parentMessages.push([data, origin]);
      },
    },
    "https://crm.crnutriplus.com",
    {
      postMessage(data) {
        nativeMessages.push(data);
      },
    },
  );

  assert.deepEqual(parentMessages, [
    ["nutriplus-dashboard-app:ready", "https://crm.crnutriplus.com"],
  ]);
  assert.deepEqual(nativeMessages, ["nutriplus-dashboard-app:ready"]);
});
