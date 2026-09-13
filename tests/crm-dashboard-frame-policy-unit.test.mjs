import assert from "node:assert/strict";
import test from "node:test";
import { withCrmDashboardFramePolicy } from "../lib/crm-dashboard-frame-policy.ts";

test("adds exact Chatwoot frame-ancestors and removes X-Frame-Options", async () => {
  const response = new Response("ok", {
    headers: {
      "content-security-policy": "default-src 'self';",
      "x-frame-options": "DENY",
    },
  });

  const secured = withCrmDashboardFramePolicy(
    response,
    "https://crm.crnutriplus.com/path",
  );

  assert.equal(secured.headers.get("x-frame-options"), null);
  assert.match(
    secured.headers.get("content-security-policy") || "",
    /default-src 'self'/,
  );
  assert.match(
    secured.headers.get("content-security-policy") || "",
    /frame-ancestors https:\/\/crm\.crnutriplus\.com/,
  );
  assert.equal(await secured.text(), "ok");
});

test("fails closed when Chatwoot origin is missing or invalid", () => {
  for (const value of [undefined, "not a url"]) {
    const secured = withCrmDashboardFramePolicy(new Response("ok"), value);
    assert.match(
      secured.headers.get("content-security-policy") || "",
      /frame-ancestors 'none'/,
    );
  }
});
