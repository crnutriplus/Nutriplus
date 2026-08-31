export type NotificationDestination =
  | { type: "PRODUCT"; id: string }
  | { type: "PRODUCTS" }
  | { type: "ORDER"; id: string; section: "deliveries" | "special" | "history" }
  | { type: "ORDER_SUMMARY"; date: string }
  | { type: "ROUTE"; date: string; id?: string }
  | { type: "INVOICE"; id: string }
  | { type: "NOTIFICATIONS" };

const SAFE_ID = /^[A-Za-z0-9:_-]{1,160}$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function id(value: unknown) {
  const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return SAFE_ID.test(text) ? text : "";
}

function date(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return DATE_KEY.test(text) ? text : "";
}

/**
 * Validates the compact, typed destination carried by an internal alert. It
 * deliberately has no URL input: arbitrary URLs are never navigation data.
 */
export function parseNotificationDestination(value: unknown): NotificationDestination | null {
  const candidate = object(value);
  if (!candidate || typeof candidate.type !== "string") return null;
  if (candidate.type === "PRODUCT" && /^\d+$/.test(id(candidate.id)) && Number(candidate.id) > 0) return { type: "PRODUCT", id: String(Number(candidate.id)) };
  if (candidate.type === "PRODUCTS") return { type: "PRODUCTS" };
  if (candidate.type === "ORDER") {
    const section = candidate.section;
    const orderId = id(candidate.id);
    if (orderId && (section === "deliveries" || section === "special" || section === "history")) return { type: "ORDER", id: orderId, section };
  }
  if (candidate.type === "ORDER_SUMMARY") {
    const selectedDate = date(candidate.date);
    if (selectedDate) return { type: "ORDER_SUMMARY", date: selectedDate };
  }
  if (candidate.type === "ROUTE") {
    const routeDate = date(candidate.date);
    const routeId = id(candidate.id);
    if (routeDate) return { type: "ROUTE", date: routeDate, ...(routeId ? { id: routeId } : {}) };
  }
  if (candidate.type === "INVOICE") {
    const documentId = id(candidate.id);
    if (documentId) return { type: "INVOICE", id: documentId };
  }
  if (candidate.type === "NOTIFICATIONS") return { type: "NOTIFICATIONS" };
  return null;
}

export function notificationDestinationPath(destination: NotificationDestination) {
  if (destination.type === "PRODUCT") return `/?tab=products&product=${encodeURIComponent(destination.id)}`;
  if (destination.type === "PRODUCTS") return "/?tab=products";
  if (destination.type === "ORDER") return `/?tab=orders&section=${destination.section}&order=${encodeURIComponent(destination.id)}`;
  if (destination.type === "ORDER_SUMMARY") return `/?tab=orders&section=deliveries&date=${encodeURIComponent(destination.date)}`;
  if (destination.type === "ROUTE") return `/?tab=orders&route=1&date=${encodeURIComponent(destination.date)}${destination.id ? `&routeId=${encodeURIComponent(destination.id)}` : ""}`;
  if (destination.type === "INVOICE") return `/?tab=products&invoice=${encodeURIComponent(destination.id)}`;
  return "/?notifications=1";
}

/** Allows only prior NutriPlus destinations already stored before typed metadata. */
export function legacyNotificationDestination(value: unknown): NotificationDestination | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  let parsed: URL;
  try { parsed = new URL(value, "https://nutriplus.internal"); } catch { return null; }
  if (parsed.origin !== "https://nutriplus.internal" || parsed.pathname !== "/") return null;
  const tab = parsed.searchParams.get("tab");
  if (tab === "products") {
    const productId = parsed.searchParams.get("product") || "";
    if (/^\d+$/.test(productId) && Number(productId) > 0) return { type: "PRODUCT", id: String(Number(productId)) };
    const documentId = id(parsed.searchParams.get("invoice"));
    if (documentId) return { type: "INVOICE", id: documentId };
    return { type: "PRODUCTS" };
  }
  if (tab === "orders") {
    const section = parsed.searchParams.get("section");
    const orderId = parsed.searchParams.get("order") || "";
    const routeDate = date(parsed.searchParams.get("date"));
    const routeId = id(parsed.searchParams.get("routeId"));
    if (parsed.searchParams.get("route") === "1" && routeDate) return { type: "ROUTE", date: routeDate, ...(routeId ? { id: routeId } : {}) };
    if (section === "deliveries" && routeDate) return { type: "ORDER_SUMMARY", date: routeDate };
    if (orderId && (section === "deliveries" || section === "special" || section === "history")) return { type: "ORDER", id: orderId, section };
  }
  if (parsed.searchParams.get("notifications") === "1") return { type: "NOTIFICATIONS" };
  return null;
}

export function notificationDestinationFromMetadata(metadata: unknown, targetUrl?: unknown) {
  const source = object(metadata);
  return parseNotificationDestination(source?.destination)
    || legacyNotificationDestination(targetUrl)
    || ({ type: "NOTIFICATIONS" } as NotificationDestination);
}
