import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { productDeletionJobFromRow } from "@/lib/deletion-jobs";
import { createInventoryBackup } from "@/lib/inventory-backups";

export async function GET() {
  try {
    await ensureDatabase();
    const result = await getD1().prepare("SELECT * FROM product_deletion_jobs ORDER BY id DESC LIMIT 10").all<Record<string, unknown>>();
    return Response.json({ jobs: result.results.map(productDeletionJobFromRow) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST() {
  let jobId: number | null = null;
  try {
    await ensureDatabase();
    const db = getD1();
    const active = await db.prepare("SELECT * FROM product_deletion_jobs WHERE status IN ('queued','running') ORDER BY id LIMIT 1")
      .first<Record<string, unknown>>();
    if (active) return Response.json({ job: productDeletionJobFromRow(active), alreadyRunning: true });

    const activeImport = await db.prepare("SELECT id FROM import_jobs WHERE status IN ('queued','running') AND strategy IN ('update','skip') ORDER BY id LIMIT 1")
      .first<{ id: number }>();
    if (activeImport) {
      return Response.json({ error: "Hay una importación activa. Esperá a que termine antes de vaciar los productos." }, { status: 409 });
    }

    const job = await db.prepare(`INSERT INTO product_deletion_jobs (
      status,total_products,processed_products,deleted_products,preserved_products,created_at
    ) VALUES ('queued',0,0,0,0,strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING *`)
      .first<Record<string, unknown>>();
    if (!job) throw new Error("No se pudo iniciar la eliminación.");
    jobId = Number(job.id);

    await db.prepare(`INSERT INTO product_deletion_rows (deletion_id,product_id,processed)
      SELECT ?,id,0 FROM products`).bind(jobId).run();
    const count = await db.prepare("SELECT COUNT(*) AS count FROM product_deletion_rows WHERE deletion_id=?")
      .bind(jobId).first<{ count: number }>();
    const total = Number(count?.count ?? 0);
    const backupImportId = total > 0
      ? await createInventoryBackup(db, "Respaldo antes de borrar todos los productos")
      : null;
    await db.prepare(`UPDATE product_deletion_jobs SET total_products=?,backup_import_id=?,
      status=CASE WHEN ?=0 THEN 'completed' ELSE 'queued' END,
      completed_at=CASE WHEN ?=0 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END
      WHERE id=?`).bind(total, backupImportId, total, total, jobId).run();

    const current = await db.prepare("SELECT * FROM product_deletion_jobs WHERE id=?").bind(jobId).first<Record<string, unknown>>();
    return Response.json({ job: productDeletionJobFromRow(current!) }, { status: 201 });
  } catch (error) {
    if (jobId) {
      try {
        await getD1().prepare("UPDATE product_deletion_jobs SET status='failed',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .bind(jobId).run();
      } catch { /* Preserve the original error. */ }
    }
    return errorResponse(error);
  }
}
