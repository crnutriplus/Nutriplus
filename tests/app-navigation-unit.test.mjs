import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { installAppNavigation } from "../lib/app-navigation.ts";

function harness(initialState = null, { closeWatcher = true, navigation = true, canGoBack = true } = {}) {
  const listeners = new Set();
  const calls = { replace: [], push: [], back: 0, nativeBack: 0, exits: 0, locations: [], closeLayer: false, windowClose: 0 };
  const history = {
    state: initialState,
    replaceState(state, _title, url) { this.state = state; calls.replace.push({ state, url }); },
    pushState(state, _title, url) { this.state = state; calls.push.push({ state, url }); },
    back() { calls.back += 1; },
  };
  const target = {
    addEventListener(type, listener) { if (type === "popstate") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "popstate") listeners.delete(listener); },
    pop(state) { history.state = state; for (const listener of listeners) listener({ state }); },
  };
  const watchers = [];
  class FakeCloseWatcher {
    constructor() { this.listeners = { cancel: new Set(), close: new Set() }; this.destroyed = false; watchers.push(this); }
    addEventListener(type, listener) { this.listeners[type].add(listener); }
    removeEventListener(type, listener) { this.listeners[type].delete(listener); }
    destroy() { this.destroyed = true; }
    request(cancelable = true) {
      let prevented = false;
      const event = { cancelable, preventDefault() { prevented = true; } };
      for (const listener of this.listeners.cancel) listener(event);
      if (!prevented) for (const listener of this.listeners.close) listener(event);
      return prevented;
    }
  }
  const nav = navigation ? {
    canGoBack,
    currentEntry: { index: 0, url: "https://example.test/?tab=orders" },
    entries() { return [this.currentEntry]; },
    async back() { calls.nativeBack += 1; },
  } : undefined;
  const controller = installAppNavigation(history, target, "orders", {
    onLocation(section, view) { calls.locations.push({ section, view }); },
    onBeforeBack() { const handled = calls.closeLayer; calls.closeLayer = false; return handled; },
    onRequestExit() { calls.exits += 1; },
  }, {
    CloseWatcher: closeWatcher ? FakeCloseWatcher : undefined,
    navigation: nav,
    location: { href: "https://example.test/?tab=orders", origin: "https://example.test", pathname: "/", search: "?tab=orders", hash: "" },
    closeWindow() { calls.windowClose += 1; },
  });
  return { calls, controller, target, history, watchers, nav };
}

test("real SPA entries go Products → Calculator → Orders without a boundary sentinel", () => {
  const app = harness();
  assert.equal(app.calls.push.length, 0, "initialization must not push an artificial guard");
  assert.equal(app.calls.replace.length, 1);
  app.controller.navigate("calculator");
  const calculator = app.calls.push.at(-1).state;
  app.controller.navigate("products");
  app.target.pop(calculator);
  app.target.pop(app.calls.replace[0].state);
  assert.deepEqual(app.calls.locations, [
    { section: "calculator", view: undefined },
    { section: "products", view: undefined },
    { section: "calculator", view: undefined },
    { section: "orders", view: undefined },
  ]);
});

test("CloseWatcher closes one temporary layer before traversing app history", () => {
  const app = harness();
  app.controller.navigate("products");
  app.calls.closeLayer = true;
  assert.equal(app.watchers.at(-1).request(true), true);
  assert.equal(app.calls.back, 0);
  assert.equal(app.calls.exits, 0);
  assert.equal(app.watchers.at(-1).request(true), true);
  assert.equal(app.calls.back, 1);
});

test("Cancel repeats 20 times without pushState, forward, or history growth", () => {
  const app = harness();
  const pushes = app.calls.push.length;
  for (let cycle = 0; cycle < 20; cycle += 1) {
    assert.equal(app.watchers.at(-1).request(true), true);
    assert.equal(app.calls.exits, cycle + 1);
    app.controller.cancelExit();
  }
  assert.equal(app.calls.push.length, pushes);
  assert.equal(app.calls.back, 0);
  assert.equal(app.watchers.length, 1, "a cancelable watcher remains armed without stacking");
});

test("Salir destroys the watcher and performs one native navigation", async () => {
  const app = harness();
  app.watchers.at(-1).request(true);
  app.controller.confirmExit();
  await Promise.resolve();
  assert.equal(app.calls.nativeBack, 1);
  assert.equal(app.calls.back, 0);
  assert.equal(app.watchers.at(-1).destroyed, true);
});

test("installed-PWA fallback closes once only when Navigation reports no back entry", () => {
  const app = harness(null, { canGoBack: false });
  app.watchers.at(-1).request(false);
  assert.equal(app.calls.exits, 1);
  app.controller.confirmExit();
  assert.equal(app.calls.windowClose, 1);
  assert.equal(app.calls.nativeBack, 0);
  assert.equal(app.calls.back, 0);
});

test("cold reload synchronizes the persisted browser location before the first touch", () => {
  const app = harness({ __nutriplus_navigation__: "screen", section: "products", depth: 2, sequence: 7 });
  assert.deepEqual(app.calls.locations, [{ section: "products", view: undefined }]);
  assert.equal(app.calls.replace.length, 0);
  assert.equal(app.calls.push.length, 0);
  app.controller.navigate("finance");
  assert.equal(app.calls.locations.at(-1).section, "finance");
});

test("settings import is a real subview entry and legacy links remain compatible", () => {
  const app = harness();
  app.controller.navigate("settings");
  app.controller.navigate("settings", "import");
  assert.equal(app.calls.push.at(-1).state.view, "import");
  assert.match(app.calls.push.at(-1).url, /tab=settings&view=import/);
});

test("fallback without modern APIs preserves ordinary SPA history and does not create a trap", () => {
  const app = harness(null, { closeWatcher: false, navigation: false });
  app.controller.navigate("calculator");
  assert.equal(app.calls.push.length, 1);
  assert.deepEqual(app.controller.capabilities, { closeWatcher: false, navigation: false });
  app.controller.dispose();
});

test("the App Shell keeps module roots mounted and exposes the five requested tabs", async () => {
  const [client, notifications, css] = await Promise.all([
    readFile(new URL("../app/client-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/notification-center.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(client, /hidden=\{tab !== "orders"\}/);
  assert.match(client, /hidden=\{tab !== "finance"\}/);
  assert.match(client, /settingsPanel !== "import"/);
  assert.match(client, /"finance", "Finanzas"/);
  assert.doesNotMatch(client, /\["import", "Importar"/);
  assert.match(client, />Importar datos</);
  assert.match(client, /aria-label="Navegación principal"/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(notifications, /notification-bell-button/);
  assert.match(notifications, /Centro de notificaciones/);
  assert.match(notifications, /navigator\.serviceWorker\.register/);
});

test("orders opened from Finance return to the real Finance history entry", async () => {
  const client = await readFile(new URL("../app/client-app.tsx", import.meta.url), "utf8");
  const orders = await readFile(new URL("../app/orders-view.tsx", import.meta.url), "utf8");
  assert.match(client, /detail: \{ orderId, origin: "finance" \}/);
  assert.match(client, /onReturnToOrigin=\{\(\) => window\.history\.back\(\)\}/);
  assert.match(orders, /detailOrigin === "finance"/);
  assert.doesNotMatch(orders, /history\.pushState\([^\n]+finance/);
});
