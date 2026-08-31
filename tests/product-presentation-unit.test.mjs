import assert from "node:assert/strict";
import test from "node:test";
import { normalizePresentation } from "../lib/product-presentation.ts";

test("invoice presentation keeps only the commercial count", () => {
  assert.equal(normalizePresentation("30 gomitas, 355 mg por gomita, de 3 años en adelante"), "30 gomitas");
  assert.equal(normalizePresentation("30 gomitas; de 3 años en adelante"), "30 gomitas");
  assert.equal(normalizePresentation("90 Capsules · antioxidant support"), "90 cápsulas");
});

test("metric presentation wins over the imperial duplicate", () => {
  assert.equal(normalizePresentation("30 ml (1 fl oz)"), "30 ml");
  assert.equal(normalizePresentation("30 ml (1 oz. líq.)"), "30 ml");
  assert.equal(normalizePresentation("680 g (1.5 lb)"), "680 g");
  assert.equal(normalizePresentation("907 g (2 lb)"), "907 g");
});

test("imperial-only presentations are converted to a short metric value", () => {
  assert.equal(normalizePresentation("2 fl oz"), "59 ml");
  assert.equal(normalizePresentation("2 lb"), "907 g");
});
