const EXIT_HISTORY_KEY = "__nutriplus_exit_boundary__";

type HistoryLike = Pick<History, "state" | "back" | "pushState" | "replaceState">;
type PopStateTarget = Pick<Window, "addEventListener" | "removeEventListener">;

export type ExitGuardController = {
  cancelExit: () => void;
  confirmExit: () => void;
  dispose: () => void;
};

export function installBrowserExitGuard(
  history: HistoryLike,
  target: PopStateTarget,
  requestConfirmation: () => void,
): ExitGuardController {
  const existingState = history.state && typeof history.state === "object" ? history.state : {};
  let confirmationPending = false;
  let exiting = false;

  if (existingState[EXIT_HISTORY_KEY] !== "guard") {
    history.replaceState({ ...existingState, [EXIT_HISTORY_KEY]: "base" }, "");
    history.pushState({ ...existingState, [EXIT_HISTORY_KEY]: "guard" }, "");
  }

  const onPopState = (event: PopStateEvent) => {
    if (exiting || event.state?.[EXIT_HISTORY_KEY] === "guard" || confirmationPending) return;
    confirmationPending = true;
    requestConfirmation();
  };
  target.addEventListener("popstate", onPopState);

  return {
    cancelExit() {
      if (!confirmationPending || exiting) return;
      confirmationPending = false;
      history.pushState({ ...existingState, [EXIT_HISTORY_KEY]: "guard" }, "");
    },
    confirmExit() {
      if (!confirmationPending || exiting) return;
      confirmationPending = false;
      exiting = true;
      history.back();
    },
    dispose() {
      target.removeEventListener("popstate", onPopState);
    },
  };
}
