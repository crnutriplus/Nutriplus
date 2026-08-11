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

  await db.prepare(`DELETE FROM mutation_receipts WHERE id=? AND status='pending'
    AND julianday(replace(replace(created_at,'T',' '),'Z',''))<=julianday('now','-5 minutes')`)
    .bind(mutationId).run();
  const claim = await db.prepare("INSERT OR IGNORE INTO mutation_receipts (id,status,created_at) VALUES (?,'pending',strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
    .bind(mutationId).run();
  if (Number(claim.meta?.changes ?? 0) === 0) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const existing = await db.prepare("SELECT status,response_json FROM mutation_receipts WHERE id=? LIMIT 1")
        .bind(mutationId).first<{ status: string; response_json: string | null }>();
      if (existing?.status === "completed" && existing.response_json) {
        return { body: JSON.parse(existing.response_json) as Record<string, unknown>, status: 200 };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("La operación sigue procesándose. Se volverá a intentar automáticamente.");
  }
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
