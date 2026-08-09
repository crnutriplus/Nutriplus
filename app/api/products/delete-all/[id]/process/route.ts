import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { productDeletionJobFromRow } from "@/lib/deletion-jobs";

type DeletionRow = { id: number; product_id: number };

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  let id = 0;
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

    const pending = await db.prepare("SELECT id,product_id FROM product_deletion_rows WHERE deletion_id=? AND processed=0 ORDER BY id LIMIT 40")
      .bind(id).all<DeletionRow>();
    const rows = pending.results;
    if (!rows.length) {
      await db.prepare("UPDATE product_deletion_jobs SET status='completed',processed_products=total_products,completed_at=COALESCE(completed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?")
        .bind(id).run();
      const finished = await db.prepare("SELECT * FROM product_deletion_jobs WHERE id=?").bind(id).first<Record<string, unknown>>();
      return Response.json({ job: productDeletionJobFromRow(finished!) });
    }

    const productIds = rows.map((row) => Number(row.product_id));
    const placeholders = productIds.map(() => "?").join(",");
    await db.prepare(`DELETE FROM products WHERE id IN (${placeholders}) AND updated_at<=?`)
      .bind(...productIds, String(job.created_at)).run();
    const survivors = await db.prepare(`SELECT id FROM products WHERE id IN (${placeholders})`)
      .bind(...productIds).all<{ id: number }>();
    const survivorIds = new Set(survivors.results.map((row) => Number(row.id)));
    const preserved = productIds.filter((productId) => survivorIds.has(productId)).length;
    const deleted = rows.length - preserved;
    const rowIds = rows.map((row) => Number(row.id));
    const rowPlaceholders = rowIds.map(() => "?").join(",");
    await db.batch([
      db.prepare(`UPDATE product_deletion_rows SET processed=1,
        outcome=CASE WHEN EXISTS (SELECT 1 FROM products p WHERE p.id=product_deletion_rows.product_id) THEN 'preserved' ELSE 'deleted' END
        WHERE deletion_id=? AND id IN (${rowPlaceholders})`).bind(id, ...rowIds),
      db.prepare(`UPDATE product_deletion_jobs SET
        status=CASE WHEN processed_products+? >= total_products THEN 'completed' ELSE 'running' END,
        processed_products=MIN(total_products,processed_products+?),
        deleted_products=deleted_products+?,preserved_products=preserved_products+?,
        completed_at=CASE WHEN processed_products+? >= total_products THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE completed_at END
        WHERE id=?`).bind(rows.length, rows.length, deleted, preserved, rows.length, id),
    ]);

    const current = await db.prepare("SELECT * FROM product_deletion_jobs WHERE id=?").bind(id).first<Record<string, unknown>>();
    return Response.json({ job: productDeletionJobFromRow(current!) });
  } catch (error) {
    if (id > 0) {
      try {
        await getD1().prepare("UPDATE product_deletion_jobs SET status='failed',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .bind(id).run();
      } catch { /* Preserve the original error. */ }
    }
    return errorResponse(error);
  }
}
