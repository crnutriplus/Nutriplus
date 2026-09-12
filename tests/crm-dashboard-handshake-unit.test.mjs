import assert from "node:assert/strict";
import test from "node:test";
import {
  crmDashboardParentOrigin,
  isTrustedCrmDashboardMessage,
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
