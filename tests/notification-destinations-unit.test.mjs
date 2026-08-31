import assert from "node:assert/strict";
import test from "node:test";
import {
  legacyNotificationDestination,
  notificationDestinationFromMetadata,
  notificationDestinationPath,
  parseNotificationDestination,
} from "../lib/notification-destinations.ts";

test("notification destinations accept only typed internal entity routes", () => {
  assert.deepEqual(parseNotificationDestination({ type: "PRODUCT", id: "42" }), { type: "PRODUCT", id: "42" });
  assert.deepEqual(parseNotificationDestination({ type: "ORDER", id: "ord_42", section: "deliveries" }), { type: "ORDER", id: "ord_42", section: "deliveries" });
  assert.deepEqual(parseNotificationDestination({ type: "ROUTE", date: "2026-08-30", id: "route-1" }), { type: "ROUTE", date: "2026-08-30", id: "route-1" });
  assert.deepEqual(parseNotificationDestination({ type: "INVOICE", id: "inv_42" }), { type: "INVOICE", id: "inv_42" });
  assert.equal(parseNotificationDestination({ type: "PRODUCT", id: "javascript:alert(1)" }), null);
  assert.equal(parseNotificationDestination({ type: "ORDER", id: "ord_42", section: "external" }), null);
  assert.equal(parseNotificationDestination({ type: "ROUTE", date: "not-a-date" }), null);
});

test("notification links are generated from destinations and legacy URLs stay allowlisted", () => {
  assert.equal(notificationDestinationPath({ type: "ORDER", id: "ord_42", section: "special" }), "/?tab=orders&section=special&order=ord_42");
  assert.deepEqual(legacyNotificationDestination("/?tab=products&invoice=inv_42"), { type: "INVOICE", id: "inv_42" });
  assert.deepEqual(legacyNotificationDestination("/?tab=orders&route=1&date=2026-08-30&routeId=route-1"), { type: "ROUTE", date: "2026-08-30", id: "route-1" });
  assert.equal(legacyNotificationDestination("https://evil.example/?tab=products&product=42"), null);
  assert.deepEqual(notificationDestinationFromMetadata({ destination: { type: "PRODUCT", id: "42" } }, "https://evil.example"), { type: "PRODUCT", id: "42" });
  assert.deepEqual(notificationDestinationFromMetadata({}, "//evil.example"), { type: "NOTIFICATIONS" });
});
