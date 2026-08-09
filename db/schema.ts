import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  exchangeRateCrc: integer("exchange_rate_crc").notNull().default(520),
  courierRateUsdCents: integer("courier_rate_usd_cents").notNull().default(550),
  extraWeightMilliLb: integer("extra_weight_milli_lb").notNull().default(100),
  deliveryCrc: integer("delivery_crc").notNull().default(1000),
  correosCrc: integer("correos_crc").notNull().default(500),
  gamProfitCrc: integer("gam_profit_crc").notNull().default(5000),
  puertoProfitCrc: integer("puerto_profit_crc").notNull().default(4000),
  roundingCrc: integer("rounding_crc").notNull().default(100),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  code: text("code"),
  purchasePriceUsdCents: integer("purchase_price_usd_cents"),
  weightMilliLb: integer("weight_milli_lb"),
  quantityAvailable: integer("quantity_available").notNull().default(0),
  minimumStock: integer("minimum_stock").notNull().default(0),
  minimumStockEnabled: integer("minimum_stock_enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("products_normalized_name_unique").on(table.normalizedName),
  uniqueIndex("products_code_unique").on(table.code),
]);

export const importJobs = sqliteTable("import_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fileName: text("file_name").notNull(),
  sheetName: text("sheet_name"),
  strategy: text("strategy").notNull().default("update"),
  status: text("status").notNull().default("queued"),
  totalRows: integer("total_rows").notNull().default(0),
  processedRows: integer("processed_rows").notNull().default(0),
  importedCount: integer("imported_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  conflictCount: integer("conflict_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  incompleteCount: integer("incomplete_count").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
  restoredAt: text("restored_at"),
});

export const importJobRows = sqliteTable("import_job_rows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  importId: integer("import_id").notNull(),
  rowNumber: integer("row_number").notNull(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  code: text("code"),
  purchasePriceUsdCents: integer("purchase_price_usd_cents"),
  weightMilliLb: integer("weight_milli_lb"),
  quantityAvailable: integer("quantity_available"),
  minimumStock: integer("minimum_stock"),
  minimumStockEnabled: integer("minimum_stock_enabled", { mode: "boolean" }),
  hasCode: integer("has_code", { mode: "boolean" }).notNull().default(false),
  hasPurchasePrice: integer("has_purchase_price", { mode: "boolean" }).notNull().default(false),
  hasWeight: integer("has_weight", { mode: "boolean" }).notNull().default(false),
  hasQuantity: integer("has_quantity", { mode: "boolean" }).notNull().default(false),
  hasMinimumStock: integer("has_minimum_stock", { mode: "boolean" }).notNull().default(false),
  processed: integer("processed", { mode: "boolean" }).notNull().default(false),
  outcome: text("outcome"),
  message: text("message"),
}, (table) => [index("import_job_rows_pending_idx").on(table.importId, table.processed, table.id)]);

export const importBackups = sqliteTable("import_backups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  importId: integer("import_id").notNull(),
  productCount: integer("product_count").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const importBackupProducts = sqliteTable("import_backup_products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  backupId: integer("backup_id").notNull(),
  originalId: integer("original_id").notNull(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  code: text("code"),
  purchasePriceUsdCents: integer("purchase_price_usd_cents"),
  weightMilliLb: integer("weight_milli_lb"),
  quantityAvailable: integer("quantity_available").notNull().default(0),
  minimumStock: integer("minimum_stock").notNull().default(0),
  minimumStockEnabled: integer("minimum_stock_enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("import_backup_products_backup_idx").on(table.backupId, table.originalId)]);

export const productDeletionJobs = sqliteTable("product_deletion_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  status: text("status").notNull().default("queued"),
  totalProducts: integer("total_products").notNull().default(0),
  processedProducts: integer("processed_products").notNull().default(0),
  deletedProducts: integer("deleted_products").notNull().default(0),
  preservedProducts: integer("preserved_products").notNull().default(0),
  backupImportId: integer("backup_import_id"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
});

export const productDeletionRows = sqliteTable("product_deletion_rows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deletionId: integer("deletion_id").notNull(),
  productId: integer("product_id").notNull(),
  processed: integer("processed", { mode: "boolean" }).notNull().default(false),
  outcome: text("outcome"),
}, (table) => [
  index("product_deletion_rows_pending_idx").on(table.deletionId, table.processed, table.id),
]);
