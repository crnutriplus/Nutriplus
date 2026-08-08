import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await context.params).id);
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Respaldo inválido." }, { status: 400 });
    await ensureDatabase();
    const db = getD1();
    const target = await db.prepare(`SELECT j.file_name,b.id AS backup_id,b.product_count
      FROM import_jobs j JOIN import_backups b ON b.import_id=j.id WHERE j.id=? ORDER BY b.id LIMIT 1`).bind(id).first<{ file_name: string; backup_id: number; product_count: number }>();
    if (!target) return Response.json({ error: "No se encontró el respaldo de esa importación." }, { status: 404 });

    const safetyJob = await db.prepare(`INSERT INTO import_jobs (
      file_name,strategy,status,total_rows,processed_rows,created_at,completed_at
    ) VALUES (?,'backup','completed',0,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING id`)
      .bind(`Respaldo antes de restaurar: ${target.file_name}`.slice(0, 220)).first<{ id: number }>();
    if (!safetyJob) throw new Error("No se pudo crear el respaldo de seguridad.");
    const safetyBackup = await db.prepare("INSERT INTO import_backups (import_id,product_count,created_at) SELECT ?,COUNT(*),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM products RETURNING id").bind(safetyJob.id).first<{ id: number }>();
    if (!safetyBackup) throw new Error("No se pudo crear el respaldo de seguridad.");
    await db.prepare(`INSERT INTO import_backup_products (
      backup_id,original_id,name,normalized_name,code,purchase_price_usd_cents,weight_milli_lb,
      quantity_available,minimum_stock,minimum_stock_enabled,created_at,updated_at
    ) SELECT ?,id,name,normalized_name,code,purchase_price_usd_cents,weight_milli_lb,
      quantity_available,minimum_stock,minimum_stock_enabled,created_at,updated_at FROM products`).bind(safetyBackup.id).run();

    await db.batch([
      db.prepare("DELETE FROM products"),
      db.prepare(`INSERT INTO products (
        id,name,normalized_name,code,purchase_price_usd_cents,weight_milli_lb,quantity_available,
        minimum_stock,minimum_stock_enabled,created_at,updated_at
      ) SELECT original_id,name,normalized_name,code,purchase_price_usd_cents,weight_milli_lb,quantity_available,
        minimum_stock,minimum_stock_enabled,created_at,updated_at FROM import_backup_products WHERE backup_id=? ORDER BY original_id`).bind(target.backup_id),
      db.prepare("DELETE FROM sqlite_sequence WHERE name='products'"),
      db.prepare("INSERT INTO sqlite_sequence(name,seq) SELECT 'products',COALESCE(MAX(id),0) FROM products"),
      db.prepare("UPDATE import_jobs SET restored_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(id),
    ]);
    const count = await db.prepare("SELECT COUNT(*) AS count FROM products").first<{ count: number }>();
    return Response.json({ restored: true, products: Number(count?.count ?? target.product_count), safetyJobId: safetyJob.id });
  } catch (error) {
    return errorResponse(error);
  }
}
