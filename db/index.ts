import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

let initialization: Promise<void> | null = null;

export function getD1() {
  if (!globalThis.__NUTRIPLUS_DB__) throw new Error("La base de datos no está disponible.");
  return globalThis.__NUTRIPLUS_DB__;
}

export function getDb() {
  return drizzle(getD1(), { schema });
}

export async function ensureDatabase() {
  if (!initialization) {
    initialization = (async () => {
      const db = getD1();
      await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS settings (
          id INTEGER PRIMARY KEY NOT NULL,
          exchange_rate_crc INTEGER NOT NULL DEFAULT 520,
          courier_rate_usd_cents INTEGER NOT NULL DEFAULT 550,
          extra_weight_milli_lb INTEGER NOT NULL DEFAULT 100,
          delivery_crc INTEGER NOT NULL DEFAULT 1000,
          correos_crc INTEGER NOT NULL DEFAULT 500,
          gam_profit_crc INTEGER NOT NULL DEFAULT 5000,
          puerto_profit_crc INTEGER NOT NULL DEFAULT 4000,
          rounding_crc INTEGER NOT NULL DEFAULT 100,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          code TEXT,
          purchase_price_usd_cents INTEGER,
          weight_milli_lb INTEGER,
          quantity_available INTEGER NOT NULL DEFAULT 0,
          minimum_stock INTEGER NOT NULL DEFAULT 0,
          minimum_stock_enabled INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS products_normalized_name_unique ON products (normalized_name)"),
        db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS products_code_unique ON products (code)"),
        db.prepare(`INSERT OR IGNORE INTO settings (
          id, exchange_rate_crc, courier_rate_usd_cents, extra_weight_milli_lb,
          delivery_crc, correos_crc, gam_profit_crc, puerto_profit_crc, rounding_crc
        ) VALUES (1, 520, 550, 100, 1000, 500, 5000, 4000, 100)`),
      ]);

      const productColumns = await db.prepare("PRAGMA table_info(products)").all<{ name: string }>();
      const columnNames = new Set(productColumns.results.map((column) => column.name));
      const additions = [];
      if (!columnNames.has("quantity_available")) additions.push(db.prepare("ALTER TABLE products ADD COLUMN quantity_available INTEGER NOT NULL DEFAULT 0"));
      if (!columnNames.has("minimum_stock")) additions.push(db.prepare("ALTER TABLE products ADD COLUMN minimum_stock INTEGER NOT NULL DEFAULT 0"));
      if (!columnNames.has("minimum_stock_enabled")) additions.push(db.prepare("ALTER TABLE products ADD COLUMN minimum_stock_enabled INTEGER NOT NULL DEFAULT 0"));
      if (additions.length) await db.batch(additions);

      await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS import_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          file_name TEXT NOT NULL,
          sheet_name TEXT,
          strategy TEXT NOT NULL DEFAULT 'update',
          status TEXT NOT NULL DEFAULT 'queued',
          total_rows INTEGER NOT NULL DEFAULT 0,
          processed_rows INTEGER NOT NULL DEFAULT 0,
          imported_count INTEGER NOT NULL DEFAULT 0,
          updated_count INTEGER NOT NULL DEFAULT 0,
          skipped_count INTEGER NOT NULL DEFAULT 0,
          conflict_count INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0,
          incomplete_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TEXT,
          restored_at TEXT
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS import_job_rows (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          import_id INTEGER NOT NULL,
          row_number INTEGER NOT NULL,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          code TEXT,
          purchase_price_usd_cents INTEGER,
          weight_milli_lb INTEGER,
          quantity_available INTEGER,
          minimum_stock INTEGER,
          minimum_stock_enabled INTEGER,
          has_code INTEGER NOT NULL DEFAULT 0,
          has_purchase_price INTEGER NOT NULL DEFAULT 0,
          has_weight INTEGER NOT NULL DEFAULT 0,
          has_quantity INTEGER NOT NULL DEFAULT 0,
          has_minimum_stock INTEGER NOT NULL DEFAULT 0,
          processed INTEGER NOT NULL DEFAULT 0,
          outcome TEXT,
          message TEXT
        )`),
        db.prepare("CREATE INDEX IF NOT EXISTS import_job_rows_pending_idx ON import_job_rows (import_id, processed, id)"),
        db.prepare(`CREATE TABLE IF NOT EXISTS import_backups (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          import_id INTEGER NOT NULL,
          product_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS import_backup_products (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          backup_id INTEGER NOT NULL,
          original_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          code TEXT,
          purchase_price_usd_cents INTEGER,
          weight_milli_lb INTEGER,
          quantity_available INTEGER NOT NULL DEFAULT 0,
          minimum_stock INTEGER NOT NULL DEFAULT 0,
          minimum_stock_enabled INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`),
        db.prepare("CREATE INDEX IF NOT EXISTS import_backup_products_backup_idx ON import_backup_products (backup_id, original_id)"),
      ]);
    })().catch((error) => { initialization = null; throw error; });
  }
  await initialization;
}
