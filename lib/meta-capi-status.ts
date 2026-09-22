export type MetaCapiStatusRow = {
  id: string;
  eventName: string;
  eventId: string;
  orderNumber: string | null;
  valueCrc: number | null;
  chatwootAccountId: number;
  chatwootConversationId: number;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export function parseMetaCapiOrderNumber(value: string | null) {
  const orderNumber = value?.trim().toUpperCase() ?? "";
  if (!/^NP-\d{6}$/.test(orderNumber)) {
    throw new Error("orderNumber debe tener formato NP-000000.");
  }
  return orderNumber;
}

export async function loadMetaCapiStatus(
  db: D1Database,
  orderNumber: string,
): Promise<MetaCapiStatusRow[]> {
  const result = await db.prepare(`SELECT
    id, event_name, event_id, order_number, value_crc,
    chatwoot_account_id, chatwoot_conversation_id,
    status, attempts, last_error,
    created_at, updated_at, completed_at
    FROM meta_capi_jobs
    WHERE order_number = ?
    ORDER BY created_at DESC
    LIMIT 20`)
    .bind(orderNumber)
    .all<Record<string, unknown>>();

  return result.results.map((row) => ({
    id: String(row.id),
    eventName: String(row.event_name),
    eventId: String(row.event_id),
    orderNumber: row.order_number == null ? null : String(row.order_number),
    valueCrc: row.value_crc == null ? null : Number(row.value_crc),
    chatwootAccountId: Number(row.chatwoot_account_id),
    chatwootConversationId: Number(row.chatwoot_conversation_id),
    status: String(row.status),
    attempts: Number(row.attempts),
    lastError: row.last_error == null ? null : String(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
  }));
}
