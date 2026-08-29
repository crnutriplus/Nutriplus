export type AppSection = "calculator" | "orders" | "products" | "finance" | "settings";

const NAVIGATION_KEY = "__nutriplus_navigation__";

type ScreenState = { [NAVIGATION_KEY]: "screen"; section: AppSection; view?: string; depth: number; sequence: number };
type HistoryLike = Pick<History, "state" | "back" | "pushState" | "replaceState">;
type PopStateTarget = Pick<Window, "addEventListener" | "removeEventListener">;
type NavigationEntryLike = { index: number; url: string | null };
type NavigationLike = {
  canGoBack: boolean;
  currentEntry: NavigationEntryLike | null;
  entries: () => NavigationEntryLike[];
  back?: () => Promise<unknown>;
};
type CloseWatcherEventLike = Event & { cancelable: boolean; preventDefault: () => void };
type CloseWatcherLike = {
  addEventListener: (type: "cancel" | "close", listener: (event: CloseWatcherEventLike) => void) => void;
  removeEventListener: (type: "cancel" | "close", listener: (event: CloseWatcherEventLike) => void) => void;
  destroy: () => void;
};
type CloseWatcherConstructor = new () => CloseWatcherLike;

export type NavigationCapabilities = {
  CloseWatcher?: CloseWatcherConstructor;
  navigation?: NavigationLike;
  location?: Pick<Location, "href" | "origin" | "pathname" | "search" | "hash">;
  closeWindow?: () => void;
};

export type NavigationController = {
  navigate: (section: AppSection, view?: string) => void;
  cancelExit: () => void;
  confirmExit: () => void;
  dispose: () => void;
  capabilities: { closeWatcher: boolean; navigation: boolean };
};

function isScreenState(value: unknown): value is ScreenState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ScreenState>;
  return state[NAVIGATION_KEY] === "screen"
    && ["calculator", "orders", "products", "finance", "settings"].includes(String(state.section))
    && Number.isInteger(state.depth) && Number(state.depth) >= 0;
}

function locationUrl(location: NavigationCapabilities["location"], section: AppSection, view?: string) {
  if (!location) return `/?tab=${section}${view ? `&view=${encodeURIComponent(view)}` : ""}`;
  const url = new URL(location.href);
  url.searchParams.set("tab", section);
  if (view) url.searchParams.set("view", view);
  else url.searchParams.delete("view");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function installAppNavigation(
  history: HistoryLike,
  target: PopStateTarget,
  initialSection: AppSection,
  callbacks: {
    onLocation: (section: AppSection, view?: string) => void;
    onBeforeBack: () => boolean;
    onRequestExit: () => void;
  },
  capabilities: NavigationCapabilities = {},
): NavigationController {
  let sequence = 0;
  let current: ScreenState;
  let exitPending = false;
  let exiting = false;
  let watcher: CloseWatcherLike | null = null;
  let disposed = false;

  if (isScreenState(history.state)) {
    current = history.state;
    sequence = current.sequence;
    callbacks.onLocation(current.section, current.view);
  } else {
    const preserved = history.state && typeof history.state === "object" ? history.state : {};
    const params = capabilities.location ? new URLSearchParams(capabilities.location.search) : null;
    const initialView = initialSection === "settings" && (params?.get("view") === "import" || params?.get("tab") === "import") ? "import" : undefined;
    current = { ...preserved, [NAVIGATION_KEY]: "screen", section: initialSection, ...(initialView ? { view: initialView } : {}), depth: 0, sequence } as ScreenState;
    history.replaceState(current, "", locationUrl(capabilities.location, initialSection, initialView));
  }

  const hasInternalBack = () => {
    if (current.depth > 0) return true;
    const navigation = capabilities.navigation;
    const entry = navigation?.currentEntry;
    if (!navigation || !entry || !capabilities.location) return false;
    const previous = navigation.entries().find((candidate) => candidate.index === entry.index - 1);
    if (!previous?.url) return false;
    try {
      const url = new URL(previous.url);
      return url.origin === capabilities.location.origin && ["calculator", "orders", "products", "finance", "settings"].includes(url.searchParams.get("tab") || "");
    } catch { return false; }
  };

  const handleCloseRequest = () => {
    if (disposed || exiting || exitPending) return;
    if (callbacks.onBeforeBack()) return;
    if (hasInternalBack()) {
      history.back();
      return;
    }
    exitPending = true;
    callbacks.onRequestExit();
  };

  const onCancel = (event: CloseWatcherEventLike) => {
    if (!event.cancelable || disposed || exiting) return;
    event.preventDefault();
    handleCloseRequest();
  };
  const onClose = () => {
    watcher = null;
    handleCloseRequest();
    if (!disposed && !exiting && !exitPending) queueMicrotask(armWatcher);
  };
  function armWatcher() {
    if (watcher || disposed || exiting || !capabilities.CloseWatcher) return;
    watcher = new capabilities.CloseWatcher();
    watcher.addEventListener("cancel", onCancel);
    watcher.addEventListener("close", onClose);
  }
  armWatcher();

  const onPopState = (event: PopStateEvent) => {
    if (exiting) return;
    if (!isScreenState(event.state)) return;
    current = event.state;
    sequence = Math.max(sequence, current.sequence);
    exitPending = false;
    callbacks.onLocation(current.section, current.view);
    armWatcher();
  };
  target.addEventListener("popstate", onPopState);

  return {
    navigate(section, view) {
      if (exiting || exitPending || (section === current.section && (view || "") === (current.view || ""))) return;
      current = { [NAVIGATION_KEY]: "screen", section, ...(view ? { view } : {}), depth: current.depth + 1, sequence: ++sequence };
      history.pushState(current, "", locationUrl(capabilities.location, section, view));
      callbacks.onLocation(section, view);
      armWatcher();
    },
    cancelExit() {
      if (!exitPending || exiting) return;
      exitPending = false;
      armWatcher();
    },
    confirmExit() {
      if (!exitPending || exiting) return;
      exitPending = false;
      exiting = true;
      watcher?.removeEventListener("cancel", onCancel);
      watcher?.removeEventListener("close", onClose);
      watcher?.destroy();
      watcher = null;
      if (capabilities.navigation?.canGoBack && capabilities.navigation.back) {
        void capabilities.navigation.back().catch(() => history.back());
        return;
      }
      if (capabilities.navigation && capabilities.closeWindow) capabilities.closeWindow();
      else history.back();
    },
    dispose() {
      disposed = true;
      target.removeEventListener("popstate", onPopState);
      watcher?.removeEventListener("cancel", onCancel);
      watcher?.removeEventListener("close", onClose);
      watcher?.destroy();
      watcher = null;
    },
    capabilities: { closeWatcher: Boolean(capabilities.CloseWatcher), navigation: Boolean(capabilities.navigation) },
  };
}
