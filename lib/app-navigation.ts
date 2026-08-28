export type AppSection = "calculator" | "orders" | "products" | "import" | "settings";

const NAVIGATION_KEY = "__nutriplus_navigation__";

type BoundaryState = { [NAVIGATION_KEY]: "boundary" };
type ScreenState = { [NAVIGATION_KEY]: "screen"; section: AppSection; sequence: number };
type NavigationState = BoundaryState | ScreenState;
type HistoryLike = Pick<History, "state" | "back" | "forward" | "pushState" | "replaceState">;
type PopStateTarget = Pick<Window, "addEventListener" | "removeEventListener">;

export type NavigationController = {
  navigate: (section: AppSection) => void;
  cancelExit: () => void;
  confirmExit: () => void;
  dispose: () => void;
};

function isScreenState(value: unknown): value is ScreenState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ScreenState>;
  return state[NAVIGATION_KEY] === "screen"
    && ["calculator", "orders", "products", "import", "settings"].includes(String(state.section));
}

export function installAppNavigation(
  history: HistoryLike,
  target: PopStateTarget,
  initialSection: AppSection,
  callbacks: {
    onSection: (section: AppSection) => void;
    onBeforeBack: () => boolean;
    onRequestExit: () => void;
  },
): NavigationController {
  let sequence = 0;
  let current: ScreenState;
  let exitPending = false;
  let exiting = false;

  if (isScreenState(history.state)) {
    current = history.state;
    sequence = current.sequence;
  } else {
    const preserved = history.state && typeof history.state === "object" ? history.state : {};
    history.replaceState({ ...preserved, [NAVIGATION_KEY]: "boundary" } satisfies BoundaryState, "");
    current = { [NAVIGATION_KEY]: "screen", section: initialSection, sequence };
    history.pushState(current, "");
  }

  const onPopState = (event: PopStateEvent) => {
    if (exiting) return;
    if (callbacks.onBeforeBack()) {
      history.pushState(current, "");
      return;
    }
    if (isScreenState(event.state)) {
      current = event.state;
      sequence = Math.max(sequence, current.sequence);
      callbacks.onSection(current.section);
      return;
    }
    if ((event.state as Partial<NavigationState> | null)?.[NAVIGATION_KEY] === "boundary" && !exitPending) {
      exitPending = true;
      callbacks.onRequestExit();
    }
  };
  target.addEventListener("popstate", onPopState);

  return {
    navigate(section) {
      if (exiting || exitPending || section === current.section) return;
      current = { [NAVIGATION_KEY]: "screen", section, sequence: ++sequence };
      history.pushState(current, "");
      callbacks.onSection(section);
    },
    cancelExit() {
      if (!exitPending || exiting) return;
      exitPending = false;
      history.forward();
    },
    confirmExit() {
      if (!exitPending || exiting) return;
      exitPending = false;
      exiting = true;
      history.back();
    },
    dispose() {
      target.removeEventListener("popstate", onPopState);
    },
  };
}
