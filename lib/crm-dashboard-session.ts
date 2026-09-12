import { CrmError } from "./crm";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const CRM_DASHBOARD_SESSION_COOKIE = "nutriplus_crm_session";
export const CRM_DASHBOARD_SESSION_TTL_SECONDS = 30 * 60;

const JWT_ISSUER = "chatwoot";
const JWT_AUDIENCE = "nutriplus-crm";
const MAX_BOOTSTRAP_TOKEN_AGE_SECONDS = 10 * 60;
const CLOCK_SKEW_SECONDS = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID = /^crm-session-[0-9a-f-]{36}$/i;

async function hashSessionId(sessionId: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(sessionId));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type JsonObject = Record<string, unknown>;

export type CrmDashboardBootstrapClaims = {
  accountId: number;
  contactId: number;
  conversationId: number;
  agentId: number;
  subject: string;
  jti: string;
  issuedAt: number;
  expiresAt: number;
};

export type CrmDashboardSession = {
  id: string;
  accountId: number;
  contactId: number;
  conversationId: number;
  agentId: number;
  expiresAt: string;
};

function authError(message: string, code = "CRM_DASHBOARD_AUTH_INVALID") {
  return new CrmError(message, 401, code);
}

function decodeBase64Url(value: string) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw authError("Token de Dashboard App inválido.");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw authError("Token de Dashboard App inválido.");
  }
}

function decodeJson(value: string): JsonObject {
  try {
    const parsed = JSON.parse(decoder.decode(decodeBase64Url(value)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as JsonObject;
  } catch (error) {
    if (error instanceof CrmError) throw error;
    throw authError("Token de Dashboard App inválido.");
  }
}

function positiveInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw authError(`Claim ${field} inválido.`);
  return Number(value);
}

function unixTime(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw authError(`Claim ${field} inválido.`);
  return Number(value);
}

export async function verifyCrmDashboardBootstrapToken(
  token: string,
  secret = globalThis.__NUTRIPLUS_DASHBOARD_APP_SECRET__,
  nowMs = Date.now(),
): Promise<CrmDashboardBootstrapClaims> {
  if (!secret || secret.length < 32) {
    throw new CrmError("Dashboard App no está configurado.", 503, "CRM_DASHBOARD_NOT_CONFIGURED");
  }

  const parts = token.split(".");
  if (parts.length !== 3) throw authError("Token de Dashboard App inválido.");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader);
  const payload = decodeJson(encodedPayload);

  if (header.alg !== "HS256" || (header.typ != null && header.typ !== "JWT")) {
    throw authError("Algoritmo de Dashboard App no permitido.");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    decodeBase64Url(encodedSignature),
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) throw authError("Firma de Dashboard App inválida.", "CRM_DASHBOARD_SIGNATURE_INVALID");

  if (payload.iss !== JWT_ISSUER || payload.aud !== JWT_AUDIENCE) {
    throw authError("Emisor o audiencia de Dashboard App inválidos.");
  }

  const issuedAt = unixTime(payload.iat, "iat");
  const expiresAt = unixTime(payload.exp, "exp");
  const now = Math.floor(nowMs / 1000);
  if (
    issuedAt > now + CLOCK_SKEW_SECONDS ||
    issuedAt < now - MAX_BOOTSTRAP_TOKEN_AGE_SECONDS ||
    expiresAt <= now - CLOCK_SKEW_SECONDS ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_BOOTSTRAP_TOKEN_AGE_SECONDS
  ) {
    throw authError("Token de Dashboard App expirado o fuera de ventana.", "CRM_DASHBOARD_TOKEN_EXPIRED");
  }

  const accountId = positiveInteger(payload.account_id, "account_id");
  const contactId = positiveInteger(payload.contact_id, "contact_id");
  const conversationId = positiveInteger(payload.conversation_id, "conversation_id");
  const agentId = positiveInteger(payload.agent_id, "agent_id");
  const subject = typeof payload.sub === "string" ? payload.sub : "";
  if (subject !== String(agentId)) throw authError("Sujeto de Dashboard App inválido.");

  const jti = typeof payload.jti === "string" ? payload.jti : "";
  if (!UUID.test(jti)) throw authError("jti de Dashboard App inválido.");

  return { accountId, contactId, conversationId, agentId, subject, jti, issuedAt, expiresAt };
}

export async function createCrmDashboardSession(
  db: D1Database,
  claims: CrmDashboardBootstrapClaims,
  nowMs = Date.now(),
): Promise<CrmDashboardSession> {
  const id = `crm-session-${crypto.randomUUID()}`;
  const idHash = await hashSessionId(id);
  const expiresAt = new Date(nowMs + CRM_DASHBOARD_SESSION_TTL_SECONDS * 1000).toISOString();

  await db.prepare(`INSERT OR IGNORE INTO crm_dashboard_sessions (
    id,bootstrap_jti,chatwoot_account_id,chatwoot_contact_id,chatwoot_conversation_id,chatwoot_agent_id,expires_at
  ) VALUES (?,?,?,?,?,?,?)`).bind(
    idHash,
    claims.jti,
    claims.accountId,
    claims.contactId,
    claims.conversationId,
    claims.agentId,
    expiresAt,
  ).run();

  const created = await db.prepare("SELECT id FROM crm_dashboard_sessions WHERE id=?").bind(idHash).first<{ id: string }>();
  if (!created) throw authError("El token de Dashboard App ya fue utilizado.", "CRM_DASHBOARD_BOOTSTRAP_REPLAYED");

  return {
    id,
    accountId: claims.accountId,
    contactId: claims.contactId,
    conversationId: claims.conversationId,
    agentId: claims.agentId,
    expiresAt,
  };
}

export async function getCrmDashboardSession(
  db: D1Database,
  request: Request,
  nowMs = Date.now(),
): Promise<CrmDashboardSession | null> {
  const sessionId = dashboardSessionIdFromRequest(request);
  if (!sessionId) return null;
  const sessionIdHash = await hashSessionId(sessionId);
  const now = new Date(nowMs).toISOString();
  const row = await db.prepare(`SELECT id,chatwoot_account_id,chatwoot_contact_id,chatwoot_conversation_id,
    chatwoot_agent_id,expires_at FROM crm_dashboard_sessions
    WHERE id=? AND revoked_at IS NULL AND julianday(expires_at) > julianday(?)`).bind(sessionIdHash, now).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: sessionId,
    accountId: Number(row.chatwoot_account_id),
    contactId: Number(row.chatwoot_contact_id),
    conversationId: Number(row.chatwoot_conversation_id),
    agentId: Number(row.chatwoot_agent_id),
    expiresAt: String(row.expires_at),
  };
}

export function dashboardSessionIdFromRequest(request: Request) {
  const header = request.headers.get("cookie") ?? "";
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const name = item.slice(0, separator).trim();
    if (name !== CRM_DASHBOARD_SESSION_COOKIE) continue;
    try {
      const value = decodeURIComponent(item.slice(separator + 1).trim());
      return SESSION_ID.test(value) ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function crmDashboardSessionCookie(sessionId: string) {
  if (!SESSION_ID.test(sessionId)) throw new Error("Invalid CRM dashboard session id");
  return `${CRM_DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${CRM_DASHBOARD_SESSION_TTL_SECONDS}`;
}

export function clearCrmDashboardSessionCookie() {
  return `${CRM_DASHBOARD_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
}
