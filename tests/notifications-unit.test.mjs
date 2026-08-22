import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { sendWebPush, validatePushSubscription } from "../lib/web-push.ts";

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function concatBytes(...values) {
  return Buffer.concat(values.map((value) => Buffer.from(value)));
}

async function hkdf(input, salt, info, length) {
  const key = await crypto.subtle.importKey("raw", Buffer.from(input), "HKDF", false, ["deriveBits"]);
  return Buffer.from(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: Buffer.from(salt), info: Buffer.from(info) }, key, length * 8));
}

async function keyMaterial() {
  const vapidKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", vapidKeys.publicKey));
  const privateKey = await crypto.subtle.exportKey("jwk", vapidKeys.privateKey);
  const receiverKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const receiverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", receiverKeys.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    configuration: { publicKey: base64Url(publicKey), privateKey: privateKey.d, subject: "mailto:admin@nutriplus.test" },
    subscription: {
      endpoint: "https://push.example.test/device-1",
      p256dh: base64Url(receiverPublic),
      auth: base64Url(authSecret),
    },
    receiverPrivateKey: receiverKeys.privateKey,
    receiverPublic,
    authSecret,
  };
}

test("Web Push validates subscriptions and sends an encrypted VAPID-authenticated request", async () => {
  const material = await keyMaterial();
  const calls = [];
  const response = await sendWebPush(material.subscription, {
    title: "Inventario bajo",
    body: "Omega 3 tiene 2 unidades",
    url: "/?tab=products&stock=low",
  }, material.configuration, async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(null, { status: 201 });
  });
  assert.equal(response.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, material.subscription.endpoint);
  assert.match(calls[0].init.headers.Authorization, /^vapid t=[^.]+\.[^.]+\.[^,]+, k=/);
  assert.equal(calls[0].init.headers["Content-Encoding"], "aes128gcm");
  assert.equal(calls[0].init.headers.TTL, "86400");
  assert.equal(calls[0].init.redirect, "manual");
  const encrypted = Buffer.from(calls[0].init.body);
  assert.ok(encrypted.length > 40);
  assert.equal(encrypted.includes(Buffer.from("Inventario bajo")), false, "notification text must not be sent as plaintext");
  assert.equal(calls[0].init.headers.Authorization.includes(material.configuration.privateKey), false, "the VAPID private key must never be sent");

  const authMatch = /^vapid t=([^,]+), k=(.+)$/.exec(calls[0].init.headers.Authorization);
  assert.ok(authMatch);
  const [header, claims, signature] = authMatch[1].split(".");
  const verifyKey = await crypto.subtle.importKey("raw", Buffer.from(material.configuration.publicKey, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, Buffer.from(signature, "base64url"), Buffer.from(`${header}.${claims}`)), true, "VAPID JWT must verify with its public key");

  const salt = encrypted.subarray(0, 16);
  assert.equal(encrypted.readUInt32BE(16), 4096);
  const serverKeyLength = encrypted[20];
  const serverPublic = encrypted.subarray(21, 21 + serverKeyLength);
  const ciphertext = encrypted.subarray(21 + serverKeyLength);
  const serverKey = await crypto.subtle.importKey("raw", serverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecret = Buffer.from(await crypto.subtle.deriveBits({ name: "ECDH", public: serverKey }, material.receiverPrivateKey, 256));
  const keyInfo = concatBytes(Buffer.from("WebPush: info\0"), material.receiverPublic, serverPublic);
  const inputKeyMaterial = await hkdf(sharedSecret, material.authSecret, keyInfo, 32);
  const contentEncryptionKey = await hkdf(inputKeyMaterial, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(inputKeyMaterial, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const decryptKey = await crypto.subtle.importKey("raw", contentEncryptionKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const record = Buffer.from(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, decryptKey, ciphertext));
  assert.equal(record.at(-1), 2);
  assert.deepEqual(JSON.parse(record.subarray(0, -1).toString("utf8")), {
    title: "Inventario bajo",
    body: "Omega 3 tiene 2 unidades",
    url: "/?tab=products&stock=low",
  }, "the push service payload must be valid aes128gcm Web Push content");

  assert.throws(() => validatePushSubscription({ ...material.subscription, endpoint: "http://push.example.test/device" }), /PUSH_ENDPOINT_INVALID/);
  assert.throws(() => validatePushSubscription({ ...material.subscription, endpoint: "https://localhost/device" }), /PUSH_ENDPOINT_INVALID/);
  assert.throws(() => validatePushSubscription({ ...material.subscription, endpoint: "https://127.0.0.1/device" }), /PUSH_ENDPOINT_INVALID/);
  assert.throws(() => validatePushSubscription({ ...material.subscription, auth: "bad" }), /PUSH_AUTH_INVALID/);
});

test("Web Push rejects a VAPID private key that does not match its public key before transport", async () => {
  const material = await keyMaterial();
  const other = await keyMaterial();
  await assert.rejects(
    () => sendWebPush(material.subscription, { title: "Alerta" }, {
      ...material.configuration,
      privateKey: other.configuration.privateKey,
    }, async () => new Response(null, { status: 201 })),
    /VAPID_KEYPAIR_MISMATCH/,
  );
});

async function serviceWorkerHarness() {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const listeners = new Map();
  const notifications = [];
  const opened = [];
  const cache = {
    addAll: async () => undefined,
    match: async () => null,
    put: async () => undefined,
  };
  const self = {
    location: { origin: "https://nutriplus.test" },
    addEventListener(type, listener) { listeners.set(type, listener); },
    skipWaiting() {},
    registration: { async showNotification(title, options) { notifications.push({ title, options }); } },
    clients: {
      claim: async () => undefined,
      matchAll: async () => [],
      async openWindow(target) { opened.push(target); return { target }; },
    },
  };
  const context = {
    self,
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    fetch: async () => new Response("asset", { status: 200 }),
    URL,
    Response,
    Date,
  };
  vm.runInNewContext(source, context, { filename: "sw.js" });
  return { source, listeners, notifications, opened };
}

test("Service Worker never intercepts API data and accepts only safe same-origin notification targets", async () => {
  const harness = await serviceWorkerHarness();
  let apiResponded = false;
  harness.listeners.get("fetch")({
    request: { method: "GET", url: "https://nutriplus.test/api/products", mode: "cors", destination: "" },
    respondWith() { apiResponded = true; },
  });
  assert.equal(apiResponded, false, "critical API responses must never be served from Service Worker cache");

  let staticResponded = false;
  harness.listeners.get("fetch")({
    request: { method: "GET", url: "https://nutriplus.test/assets/app.js", mode: "cors", destination: "script" },
    respondWith() { staticResponded = true; },
  });
  assert.equal(staticResponded, true, "safe static assets may use shell caching");

  let pushPromise;
  harness.listeners.get("push")({
    data: { json: () => ({ title: "Alerta", body: "Mensaje", url: "https://evil.example/steal", tag: "safe-tag" }) },
    waitUntil(promise) { pushPromise = promise; },
  });
  await pushPromise;
  assert.equal(harness.notifications[0].options.data.url, "/?notifications=1");

  let clickPromise;
  harness.listeners.get("notificationclick")({
    notification: { data: { url: "/?tab=orders&section=special&order=order-1" }, close() {} },
    waitUntil(promise) { clickPromise = promise; },
  });
  await clickPromise;
  assert.equal(harness.opened[0], "/?tab=orders&section=special&order=order-1");
  assert.match(harness.source, /addEventListener\("push"/);
  assert.match(harness.source, /addEventListener\("notificationclick"/);
  assert.doesNotMatch(harness.source, /periodicSync|\/api\/products[^\n]*cache\.put/);
});

test("permission UX is user-initiated, actionable, and the manifest remains installable", async () => {
  const client = await readFile(new URL("../app/notification-center.tsx", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  const icon192 = await readFile(new URL("../public/nutriplus-icon-192.png", import.meta.url));
  const icon512 = await readFile(new URL("../public/nutriplus-icon-512.png", import.meta.url));
  const effectStart = client.indexOf("useEffect(() =>");
  const activateStart = client.indexOf("const activatePush");
  assert.ok(effectStart >= 0 && activateStart > effectStart);
  assert.equal((client.match(/Notification\.requestPermission\(\)/g) || []).length, 1);
  assert.ok(client.indexOf("Notification.requestPermission()") > activateStart, "permission may only be requested from the activation action");
  assert.doesNotMatch(client.slice(effectStart, activateStart), /requestPermission/);
  assert.match(client, /Las notificaciones están bloqueadas por el navegador/);
  assert.match(client, /Tus alertas siguen disponibles dentro de NutriPlus/);
  assert.match(client, /Sites no ofrece un scheduler/);
  assert.doesNotMatch(client, /new Notification\(|registration\.showNotification/);
  assert.deepEqual({ id: manifest.id, name: manifest.name, shortName: manifest.short_name, start: manifest.start_url, scope: manifest.scope, display: manifest.display }, {
    id: "/",
    name: "NutriPlus",
    shortName: "NutriPlus",
    start: "/",
    scope: "/",
    display: "standalone",
  });
  assert.ok(manifest.icons.some((icon) => icon.src === "/nutriplus-icon-192.png" && icon.sizes === "192x192" && icon.type === "image/png"));
  assert.ok(manifest.icons.some((icon) => icon.src === "/nutriplus-icon-512.png" && icon.sizes === "512x512" && icon.type === "image/png"));
  assert.deepEqual([icon192.readUInt32BE(16), icon192.readUInt32BE(20)], [192, 192]);
  assert.deepEqual([icon512.readUInt32BE(16), icon512.readUInt32BE(20)], [512, 512]);
});
