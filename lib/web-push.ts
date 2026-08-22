export type WebPushSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type VapidConfiguration = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

const encoder = new TextEncoder();

function base64UrlToBytes(value: string) {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64Url(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function concatBytes(...values: Uint8Array[]) {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

async function hkdf(input: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) {
  const inputBuffer = Uint8Array.from(input).buffer;
  const saltBuffer = Uint8Array.from(salt).buffer;
  const infoBuffer = Uint8Array.from(info).buffer;
  const key = await crypto.subtle.importKey("raw", inputBuffer, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: saltBuffer, info: infoBuffer }, key, length * 8);
  return new Uint8Array(bits);
}

function validatePublicKey(value: string, label: string) {
  const bytes = base64UrlToBytes(value);
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error(`${label}_INVALID`);
  return bytes;
}

function validateAuth(value: string) {
  const bytes = base64UrlToBytes(value);
  if (bytes.length !== 16) throw new Error("PUSH_AUTH_INVALID");
  return bytes;
}

function isPrivateIpv4(hostname: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  const octets = hostname.split(".").map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return true;
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && [18, 19].includes(second));
}

function validPushHostname(url: URL) {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return false;
  if (hostname.includes(":")) return false;
  return !isPrivateIpv4(hostname);
}

export function validatePushSubscription(subscription: WebPushSubscription) {
  let endpoint: URL;
  try { endpoint = new URL(subscription.endpoint); } catch { throw new Error("PUSH_ENDPOINT_INVALID"); }
  if (endpoint.protocol !== "https:" || subscription.endpoint.length > 4096
    || endpoint.username || endpoint.password || (endpoint.port && endpoint.port !== "443")
    || !validPushHostname(endpoint)) throw new Error("PUSH_ENDPOINT_INVALID");
  validatePublicKey(subscription.p256dh, "PUSH_P256DH");
  validateAuth(subscription.auth);
  return { endpoint: endpoint.toString(), p256dh: subscription.p256dh.trim(), auth: subscription.auth.trim() };
}

function vapidJwk(configuration: VapidConfiguration) {
  const publicKey = validatePublicKey(configuration.publicKey, "VAPID_PUBLIC_KEY");
  const privateKey = base64UrlToBytes(configuration.privateKey);
  if (privateKey.length !== 32) throw new Error("VAPID_PRIVATE_KEY_INVALID");
  return {
    publicKey,
    jwk: {
      kty: "EC",
      crv: "P-256",
      x: bytesToBase64Url(publicKey.slice(1, 33)),
      y: bytesToBase64Url(publicKey.slice(33, 65)),
      d: bytesToBase64Url(privateKey),
      ext: true,
    } satisfies JsonWebKey,
  };
}

async function vapidAuthorization(endpoint: string, configuration: VapidConfiguration, now = Date.now()) {
  const { publicKey, jwk } = vapidJwk(configuration);
  const subject = configuration.subject.trim();
  if (!/^mailto:[^\s@]+@[^\s@]+$/.test(subject) && !/^https:\/\//.test(subject)) throw new Error("VAPID_SUBJECT_INVALID");
  const audience = new URL(endpoint).origin;
  const header = bytesToBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToBase64Url(encoder.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: subject,
  })));
  const unsignedToken = `${header}.${claims}`;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch {
    throw new Error("VAPID_KEYPAIR_MISMATCH");
  }
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsignedToken));
  const verificationKey = await crypto.subtle.importKey("raw", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const matches = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, verificationKey, signature, encoder.encode(unsignedToken),
  );
  if (!matches) throw new Error("VAPID_KEYPAIR_MISMATCH");
  return `vapid t=${unsignedToken}.${bytesToBase64Url(signature)}, k=${bytesToBase64Url(publicKey)}`;
}

async function encryptPayload(subscription: WebPushSubscription, payload: string) {
  const receiverPublicKey = validatePublicKey(subscription.p256dh, "PUSH_P256DH");
  const authSecret = validateAuth(subscription.auth);
  const payloadBytes = encoder.encode(payload);
  if (payloadBytes.length > 3000) throw new Error("PUSH_PAYLOAD_TOO_LARGE");

  const serverKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const serverPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));
  const receiverKey = await crypto.subtle.importKey("raw", receiverPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, serverKeys.privateKey, 256));
  const keyInfo = concatBytes(encoder.encode("WebPush: info\0"), receiverPublicKey, serverPublicKey);
  const inputKeyMaterial = await hkdf(sharedSecret, authSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentEncryptionKey = await hkdf(inputKeyMaterial, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(inputKeyMaterial, salt, encoder.encode("Content-Encoding: nonce\0"), 12);
  const record = concatBytes(payloadBytes, Uint8Array.of(2));
  const aesKey = await crypto.subtle.importKey("raw", contentEncryptionKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));
  const header = new Uint8Array(16 + 4 + 1 + serverPublicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = serverPublicKey.length;
  header.set(serverPublicKey, 21);
  return concatBytes(header, ciphertext);
}

export async function sendWebPush(
  rawSubscription: WebPushSubscription,
  payload: Record<string, unknown>,
  configuration: VapidConfiguration,
  fetchImplementation: typeof fetch = fetch,
) {
  const subscription = validatePushSubscription(rawSubscription);
  const endpoint = subscription.endpoint;
  const body = await encryptPayload(subscription, JSON.stringify(payload));
  const authorization = await vapidAuthorization(endpoint, configuration);
  return fetchImplementation(endpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
    },
    body,
  });
}

export function hasValidVapidConfiguration(configuration: Partial<VapidConfiguration>) {
  try {
    if (!configuration.publicKey || !configuration.privateKey || !configuration.subject) return false;
    vapidJwk(configuration as VapidConfiguration);
    const subject = configuration.subject.trim();
    return /^mailto:[^\s@]+@[^\s@]+$/.test(subject) || /^https:\/\//.test(subject);
  } catch {
    return false;
  }
}

export const webPushEncoding = {
  base64UrlToBytes,
  bytesToBase64Url,
};
