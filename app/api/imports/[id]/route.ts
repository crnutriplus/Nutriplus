import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { importJobFromRow } from "@/lib/import-jobs";
import { productFromRow } from "@/lib/pricing";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await context.params).id);
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Importación inválida." }, { status: 400 });
    await ensureDatabase();
    const db = getD1();
    const row = await db.prepare("SELECT * FROM import_jobs WHERE id=? LIMIT 1").bind(id).first<Record<string, unknown>>();
    if (!row) return Response.json({ error: "No se encontró la importación." }, { status: 404 });
    const changed = await db.prepare(`SELECT r.outcome,p.* FROM import_job_rows r
      JOIN products p ON p.normalized_name=r.normalized_name
      WHERE r.import_id=? AND r.outcome IN ('imported','updated') ORDER BY r.id LIMIT 1000`).bind(id).all<Record<string, unknown>>();
    return Response.json({
      job: importJobFromRow(row),
      changedProducts: changed.results.map((item) => ({ outcome: item.outcome, product: productFromRow(item) })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
