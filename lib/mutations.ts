type MutationResult = { body: Record<string, unknown>; status?: number };

function cleanMutationId(request: Request, payload: Record<string, unknown>) {
  const raw = request.headers.get("x-mutation-id") || (typeof payload.mutationId === "string" ? payload.mutationId : "");
  const id = raw.trim();
  return /^[A-Za-z0-9:_-]{8,160}$/.test(id) ? id : null;
}

export async function runIdempotentMutation(
  db: D1Database,
  request: Request,
  payload: Record<string, unknown>,
  action: () => Promise<MutationResult>,
) {
  const mutationId = cleanMutationId(request, payload);
  if (!mutationId) return action();

  const existing = await db.prepare("SELECT status,response_json FROM mutation_receipts WHERE id=? LIMIT 1")
    .bind(mutationId).first<{ status: string; response_json: string | null }>();
  if (existing?.status === "completed" && existing.response_json) {
    return { body: JSON.parse(existing.response_json) as Record<string, unknown>, status: 200 };
  }
  if (existing?.status === "pending") {
    throw new Error("La misma operación ya se está procesando. Intentá nuevamente en un momento.");
  }

  await db.prepare("INSERT INTO mutation_receipts (id,status,created_at) VALUES (?,'pending',strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
    .bind(mutationId).run();
  try {
    const result = await action();
    await db.prepare("UPDATE mutation_receipts SET status='completed',response_json=?,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
      .bind(JSON.stringify(result.body), mutationId).run();
    return result;
  } catch (error) {
    await db.prepare("DELETE FROM mutation_receipts WHERE id=? AND status='pending'").bind(mutationId).run().catch(() => undefined);
    throw error;
  }
}
