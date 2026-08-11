export async function createInventoryBackup(db: D1Database, label: string) {
  const job = await db.prepare(`INSERT INTO import_jobs (
    file_name,strategy,status,total_rows,processed_rows,created_at,completed_at
  ) SELECT ?,'backup','completed',COUNT(*),COUNT(*),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM products RETURNING id`).bind(label.slice(0, 220)).first<{ id: number }>();
  if (!job) throw new Error("No se pudo crear el respaldo de seguridad.");
  await createBackupForImport(db, Number(job.id));
  return Number(job.id);
}

export async function createBackupForImport(db: D1Database, importId: number) {
  await db.prepare(`INSERT INTO import_backups (import_id,product_count,created_at)
    SELECT ?,(SELECT COUNT(*) FROM products),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE NOT EXISTS (SELECT 1 FROM import_backups WHERE import_id=?)`)
    .bind(importId, importId).run();
  const backup = await db.prepare("SELECT id FROM import_backups WHERE import_id=? ORDER BY id LIMIT 1")
    .bind(importId).first<{ id: number }>();
  if (!backup) throw new Error("No se pudo crear el respaldo previo.");
  await db.prepare(`INSERT INTO import_backup_products (
    backup_id,original_id,name,normalized_name,code,purchase_price_usd_cents,weight_milli_lb,
    quantity_available,minimum_stock,minimum_stock_enabled,restock_purchased_at,zero_stock_since,version,created_at,updated_at
  ) SELECT ?,id,name,normalized_name,code,purchase_price_usd_cents,weight_milli_lb,
    quantity_available,minimum_stock,minimum_stock_enabled,restock_purchased_at,zero_stock_since,version,created_at,updated_at FROM products
    WHERE NOT EXISTS (SELECT 1 FROM import_backup_products WHERE backup_id=? LIMIT 1)`)
    .bind(backup.id, backup.id).run();
  return Number(backup.id);
}
