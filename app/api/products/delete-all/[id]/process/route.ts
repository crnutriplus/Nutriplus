import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { productDeletionJobFromRow } from "@/lib/deletion-jobs";

type DeletionRow = { id: number; product_id: number };

function claimToken() {
  return globalThis.crypto?.randomUUID?.() || `delete-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function finishIfReady(db: D1Database, id: number) {
  const remaining = await db.prepare("SELECT COUNT(*) AS count FROM product_deletion_rows WHERE deletion_id=? AND processed<>1")
    .bind(id).first<{ count: number }>();
  if (Number(remaining?.count ?? 0) === 0) {
    await db.prepare(`UPDATE product_deletion_jobs SET status='completed',
      processed_products=(SELECT COUNT(*) FROM product_deletion_rows WHERE deletion_id=? AND processed=1),
      completed_at=COALESCE(completed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?`)
      .bind(id, id).run();
  }
  return db.prepare("SELECT * FROM product_deletion_jobs WHERE id=?").bind(id).first<Record<string, unknown>>();
}

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  let id = 0;
  let token = "";
  try {
    id = Number((await context.params).id);
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Eliminación inválida." }, { status: 400 });
    await ensureDatabase();
    const db = getD1();
    const job = await db.prepare("SELECT * FROM product_deletion_jobs WHERE id=? LIMIT 1").bind(id).first<Record<string, unknown>>();
    if (!job) return Response.json({ error: "No se encontró la eliminación." }, { status: 404 });
    if (job.status === "completed" || job.status === "failed") return Response.json({ job: productDeletionJobFromRow(job) });

    const activeImport = await db.prepare("SELECT id FROM import_jobs WHERE status='running' AND strategy IN ('update','skip') ORDER BY id LIMIT 1")
      .first<{ id: number }>();
    if (activeImport) return Response.json({ job: productDeletionJobFromRow(job), waitingForImport: true });

    token = claimToken();
    const claimed = await db.prepare(`UPDATE product_deletion_rows SET
      processed=2,claim_token=?,claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id IN (
        SELECT id FROM product_deletion_rows
        WHERE deletion_id=? AND (
          processed=0 OR (processed=2 AND (claimed_at IS NULL OR julianday(claimed_at)<=julianday('now','-30 seconds')))
        ) ORDER BY id LIMIT 40
      ) AND deletion_id=? AND (
        processed=0 OR (processed=2 AND (claimed_at IS NULL OR julianday(claimed_at)<=julianday('now','-30 seconds')))
      ) RETURNING id,product_id`)
      .bind(token, id, id).all<DeletionRow>();
    const rows = claimed.results;
    if (!rows.length) {
      const current = await finishIfReady(db, id);
      return Response.json({ job: productDeletionJobFromRow(current || job), busy: current?.status !== "completed" });
    }

    const productIds = rows.map((row) => Number(row.product_id));
    const serializedProductIds = JSON.stringify(productIds);
    await db.prepare(`DELETE FROM products
      WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
      AND julianday(replace(replace(updated_at,'T',' '),'Z','')) <= julianday(replace(replace(?,'T',' '),'Z',''))`)
      .bind(serializedProductIds, String(job.created_at)).run();
    const survivors = await db.prepare(`SELECT id FROM products
      WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`)
      .bind(serializedProductIds).all<{ id: number }>();
    const survivorIds = new Set(survivors.results.map((row) => Number(row.id)));
    const preserved = productIds.filter((productId) => survivorIds.has(productId)).length;
    const deleted = rows.length - preserved;
    const rowIds = rows.map((row) => Number(row.id));
    const serializedRowIds = JSON.stringify(rowIds);
    await db.batch([
      db.prepare(`UPDATE product_deletion_rows SET
        processed=1,claim_token=NULL,claimed_at=NULL,
        outcome=CASE WHEN EXISTS (SELECT 1 FROM products p WHERE p.id=product_deletion_rows.product_id) THEN 'preserved' ELSE 'deleted' END
        WHERE deletion_id=? AND claim_token=? AND processed=2
        AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`).bind(id, token, serializedRowIds),
      db.prepare(`UPDATE product_deletion_jobs SET
        status=CASE WHEN NOT EXISTS (SELECT 1 FROM product_deletion_rows WHERE deletion_id=? AND processed<>1) THEN 'completed' ELSE 'running' END,
        processed_products=(SELECT COUNT(*) FROM product_deletion_rows WHERE deletion_id=? AND processed=1),
        deleted_products=deleted_products+?,preserved_products=preserved_products+?,
        completed_at=CASE WHEN NOT EXISTS (SELECT 1 FROM product_deletion_rows WHERE deletion_id=? AND processed<>1)
          THEN COALESCE(completed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE NULL END
        WHERE id=? AND status IN ('queued','running')`).bind(id, id, deleted, preserved, id, id),
    ]);

    const current = await db.prepare("SELECT * FROM product_deletion_jobs WHERE id=?").bind(id).first<Record<string, unknown>>();
    return Response.json({ job: productDeletionJobFromRow(current!) });
  } catch (error) {
    try {
      if (id > 0 && token) {
        await getD1().prepare("UPDATE product_deletion_rows SET processed=0,claim_token=NULL,claimed_at=NULL WHERE deletion_id=? AND claim_token=? AND processed=2")
          .bind(id, token).run();
      }
      if (id > 0) {
        await getD1().prepare("UPDATE product_deletion_jobs SET status='failed',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .bind(id).run();
      }
    } catch { /* Preserve the original error. */ }
    return errorResponse(error);
  }
}
