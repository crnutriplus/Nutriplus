export type ChatwootWebhookJobStatus = "pending" | "processing" | "completed" | "failed";

export type ChatwootWebhookJob = {
  id: string;
  deliveryId: string;
  eventType: string;
  accountId: number;
  contactId: number | null;
  conversationId: number | null;
  status: ChatwootWebhookJobStatus;
  attempts: number;
  leaseToken: string | null;
};

export type NewChatwootWebhookJob = Pick<ChatwootWebhookJob, "deliveryId" | "eventType" | "accountId" | "contactId" | "conversationId">;

export const CHATWOOT_WEBHOOK_OUTBOX_SQL = [
  `CREATE TABLE IF NOT EXISTS chatwoot_webhook_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    delivery_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    chatwoot_account_id INTEGER NOT NULL,
    chatwoot_contact_id INTEGER,
    chatwoot_conversation_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT,
    next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lease_token TEXT,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS chatwoot_webhook_jobs_due_idx ON chatwoot_webhook_jobs (status, next_attempt_at, created_at)",
  "CREATE INDEX IF NOT EXISTS chatwoot_webhook_jobs_lease_idx ON chatwoot_webhook_jobs (status, lease_expires_at)",
] as const;

const MAX_ATTEMPTS = 20;
const LEASE_MS = 120_000;
const RETRY_MAX_MS = 300_000;

const nowIso = (now = Date.now()) => new Date(now).toISOString();
const integer = (value: unknown) => Number.isInteger(Number(value)) ? Number(value) : null;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const id = () => crypto.randomUUID();

function cleanExpiredJobs(db: D1Database) {
  return db.prepare(`DELETE FROM chatwoot_webhook_jobs
    WHERE (status='completed' AND completed_at < datetime('now','-7 days'))
       OR (status='failed' AND attempts >= ? AND updated_at < datetime('now','-30 days'))`).bind(MAX_ATTEMPTS).run();
}

export function chatwootWebhookJobFromPayload(eventType: string, deliveryId: string, payload: Record<string, unknown>): NewChatwootWebhookJob | null {
  const accountId = integer(record(payload.account).id);
  if (!accountId) return null;
  if (eventType === "contact_created" || eventType === "contact_updated") {
    const contactId = integer(record(payload.contact).id ?? payload.id);
    return contactId ? { deliveryId, eventType, accountId, contactId, conversationId: null } : null;
  }
  if (eventType === "conversation_created" || eventType === "conversation_updated") {
    const conversationId = integer(record(payload.conversation).id ?? payload.id);
    return conversationId ? { deliveryId, eventType, accountId, contactId: null, conversationId } : null;
  }
  return null;
}

export async function enqueueChatwootWebhookJob(db: D1Database, job: NewChatwootWebhookJob) {
  await cleanExpiredJobs(db);
  const result = await db.prepare(`INSERT OR IGNORE INTO chatwoot_webhook_jobs (
    id, delivery_id, event_type, chatwoot_account_id, chatwoot_contact_id, chatwoot_conversation_id
  ) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id(), job.deliveryId, job.eventType, job.accountId, job.contactId, job.conversationId).run();
  return { created: result.meta.changes > 0 };
}

function rowToJob(row: Record<string, unknown> | null): ChatwootWebhookJob | null {
  if (!row) return null;
  const accountId = integer(row.chatwoot_account_id);
  const attempts = integer(row.attempts);
  if (!accountId || attempts === null || typeof row.id !== "string" || typeof row.delivery_id !== "string" || typeof row.event_type !== "string") return null;
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    eventType: row.event_type,
    accountId,
    contactId: integer(row.chatwoot_contact_id),
    conversationId: integer(row.chatwoot_conversation_id),
    status: row.status as ChatwootWebhookJobStatus,
    attempts,
    leaseToken: typeof row.lease_token === "string" ? row.lease_token : null,
  };
}

export async function claimNextChatwootWebhookJob(db: D1Database, now = Date.now()): Promise<ChatwootWebhookJob | null> {
  const at = nowIso(now);
  const candidate = await db.prepare(`SELECT * FROM chatwoot_webhook_jobs
    WHERE attempts < ? AND (
      (status IN ('pending','failed') AND next_attempt_at <= ?)
      OR (status='processing' AND lease_expires_at <= ?)
    ) ORDER BY created_at ASC LIMIT 1`).bind(MAX_ATTEMPTS, at, at).first<Record<string, unknown>>();
  const job = rowToJob(candidate);
  if (!job) return null;
  const leaseToken = id();
  const leaseExpiresAt = nowIso(now + LEASE_MS);
  const result = await db.prepare(`UPDATE chatwoot_webhook_jobs
    SET status='processing', attempts=attempts+1, lease_token=?, lease_expires_at=?, updated_at=?
    WHERE id=? AND attempts < ? AND (
      (status IN ('pending','failed') AND next_attempt_at <= ?)
      OR (status='processing' AND lease_expires_at <= ?)
    )`).bind(leaseToken, leaseExpiresAt, at, job.id, MAX_ATTEMPTS, at, at).run();
  if (!result.meta.changes) return null;
  return { ...job, status: "processing", attempts: job.attempts + 1, leaseToken };
}

export async function completeChatwootWebhookJob(db: D1Database, job: ChatwootWebhookJob, now = Date.now()) {
  await db.prepare(`UPDATE chatwoot_webhook_jobs
    SET status='completed', completed_at=?, updated_at=?, lease_token=NULL, lease_expires_at=NULL, last_error=NULL
    WHERE id=? AND status='processing' AND lease_token=?`).bind(nowIso(now), nowIso(now), job.id, job.leaseToken).run();
}

function sanitizedErrorCode(error: unknown) {
  const code = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code : "CHATWOOT_JOB_PROCESSING_FAILED";
  return /^[A-Z0-9_]{1,96}$/.test(code) ? code : "CHATWOOT_JOB_PROCESSING_FAILED";
}

export async function failChatwootWebhookJob(db: D1Database, job: ChatwootWebhookJob, error: unknown, now = Date.now()) {
  const delay = Math.min(RETRY_MAX_MS, 1_000 * 2 ** Math.min(job.attempts, 8));
  await db.prepare(`UPDATE chatwoot_webhook_jobs
    SET status='failed', last_error=?, next_attempt_at=?, updated_at=?, lease_token=NULL, lease_expires_at=NULL
    WHERE id=? AND status='processing' AND lease_token=?`).bind(sanitizedErrorCode(error), nowIso(now + delay), nowIso(now), job.id, job.leaseToken).run();
}

export async function processNextChatwootWebhookJob(
  db: D1Database,
  processor: (job: ChatwootWebhookJob) => Promise<void>,
  now = Date.now(),
) {
  const job = await claimNextChatwootWebhookJob(db, now);
  if (!job) return { processed: false };
  try {
    await processor(job);
    await completeChatwootWebhookJob(db, job);
    return { processed: true, completed: true, jobId: job.id };
  } catch (error) {
    await failChatwootWebhookJob(db, job, error);
    return { processed: true, completed: false, jobId: job.id };
  }
}

export async function drainChatwootWebhookJobs(
  db: D1Database,
  processor: (job: ChatwootWebhookJob) => Promise<void>,
  limit = 3,
) {
  let processed = 0;
  for (let index = 0; index < limit; index++) {
    const result = await processNextChatwootWebhookJob(db, processor);
    if (!result.processed) break;
    processed++;
  }
  return { processed };
}
