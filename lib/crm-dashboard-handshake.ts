const BOOTSTRAP_EVENT = "nutriplus-dashboard-bootstrap";
const MAX_TOKEN_LENGTH = 8192;

const DASHBOARD_READY_EVENT = "nutriplus-dashboard-app:ready";

export function notifyCrmDashboardReady(
  parentWindow: { postMessage(data: string, targetOrigin: string): void },
  parentOrigin: string,
  nativeBridge?: { postMessage(data: string): void },
) {
  parentWindow.postMessage(DASHBOARD_READY_EVENT, parentOrigin);
  nativeBridge?.postMessage(DASHBOARD_READY_EVENT);
}

export function crmDashboardParentOrigin(baseUrl: string | undefined) {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

export function isSuccessfulCrmDashboardSessionExchange(status: number) {
  return status === 201;
}

export function isTrustedCrmDashboardMessage(
  event: { origin: string; source: unknown },
  expectedOrigin: string,
  parentWindow: unknown,
) {
  return event.origin === expectedOrigin && event.source === parentWindow;
}

export function parseCrmDashboardBootstrapMessage(input: unknown) {
  if (typeof input !== "string") return null;

  let message: unknown;
  try {
    message = JSON.parse(input);
  } catch {
    return null;
  }

  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const record = message as Record<string, unknown>;
  if (record.event !== BOOTSTRAP_EVENT) return null;

  const data = record.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const token = (data as Record<string, unknown>).token;
  if (typeof token !== "string") return null;

  const normalized = token.trim();
  if (!normalized || normalized.length > MAX_TOKEN_LENGTH) return null;
  return normalized;
}
