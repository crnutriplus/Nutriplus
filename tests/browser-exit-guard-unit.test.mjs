import assert from "node:assert/strict";
import test from "node:test";
import { installBrowserExitGuard } from "../lib/browser-exit-guard.ts";

function harness(initialState = null) {
  const listeners = new Set();
  const calls = { replace: [], push: [], back: 0, confirmations: 0 };
  const history = {
    state: initialState,
    replaceState(state) { this.state = state; calls.replace.push(state); },
    pushState(state) { this.state = state; calls.push.push(state); },
    back() { calls.back += 1; },
  };
  const target = {
    addEventListener(type, listener) { if (type === "popstate") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "popstate") listeners.delete(listener); },
    pop(state) { history.state = state; for (const listener of listeners) listener({ state }); },
  };
  const controller = installBrowserExitGuard(history, target, () => { calls.confirmations += 1; });
  return { calls, controller, history, target };
}

test("the exit guard asks only at the app boundary and Cancel preserves the session", () => {
  const app = harness({ screen: "orders" });
  assert.equal(app.calls.replace.length, 1);
  assert.equal(app.calls.push.length, 1, "installation adds one boundary guard only");

  app.target.pop({ screen: "orders", __nutriplus_exit_boundary__: "guard" });
  assert.equal(app.calls.confirmations, 0, "returning to an internal guard must not ask to exit");

  app.target.pop({ screen: "orders", __nutriplus_exit_boundary__: "base" });
  assert.equal(app.calls.confirmations, 1);
  app.controller.cancelExit();
  assert.equal(app.calls.push.length, 2, "Cancel restores exactly one consumed guard");
  assert.equal(app.calls.back, 0);

  app.target.pop({ screen: "orders", __nutriplus_exit_boundary__: "base" });
  assert.equal(app.calls.confirmations, 2);
  app.controller.confirmExit();
  assert.equal(app.calls.back, 1, "Salir delegates to normal browser/PWA back behavior");
  assert.equal(app.calls.push.length, 2, "Salir never creates an exit-prevention loop");
});

test("remounting on an existing guard does not grow browser history", () => {
  const app = harness({ __nutriplus_exit_boundary__: "guard" });
  assert.equal(app.calls.replace.length, 0);
  assert.equal(app.calls.push.length, 0);
  app.controller.dispose();
  app.target.pop({ __nutriplus_exit_boundary__: "base" });
  assert.equal(app.calls.confirmations, 0);
});
