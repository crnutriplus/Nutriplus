import { META_CAPI_DATABASE_SQL } from "./meta-capi-database";

export type MetaCapiJobStatus = "pending" | "processing" | "completed" | "failed";
export type MetaCapiEventName = "LeadSubmitted" | "Purchase";

export type MetaCapiJob = {
  id: string;
  dedupeKey: string;
  eventId: string;
  eventName: MetaCapiEventName;
  eventTime: string;
  orderId: string | null;
  orderNumber: string | null;
  valueCrc: number | null;
  accountId: number;
  conversationId: number;
  status: MetaCapiJobStatus;
  attempts: number;
  leaseToken: string | null;
};

export type NewMetaCapiJob = {
  dedupeKey: string;
  eventId: string;
  eventName: MetaCapiEventName;
  eventTime: string;
  orderId?: string | null;
  orderNumber?: string | null;
  valueCrc?: number | null;
  accountId: number;
  conversationId: number;
};

const MAX_ATTEMPTS = 20;
const LEASE_MS = 120_000;
const RETRY_MAX_MS = 300_000;

export const META_CAPI_OPPORTUNISTIC_DRAIN_INTERVAL_MS = 60_000;

const schemaInitializations = new WeakMap<object, Promise<void>>();
let nextOpportunisticDrainAt = 0;

const nowIso = (now = Date.now()) => new Date(now).toISOString();
const integer = (value: unknown) =>
  Number.isInteger(Number(value)) ? Number(value) : null;
const id = () => crypto.randomUUID();

export async function ensureMetaCapiOutboxSchema(db: D1Database) {
  const key = db as unknown as object;
  let initialization = schemaInitializations.get(key);

  if (!initialization) {
    initialization = db
      .batch(META_CAPI_DATABASE_SQL.map((statement) => db.prepare(statement)))
      .then(() => undefined);

    schemaInitializations.set(key, initialization);
    initialization.catch(() => schemaInitializations.delete(key));
  }

  return initialization;
}

export function shouldRunMetaCapiOpportunisticDrain(now = Date.now()) {
  if (now < nextOpportunisticDrainAt) return false;
  nextOpportunisticDrainAt = now + META_CAPI_OPPORTUNISTIC_DRAIN_INTERVAL_MS;
  return true;
}

export function resetMetaCapiOutboxRuntimeForTests() {
  nextOpportunisticDrainAt = 0;
}

function cleanExpiredJobs(db: D1Database) {
  return db
    .prepare(`DELETE FROM meta_capi_jobs
      WHERE (status='completed' AND completed_at < datetime('now','-7 days'))
         OR (status='failed' AND attempts >= ? AND updated_at < datetime('now','-30 days'))`)
    .bind(MAX_ATTEMPTS)
    .run();
}

export function prepareMetaCapiJobInsert(db: D1Database, job: NewMetaCapiJob) {
  return db
    .prepare(`INSERT OR IGNORE INTO meta_capi_jobs (
      id,
      dedupe_key,
      event_id,
      event_name,
      event_time,
      order_id,
      order_number,
      value_crc,
      chatwoot_account_id,
      chatwoot_conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id(),
      job.dedupeKey,
      job.eventId,
      job.eventName,
      job.eventTime,
      job.orderId ?? null,
      job.orderNumber ?? null,
      job.valueCrc ?? null,
      job.accountId,
      job.conversationId,
    );
}

export async function enqueueMetaCapiJob(db: D1Database, job: NewMetaCapiJob) {
  const result = await prepareMetaCapiJobInsert(db, job).run();
  return { created: result.meta.changes > 0 };
}

export function prepareMetaCapiPurchaseInsertForOrder(
  db: D1Database,
  input: {
    orderId: string;
    orderNumber: string;
    eventTime: string;
    valueCrc: number;
  },
) {
  const dedupeKey = `purchase:${input.orderId}`;
  const eventId = `np-purchase-${input.orderId}`;

  return db
    .prepare(`INSERT OR IGNORE INTO meta_capi_jobs (
      id,
      dedupe_key,
      event_id,
      event_name,
      event_time,
      order_id,
      order_number,
      value_crc,
      chatwoot_account_id,
      chatwoot_conversation_id
    )
    SELECT
      ?,
      ?,
      ?,
      'Purchase',
      ?,
      ?,
      ?,
      ?,
      link.chatwoot_account_id,
      link.chatwoot_conversation_id
    FROM chatwoot_conversation_order_links link
    WHERE link.order_id=?
    ORDER BY
      CASE WHEN link.link_role='PRIMARY' THEN 0 ELSE 1 END,
      link.chatwoot_account_id ASC,
      link.chatwoot_conversation_id ASC
    LIMIT 1`)
    .bind(
      id(),
      dedupeKey,
      eventId,
      input.eventTime,
      input.orderId,
      input.orderNumber,
      input.valueCrc,
      input.orderId,
    );
}

function rowToJob(row: Record<string, unknown> | null): MetaCapiJob | null {
  if (!row) return null;

  const accountId = integer(row.chatwoot_account_id);
  const conversationId = integer(row.chatwoot_conversation_id);
  const attempts = integer(row.attempts);

  if (
    !accountId ||
    !conversationId ||
    attempts === null ||
    typeof row.id !== "string" ||
    typeof row.dedupe_key !== "string" ||
    typeof row.event_id !== "string" ||
    typeof row.event_name !== "string" ||
    typeof row.event_time !== "string"
  ) {
    return null;
  }

  if (row.event_name !== "LeadSubmitted" && row.event_name !== "Purchase") {
    return null;
  }

  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    eventId: row.event_id,
    eventName: row.event_name,
    eventTime: row.event_time,
    orderId: typeof row.order_id === "string" ? row.order_id : null,
    orderNumber: typeof row.order_number === "string" ? row.order_number : null,
    valueCrc: row.value_crc == null ? null : Number(row.value_crc),
    accountId,
    conversationId,
    status: row.status as MetaCapiJobStatus,
    attempts,
    leaseToken: typeof row.lease_token === "string" ? row.lease_token : null,
  };
}

export async function claimNextMetaCapiJob(
  db: D1Database,
  now = Date.now(),
): Promise<MetaCapiJob | null> {
  const at = nowIso(now);

  const candidate = await db
    .prepare(`SELECT * FROM meta_capi_jobs
      WHERE attempts < ? AND (
        (status IN ('pending','failed') AND next_attempt_at <= ?)
        OR (status='processing' AND lease_expires_at <= ?)
      )
      ORDER BY created_at ASC, id ASC
      LIMIT 1`)
    .bind(MAX_ATTEMPTS, at, at)
    .first<Record<string, unknown>>();

  const job = rowToJob(candidate);
  if (!job) return null;

  const leaseToken = id();
  const leaseExpiresAt = nowIso(now + LEASE_MS);

  const result = await db
    .prepare(`UPDATE meta_capi_jobs
      SET status='processing',
          attempts=attempts+1,
          lease_token=?,
          lease_expires_at=?,
          updated_at=?
      WHERE id=? AND attempts < ? AND (
        (status IN ('pending','failed') AND next_attempt_at <= ?)
        OR (status='processing' AND lease_expires_at <= ?)
      )`)
    .bind(
      leaseToken,
      leaseExpiresAt,
      at,
      job.id,
      MAX_ATTEMPTS,
      at,
      at,
    )
    .run();

  if (!result.meta.changes) return null;

  return {
    ...job,
    status: "processing",
    attempts: job.attempts + 1,
    leaseToken,
  };
}

export async function completeMetaCapiJob(
  db: D1Database,
  job: MetaCapiJob,
  now = Date.now(),
) {
  await db
    .prepare(`UPDATE meta_capi_jobs
      SET status='completed',
          completed_at=?,
          updated_at=?,
          lease_token=NULL,
          lease_expires_at=NULL,
          last_error=NULL
      WHERE id=? AND status='processing' AND lease_token=?`)
    .bind(nowIso(now), nowIso(now), job.id, job.leaseToken)
    .run();
}

function sanitizedErrorCode(error: unknown) {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "META_CAPI_JOB_PROCESSING_FAILED";

  return /^[A-Z0-9_]{1,96}$/.test(code)
    ? code
    : "META_CAPI_JOB_PROCESSING_FAILED";
}

export async function failMetaCapiJob(
  db: D1Database,
  job: MetaCapiJob,
  error: unknown,
  now = Date.now(),
) {
  const delay = Math.min(
    RETRY_MAX_MS,
    1_000 * 2 ** Math.min(job.attempts, 8),
  );

  await db
    .prepare(`UPDATE meta_capi_jobs
      SET status='failed',
          last_error=?,
          next_attempt_at=?,
          updated_at=?,
          lease_token=NULL,
          lease_expires_at=NULL
      WHERE id=? AND status='processing' AND lease_token=?`)
    .bind(
      sanitizedErrorCode(error),
      nowIso(now + delay),
      nowIso(now),
      job.id,
      job.leaseToken,
    )
    .run();
}

function terminalErrorCode(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "terminal" in error &&
    (error as { terminal?: unknown }).terminal === true
  ) {
    return sanitizedErrorCode(error);
  }

  return null;
}

async function skipMetaCapiJob(
  db: D1Database,
  job: MetaCapiJob,
  code: string,
  now = Date.now(),
) {
  await db
    .prepare(`UPDATE meta_capi_jobs
      SET status='completed',
          completed_at=?,
          updated_at=?,
          last_error=?,
          lease_token=NULL,
          lease_expires_at=NULL
      WHERE id=? AND status='processing' AND lease_token=?`)
    .bind(
      nowIso(now),
      nowIso(now),
      code,
      job.id,
      job.leaseToken,
    )
    .run();
}

export async function processNextMetaCapiJob(
  db: D1Database,
  processor: (job: MetaCapiJob) => Promise<void>,
  now = Date.now(),
) {
  const job = await claimNextMetaCapiJob(db, now);
  if (!job) return { processed: false };

  try {
    await processor(job);
    await completeMetaCapiJob(db, job);
    return { processed: true, completed: true, jobId: job.id };
  } catch (error) {
    const terminalCode = terminalErrorCode(error);

    if (terminalCode) {
      await skipMetaCapiJob(
        db,
        job,
        terminalCode,
        now,
      );

      return {
        processed: true,
        completed: true,
        skipped: true,
        jobId: job.id,
      };
    }

    await failMetaCapiJob(db, job, error, now);
    return { processed: true, completed: false, jobId: job.id };
  }
}

export async function drainMetaCapiJobs(
  db: D1Database,
  processor: (job: MetaCapiJob) => Promise<void>,
  limit = 3,
) {
  await ensureMetaCapiOutboxSchema(db);
  await cleanExpiredJobs(db);

  let processed = 0;

  for (let index = 0; index < limit; index++) {
    const result = await processNextMetaCapiJob(db, processor);
    if (!result.processed) break;
    processed++;
  }

  return { processed };
}
