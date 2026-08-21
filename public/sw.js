const CACHE_NAME = "nutriplus-shell-v3";
const APP_SHELL = ["/", "/manifest.webmanifest", "/nutriplus-icon-192.png", "/nutriplus-icon-512.png"];
const DEFAULT_TARGET = "/?notifications=1";

function safeTarget(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return DEFAULT_TARGET;
  try {
    const target = new URL(value, self.location.origin);
    return target.origin === self.location.origin ? `${target.pathname}${target.search}${target.hash}` : DEFAULT_TARGET;
  } catch {
    return DEFAULT_TARGET;
  }
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
    await self.registration.showNotification(title, {
      body,
      icon: "/nutriplus-icon-192.png",
      badge: "/nutriplus-icon-192.png",
      tag,
      renotify: false,
      data: {
        notificationId: typeof payload.notificationId === "string" ? payload.notificationId : null,
        url: safeTarget(payload.url),
      },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = safeTarget(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => "focus" in client);
    if (existing) {
      await existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
