const BOOTSTRAP_EVENT = "nutriplus-dashboard-bootstrap";
const MAX_TOKEN_LENGTH = 8192;

export function crmDashboardParentOrigin(baseUrl: string | undefined) {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
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
