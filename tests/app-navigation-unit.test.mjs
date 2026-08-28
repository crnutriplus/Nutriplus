import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { installAppNavigation } from "../lib/app-navigation.ts";

function harness(initialState = null) {
  const listeners = new Set();
  const calls = { replace: [], push: [], back: 0, forward: 0, exits: 0, sections: [], closeLayer: false };
  const history = {
    state: initialState,
    replaceState(state) { this.state = state; calls.replace.push(state); },
    pushState(state) { this.state = state; calls.push.push(state); },
    back() { calls.back += 1; },
    forward() { calls.forward += 1; },
  };
  const target = {
    addEventListener(type, listener) { if (type === "popstate") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "popstate") listeners.delete(listener); },
    pop(state) { history.state = state; for (const listener of listeners) listener({ state }); },
  };
  const controller = installAppNavigation(history, target, "orders", {
    onSection(section) { calls.sections.push(section); },
    onBeforeBack() { const handled = calls.closeLayer; calls.closeLayer = false; return handled; },
    onRequestExit() { calls.exits += 1; },
  });
  return { calls, controller, target };
}

test("tab history goes Products → Calculator → Orders without trapping exit", () => {
  const app = harness();
  const orders = app.calls.push.at(-1);
  app.controller.navigate("calculator");
  const calculator = app.calls.push.at(-1);
  app.controller.navigate("products");
  app.target.pop(calculator);
  app.target.pop(orders);
  assert.deepEqual(app.calls.sections, ["calculator", "products", "calculator", "orders"]);
  app.target.pop({ __nutriplus_navigation__: "boundary" });
  assert.equal(app.calls.exits, 1);
  app.controller.confirmExit();
  assert.equal(app.calls.back, 1);
});

test("Atrás closes one temporary layer before changing section", () => {
  const app = harness();
  app.controller.navigate("products");
  const orders = app.calls.push[0];
  app.calls.closeLayer = true;
  app.target.pop(orders);
  assert.equal(app.calls.sections.at(-1), "products");
  assert.equal(app.calls.push.at(-1).section, "products");
});

test("Cancel rearms the same guard without growing history and remount does not add entries", () => {
  const app = harness();
  const pushes = app.calls.push.length;
  app.target.pop({ __nutriplus_navigation__: "boundary" });
  app.controller.cancelExit();
  assert.equal(app.calls.forward, 1);
  assert.equal(app.calls.push.length, pushes);
  for (let cycle = 0; cycle < 20; cycle += 1) {
    app.target.pop({ __nutriplus_navigation__: "boundary" });
    app.controller.cancelExit();
  }
  assert.equal(app.calls.forward, 21);
  assert.equal(app.calls.push.length, pushes);
  app.controller.dispose();
  const remount = harness(app.calls.push[0]);
  assert.equal(remount.calls.replace.length, 0);
  assert.equal(remount.calls.push.length, 0);
});

test("the App Shell keeps module roots mounted and removes only the floating notification launcher", async () => {
  const [client, notifications, css] = await Promise.all([
    readFile(new URL("../app/client-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/notification-center.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(client, /hidden=\{tab !== "orders"\}/);
  assert.match(client, /hidden=\{tab !== "import"\}/);
  assert.match(client, /hidden=\{tab !== "settings"\}/);
  assert.match(client, /calculatorForm/);
  assert.match(client, /productForm/);
  assert.match(client, /aria-label="Navegación principal"/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(notifications, /notification-bell-button/);
  assert.match(notifications, /Centro de notificaciones/);
  assert.match(notifications, /navigator\.serviceWorker\.register/);
});
