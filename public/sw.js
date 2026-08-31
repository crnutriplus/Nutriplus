const CACHE_NAME = "nutriplus-shell-v5";
const APP_SHELL = ["/", "/manifest.webmanifest", "/nutriplus-icon-192.png", "/nutriplus-icon-512.png"];
const PENDING_NAVIGATION_KEY = "/__nutriplus/pending-notification-navigation";
const PENDING_NAVIGATION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_DESTINATION = { type: "NOTIFICATIONS" };
const SAFE_ID = /^[A-Za-z0-9:_-]{1,160}$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function safeId(value) {
  const text = typeof value === "string" ? value.trim() : String(value || "").trim();
  return SAFE_ID.test(text) ? text : "";
}

function safeDate(value) {
  return typeof value === "string" && DATE_KEY.test(value.trim()) ? value.trim() : "";
}

// Only the typed, internal destination schema may affect navigation. This is
// intentionally separate from URL parsing so a push payload cannot become an
// open redirect, javascript: URL, or arbitrary app route.
function safeDestination(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_DESTINATION;
  if (value.type === "PRODUCT" && /^\d+$/.test(safeId(value.id)) && Number(value.id) > 0) return { type: "PRODUCT", id: String(Number(value.id)) };
  if (value.type === "PRODUCTS") return { type: "PRODUCTS" };
  if (value.type === "ORDER") {
    const id = safeId(value.id);
    if (id && ["deliveries", "special", "history"].includes(value.section)) return { type: "ORDER", id, section: value.section };
  }
  if (value.type === "ORDER_SUMMARY") {
    const date = safeDate(value.date);
    if (date) return { type: "ORDER_SUMMARY", date };
  }
  if (value.type === "ROUTE") {
    const date = safeDate(value.date);
    const id = safeId(value.id);
    if (date) return { type: "ROUTE", date, ...(id ? { id } : {}) };
  }
  if (value.type === "INVOICE") {
    const id = safeId(value.id);
    if (id) return { type: "INVOICE", id };
  }
  if (value.type === "NOTIFICATIONS") return DEFAULT_DESTINATION;
  return DEFAULT_DESTINATION;
}

function destinationTarget(destination) {
  if (destination.type === "PRODUCT") return `/?tab=products&product=${encodeURIComponent(destination.id)}`;
  if (destination.type === "PRODUCTS") return "/?tab=products";
  if (destination.type === "ORDER") return `/?tab=orders&section=${destination.section}&order=${encodeURIComponent(destination.id)}`;
  if (destination.type === "ORDER_SUMMARY") return `/?tab=orders&section=deliveries&date=${encodeURIComponent(destination.date)}`;
  if (destination.type === "ROUTE") return `/?tab=orders&route=1&date=${encodeURIComponent(destination.date)}${destination.id ? `&routeId=${encodeURIComponent(destination.id)}` : ""}`;
  if (destination.type === "INVOICE") return `/?tab=products&invoice=${encodeURIComponent(destination.id)}`;
  return "/?notifications=1";
}

async function pendingNavigation() {
  const cache = await caches.open(CACHE_NAME);
  const response = await cache.match(PENDING_NAVIGATION_KEY);
  if (!response) return null;
  try {
    const value = await response.json();
    const destination = safeDestination(value.destination);
    const navigationId = safeId(value.navigationId);
    const createdAt = Number(value.createdAt || 0);
    if (!navigationId || !createdAt || Date.now() - createdAt > PENDING_NAVIGATION_TTL_MS) {
      await cache.delete(PENDING_NAVIGATION_KEY);
      return null;
    }
    return { navigationId, destination, createdAt };
  } catch {
    await cache.delete(PENDING_NAVIGATION_KEY);
    return null;
  }
}

async function rememberNavigation(destination) {
  const randomPart = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  const navigation = {
    navigationId: `pushnav-${Date.now()}-${randomPart}`,
    destination,
    createdAt: Date.now(),
  };
  const cache = await caches.open(CACHE_NAME);
  await cache.put(PENDING_NAVIGATION_KEY, new Response(JSON.stringify(navigation), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  }));
  return navigation;
}

async function acknowledgeNavigation(navigationId) {
  const navigation = await pendingNavigation();
  if (!navigation || navigation.navigationId !== safeId(navigationId)) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.delete(PENDING_NAVIGATION_KEY);
}

// Old durable pushes may still contain a target URL. Accept only the small
// former NutriPlus query subset while they age out; never use the URL itself.
function legacyDestination(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return DEFAULT_DESTINATION;
  try {
    const target = new URL(value, self.location.origin);
    if (target.origin !== self.location.origin || target.pathname !== "/") return DEFAULT_DESTINATION;
    const tab = target.searchParams.get("tab");
    if (tab === "products") {
      const productId = target.searchParams.get("product") || "";
      if (/^\d+$/.test(productId) && Number(productId) > 0) return { type: "PRODUCT", id: String(Number(productId)) };
      const invoiceId = safeId(target.searchParams.get("invoice"));
      return invoiceId ? { type: "INVOICE", id: invoiceId } : { type: "PRODUCTS" };
    }
    if (tab === "orders") {
      const section = target.searchParams.get("section");
      const orderId = safeId(target.searchParams.get("order"));
      const date = safeDate(target.searchParams.get("date"));
      const routeId = safeId(target.searchParams.get("routeId"));
      if (target.searchParams.get("route") === "1" && date) return { type: "ROUTE", date, ...(routeId ? { id: routeId } : {}) };
      if (section === "deliveries" && date) return { type: "ORDER_SUMMARY", date };
      if (orderId && ["deliveries", "special", "history"].includes(section)) return { type: "ORDER", id: orderId, section };
    }
    if (target.searchParams.get("notifications") === "1") return DEFAULT_DESTINATION;
  } catch { /* invalid legacy targets fall back to the alert center */ }
  return DEFAULT_DESTINATION;
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("nutriplus-") && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) void caches.open(CACHE_NAME).then((cache) => cache.put("/", response.clone()));
        return response;
      } catch {
        return (await caches.open(CACHE_NAME).then((cache) => cache.match("/"))) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && ["style", "script", "image", "font", "manifest", "worker"].includes(request.destination)) {
      void cache.put(request, response.clone());
    }
    return response;
  })());
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
    const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim().slice(0, 100) : "NutriPlus";
    const body = typeof payload.body === "string" ? payload.body.trim().slice(0, 300) : "Tenés una nueva alerta en NutriPlus.";
    const tag = typeof payload.tag === "string" ? payload.tag.slice(0, 180) : `nutriplus-${Date.now()}`;
    const destination = payload.destination ? safeDestination(payload.destination) : legacyDestination(payload.url);
    await self.registration.showNotification(title, {
      body,
      icon: "/nutriplus-icon-192.png",
      badge: "/nutriplus-icon-192.png",
      tag,
      renotify: false,
      data: {
        notificationId: typeof payload.notificationId === "string" ? payload.notificationId : null,
        destination,
      },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = safeDestination(event.notification.data?.destination);
  const target = destinationTarget(destination);
  event.waitUntil((async () => {
    const navigation = await rememberNavigation(destination);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => "focus" in client);
    if (existing) {
      await existing.focus();
      if ("postMessage" in existing) existing.postMessage({ type: "NUTRIPLUS_NAVIGATE", destination, navigationId: navigation.navigationId });
      return existing;
    }
    return self.clients.openWindow(target);
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "NUTRIPLUS_CLIENT_READY" && event.source && "postMessage" in event.source) {
    event.waitUntil((async () => {
      const navigation = await pendingNavigation();
      if (navigation) event.source.postMessage({ type: "NUTRIPLUS_NAVIGATE", destination: navigation.destination, navigationId: navigation.navigationId });
    })());
  }
  if (event.data?.type === "NUTRIPLUS_NAVIGATION_ACK") {
    event.waitUntil(acknowledgeNavigation(event.data.navigationId));
  }
});
