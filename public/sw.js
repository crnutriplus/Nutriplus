const CACHE_NAME = "nutriplus-offline-v2";
const LAST_ALERT_KEY = "/__nutriplus-last-low-stock-alert";
const APP_SHELL = ["/", "/manifest.webmanifest", "/nutriplus-logo.jpg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => undefined));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key.startsWith("nutriplus-") && key !== CACHE_NAME).map((key) => caches.delete(key)));
  await self.clients.claim();
})()));

function localDayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function checkLowStock(force = false) {
  const response = await fetch("/api/products?lowStock=1&limit=1000", { credentials: "include", cache: "no-store" });
  if (!response.ok) return;
  const data = await response.json();
  const products = (Array.isArray(data.products) ? data.products : []).filter((product) => !product.restockPurchasedAt);
  const cache = await caches.open(CACHE_NAME);
  if (!products.length) {
    await cache.delete(LAST_ALERT_KEY);
    return;
  }
  const today = localDayKey();
  const previous = await cache.match(LAST_ALERT_KEY);
  if (!force && previous && await previous.text() === today) return;
  const names = products.slice(0, 3).map((product) => product.name).join(", ");
  const zeroCount = products.filter((product) => product.quantityAvailable === 0).length;
  await self.registration.showNotification("Productos por abastecer", {
    body: `${products.length} pendiente${products.length === 1 ? "" : "s"}${zeroCount ? ` · ${zeroCount} con stock 0` : ""}: ${names}${products.length > 3 ? "…" : ""}`,
    icon: "/nutriplus-logo.jpg",
    badge: "/nutriplus-logo.jpg",
    tag: "nutriplus-low-stock-daily",
    data: { url: "/?tab=products&stock=low" }
  });
  await cache.put(LAST_ALERT_KEY, new Response(today));
}

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "nutriplus-low-stock") event.waitUntil(checkLowStock());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "CHECK_LOW_STOCK") event.waitUntil(checkLowStock(Boolean(event.data.force)));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put("/", response.clone());
        return response;
      } catch {
        return (await cache.match("/")) || Response.error();
      }
    })());
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch {
        return (await cache.match(request)) || new Response(JSON.stringify({ error: "Sin conexión y sin una copia guardada." }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    const network = fetch(request).then((response) => {
      if (response.ok) void cache.put(request, response.clone());
      return response;
    }).catch(() => cached || Response.error());
    return cached || network;
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/?tab=products&stock=low";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows[0];
    if (existing) {
      await existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  })());
});
