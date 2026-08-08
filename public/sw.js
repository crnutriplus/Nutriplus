const CACHE_NAME = "nutriplus-notifications-v1";
const LAST_ALERT_KEY = "/__nutriplus-last-low-stock-alert";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function localDayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function checkLowStock(force = false) {
  const response = await fetch("/api/products?lowStock=1&limit=1000", { credentials: "include", cache: "no-store" });
  if (!response.ok) return;
  const data = await response.json();
  const products = Array.isArray(data.products) ? data.products : [];
  const cache = await caches.open(CACHE_NAME);
  if (!products.length) {
    await cache.delete(LAST_ALERT_KEY);
    return;
  }
  const today = localDayKey();
  const previous = await cache.match(LAST_ALERT_KEY);
  if (!force && previous && await previous.text() === today) return;
  const names = products.slice(0, 3).map((product) => product.name).join(", ");
  await self.registration.showNotification("Stock bajo en NutriPlus", {
    body: `${products.length} producto${products.length === 1 ? " llegó" : "s llegaron"} al mínimo: ${names}${products.length > 3 ? "…" : ""}`,
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
