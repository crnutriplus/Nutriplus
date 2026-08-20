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
          restock_purchased_at TEXT,
          zero_stock_since TEXT,
          version INTEGER NOT NULL DEFAULT 1,
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
      if (!columnNames.has("restock_purchased_at")) additions.push(db.prepare("ALTER TABLE products ADD COLUMN restock_purchased_at TEXT"));
      if (!columnNames.has("zero_stock_since")) additions.push(db.prepare("ALTER TABLE products ADD COLUMN zero_stock_since TEXT"));
      if (!columnNames.has("version")) additions.push(db.prepare("ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1"));
      if (!columnNames.has("brand")) additions.push(db.prepare("ALTER TABLE products ADD COLUMN brand TEXT"));
      if (!columnNames.has("presentation")) additions.push(db.prepare("ALTER TABLE products ADD COLUMN presentation TEXT"));
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
          claim_token TEXT,
          claimed_at TEXT,
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
          restock_purchased_at TEXT,
          zero_stock_since TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`),
        db.prepare("CREATE INDEX IF NOT EXISTS import_backup_products_backup_idx ON import_backup_products (backup_id, original_id)"),
        db.prepare(`CREATE TABLE IF NOT EXISTS product_deletion_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          total_products INTEGER NOT NULL DEFAULT 0,
          processed_products INTEGER NOT NULL DEFAULT 0,
          deleted_products INTEGER NOT NULL DEFAULT 0,
          preserved_products INTEGER NOT NULL DEFAULT 0,
          backup_import_id INTEGER,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TEXT
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS product_deletion_rows (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          deletion_id INTEGER NOT NULL,
          product_id INTEGER NOT NULL,
          processed INTEGER NOT NULL DEFAULT 0,
          claim_token TEXT,
          claimed_at TEXT,
          outcome TEXT
        )`),
        db.prepare("CREATE INDEX IF NOT EXISTS product_deletion_rows_pending_idx ON product_deletion_rows (deletion_id, processed, id)"),
        db.prepare(`CREATE TABLE IF NOT EXISTS non_inventory_quotes (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          name TEXT NOT NULL,
          code TEXT,
          purchase_price_usd_cents INTEGER,
          weight_milli_lb INTEGER,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        db.prepare("CREATE INDEX IF NOT EXISTS non_inventory_quotes_updated_idx ON non_inventory_quotes (updated_at, id)"),
        db.prepare(`CREATE TABLE IF NOT EXISTS mutation_receipts (
          id TEXT PRIMARY KEY NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          response_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TEXT
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS inventory_documents (
          id TEXT PRIMARY KEY NOT NULL,
          file_fingerprint TEXT NOT NULL,
          file_name TEXT NOT NULL,
          mime_types_json TEXT NOT NULL DEFAULT '[]',
          provider TEXT NOT NULL DEFAULT 'other',
          order_number TEXT,
          invoice_number TEXT,
          shipment_number TEXT,
          document_date TEXT,
          page_count INTEGER NOT NULL DEFAULT 1,
          file_count INTEGER NOT NULL DEFAULT 0,
          processing_mode TEXT NOT NULL DEFAULT 'manual',
          analysis_status TEXT NOT NULL DEFAULT 'not_requested',
          active_analysis_id TEXT,
          field_evidence_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'draft',
          warnings_json TEXT NOT NULL DEFAULT '[]',
          duplicate_of TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          confirmed_at TEXT,
          confirmed_by TEXT
        )`),
        db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS inventory_documents_fingerprint_unique ON inventory_documents (file_fingerprint)"),
        db.prepare("CREATE INDEX IF NOT EXISTS inventory_documents_history_idx ON inventory_documents (created_at, id)"),
        db.prepare("CREATE INDEX IF NOT EXISTS inventory_documents_order_idx ON inventory_documents (provider, order_number, shipment_number)"),
        db.prepare(`CREATE TABLE IF NOT EXISTS inventory_document_lines (
          id TEXT PRIMARY KEY NOT NULL,
          document_id TEXT NOT NULL,
          line_key TEXT NOT NULL,
          line_index INTEGER NOT NULL DEFAULT 0,
          page_number INTEGER,
          original_description TEXT NOT NULL,
          name TEXT NOT NULL,
          brand TEXT,
          presentation TEXT,
          size TEXT,
          flavor TEXT,
          concentration TEXT,
          billed_quantity INTEGER,
          received_quantity INTEGER,
          units_per_package INTEGER NOT NULL DEFAULT 1,
          total_to_add INTEGER NOT NULL DEFAULT 0,
          barcode TEXT,
          canonical_barcode TEXT,
          barcode_type TEXT,
          secondary_id TEXT,
          secondary_type TEXT,
          barcode_method TEXT,
          barcode_source TEXT,
          barcode_source_url TEXT,
          barcode_source_title TEXT,
          barcode_differences_json TEXT NOT NULL DEFAULT '[]',
          barcode_lookup_status TEXT NOT NULL DEFAULT 'pending',
          field_evidence_json TEXT NOT NULL DEFAULT '{}',
          barcode_confirmed INTEGER NOT NULL DEFAULT 0,
          selected_for_ingress INTEGER NOT NULL DEFAULT 1,
          review_saved_at TEXT,
          confidence INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'requires_confirm_code',
          match_product_id INTEGER,
          match_non_inventory_id INTEGER,
          action TEXT NOT NULL DEFAULT 'pending',
          barcode_level TEXT,
          warnings_json TEXT NOT NULL DEFAULT '[]',
          processed_operation_id TEXT,
          ignored_reason TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS inventory_document_lines_key_unique ON inventory_document_lines (document_id, line_key)"),
        db.prepare("CREATE INDEX IF NOT EXISTS inventory_document_lines_document_idx ON inventory_document_lines (document_id, status, id)"),
        db.prepare("CREATE INDEX IF NOT EXISTS inventory_document_lines_barcode_idx ON inventory_document_lines (canonical_barcode)"),
        db.prepare(`CREATE TABLE IF NOT EXISTS inventory_document_files (
          id TEXT PRIMARY KEY NOT NULL,
          document_id TEXT NOT NULL,
          file_index INTEGER NOT NULL,
          storage_key TEXT NOT NULL,
          file_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          file_sha256 TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS inventory_document_files_order_unique ON inventory_document_files (document_id,file_index)"),
        db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS inventory_document_files_storage_unique ON inventory_document_files (storage_key)"),
        db.prepare("CREATE INDEX IF NOT EXISTS inventory_document_files_document_idx ON inventory_document_files (document_id,file_index)"),
        db.prepare(`CREATE TABLE IF NOT EXISTS invoice_ai_analyses (
          id TEXT PRIMARY KEY NOT NULL,
          document_id TEXT NOT NULL,
          file_fingerprint TEXT NOT NULL,
          analysis_number INTEGER NOT NULL,
          model TEXT NOT NULL,
          analysis_origin TEXT NOT NULL DEFAULT 'OPENAI_API',
          api_calls INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'processing',
          response_id TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          cached_input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          web_search_count INTEGER NOT NULL DEFAULT 0,
          estimated_cost_microusd INTEGER NOT NULL DEFAULT 0,
          api_cost_microusd INTEGER NOT NULL DEFAULT 0,
          extraction_json TEXT NOT NULL DEFAULT '{}',
          error_code TEXT,
          error_message TEXT,
          reanalysis INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TEXT
        )`),
        db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS invoice_ai_analyses_number_unique ON invoice_ai_analyses (document_id,analysis_number)"),
        db.prepare("CREATE INDEX IF NOT EXISTS invoice_ai_analyses_document_idx ON invoice_ai_analyses (document_id,created_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS invoice_ai_analyses_usage_idx ON invoice_ai_analyses (created_at,estimated_cost_microusd)"),
        db.prepare(`CREATE TABLE IF NOT EXISTS supplier_product_aliases (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          provider TEXT NOT NULL,
          secondary_type TEXT NOT NULL,
          secondary_id TEXT NOT NULL,
          barcode TEXT NOT NULL,
          canonical_barcode TEXT NOT NULL,
          product_id INTEGER NOT NULL,
          description_signature TEXT NOT NULL,
          presentation_signature TEXT,
          units_per_package INTEGER NOT NULL DEFAULT 1,
          barcode_level TEXT NOT NULL DEFAULT 'unit',
          source TEXT,
          confirmed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          confirmed_by TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS supplier_product_aliases_identity_unique ON supplier_product_aliases (provider, secondary_type, secondary_id)"),
        db.prepare("CREATE INDEX IF NOT EXISTS supplier_product_aliases_barcode_idx ON supplier_product_aliases (canonical_barcode, product_id)"),
        db.prepare(`CREATE TABLE IF NOT EXISTS inventory_operations (
          id TEXT PRIMARY KEY NOT NULL,
          document_id TEXT,
          operation_type TEXT NOT NULL DEFAULT 'ingress',
          status TEXT NOT NULL DEFAULT 'pending',
          reversal_of TEXT,
          reason TEXT,
          confirmed_by TEXT,
          line_count INTEGER NOT NULL DEFAULT 0,
          total_units INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          confirmed_at TEXT,
          verification_status TEXT NOT NULL DEFAULT 'pending'
        )`),
        db.prepare("CREATE INDEX IF NOT EXISTS inventory_operations_history_idx ON inventory_operations (confirmed_at, id)"),
        db.prepare("CREATE INDEX IF NOT EXISTS inventory_operations_document_idx ON inventory_operations (document_id, status)"),
        db.prepare(`CREATE TABLE IF NOT EXISTS inventory_movements (
          id TEXT PRIMARY KEY NOT NULL,
          operation_id TEXT NOT NULL,
          original_movement_id TEXT,
          document_line_id TEXT,
          product_id INTEGER NOT NULL,
          product_name TEXT NOT NULL,
          barcode TEXT,
          canonical_barcode TEXT,
          secondary_id TEXT,
          secondary_type TEXT,
          previous_quantity INTEGER NOT NULL,
          quantity_change INTEGER NOT NULL,
          conversion INTEGER NOT NULL DEFAULT 1,
          resulting_quantity INTEGER NOT NULL,
          barcode_method TEXT,
          barcode_source TEXT,
          confirmed_by TEXT,
          reason TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_operation_line_unique ON inventory_movements (operation_id, document_line_id)"),
        db.prepare("DROP INDEX IF EXISTS inventory_movements_invoice_line_unique"),
        db.prepare(`CREATE TRIGGER IF NOT EXISTS inventory_movements_invoice_capacity_insert
          BEFORE INSERT ON inventory_movements
          WHEN NEW.document_line_id LIKE 'iline-%' AND NEW.quantity_change>0
          BEGIN
            SELECT CASE
              WHEN NOT EXISTS (SELECT 1 FROM inventory_document_lines WHERE id=NEW.document_line_id)
                THEN RAISE(ABORT,'INVENTORY_LINE_NOT_FOUND')
              WHEN COALESCE((SELECT SUM(quantity_change) FROM inventory_movements WHERE document_line_id=NEW.document_line_id),0)+NEW.quantity_change>
                COALESCE((SELECT total_to_add FROM inventory_document_lines WHERE id=NEW.document_line_id),0)
                THEN RAISE(ABORT,'INVENTORY_LINE_CAPACITY_EXCEEDED')
            END;
          END`),
        db.prepare(`CREATE TRIGGER IF NOT EXISTS inventory_movements_invoice_active_nonnegative
          BEFORE INSERT ON inventory_movements
          WHEN NEW.document_line_id LIKE 'iline-%' AND NEW.quantity_change<0
          BEGIN
            SELECT CASE
              WHEN COALESCE((SELECT SUM(quantity_change) FROM inventory_movements WHERE document_line_id=NEW.document_line_id),0)+NEW.quantity_change<0
                THEN RAISE(ABORT,'INVENTORY_LINE_ACTIVE_NEGATIVE')
            END;
          END`),
        db.prepare("CREATE INDEX IF NOT EXISTS inventory_movements_product_idx ON inventory_movements (product_id, created_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS inventory_movements_operation_idx ON inventory_movements (operation_id, id)"),
      ]);

      const intakeDocumentColumns = await db.prepare("PRAGMA table_info(inventory_documents)").all<{ name: string }>();
      const intakeDocumentColumnNames = new Set(intakeDocumentColumns.results.map((column) => column.name));
      const intakeDocumentAdditions = [];
      if (!intakeDocumentColumnNames.has("file_count")) intakeDocumentAdditions.push(db.prepare("ALTER TABLE inventory_documents ADD COLUMN file_count INTEGER NOT NULL DEFAULT 0"));
      if (!intakeDocumentColumnNames.has("processing_mode")) intakeDocumentAdditions.push(db.prepare("ALTER TABLE inventory_documents ADD COLUMN processing_mode TEXT NOT NULL DEFAULT 'manual'"));
      if (!intakeDocumentColumnNames.has("analysis_status")) intakeDocumentAdditions.push(db.prepare("ALTER TABLE inventory_documents ADD COLUMN analysis_status TEXT NOT NULL DEFAULT 'not_requested'"));
      if (!intakeDocumentColumnNames.has("active_analysis_id")) intakeDocumentAdditions.push(db.prepare("ALTER TABLE inventory_documents ADD COLUMN active_analysis_id TEXT"));
      if (!intakeDocumentColumnNames.has("field_evidence_json")) intakeDocumentAdditions.push(db.prepare("ALTER TABLE inventory_documents ADD COLUMN field_evidence_json TEXT NOT NULL DEFAULT '{}'"));
      if (intakeDocumentAdditions.length) await db.batch(intakeDocumentAdditions);

      const intakeLineColumns = await db.prepare("PRAGMA table_info(inventory_document_lines)").all<{ name: string }>();
      const intakeLineColumnNames = new Set(intakeLineColumns.results.map((column) => column.name));
      if (!intakeLineColumnNames.has("barcode_confirmed")) {
        await db.prepare("ALTER TABLE inventory_document_lines ADD COLUMN barcode_confirmed INTEGER NOT NULL DEFAULT 0").run();
      }
      if (!intakeLineColumnNames.has("selected_for_ingress")) {
        await db.prepare("ALTER TABLE inventory_document_lines ADD COLUMN selected_for_ingress INTEGER NOT NULL DEFAULT 1").run();
      }
      if (!intakeLineColumnNames.has("review_saved_at")) {
        await db.prepare("ALTER TABLE inventory_document_lines ADD COLUMN review_saved_at TEXT").run();
      }
      const intakeLineAdditions = [];
      if (!intakeLineColumnNames.has("line_index")) intakeLineAdditions.push(db.prepare("ALTER TABLE inventory_document_lines ADD COLUMN line_index INTEGER NOT NULL DEFAULT 0"));
      if (!intakeLineColumnNames.has("size")) intakeLineAdditions.push(db.prepare("ALTER TABLE inventory_document_lines ADD COLUMN size TEXT"));
      if (!intakeLineColumnNames.has("barcode_source_url")) intakeLineAdditions.push(db.prepare("ALTER TABLE inventory_document_lines ADD COLUMN barcode_source_url TEXT"));
      if (!intakeLineColumnNames.has("barcode_source_title")) intakeLineAdditions.push(db.prepare("ALTER TABLE inventory_document_lines ADD COLUMN barcode_source_title TEXT"));
      if (!intakeLineColumnNames.has("barcode_differences_json")) intakeLineAdditions.push(db.prepare("ALTER TABLE inventory_document_lines ADD COLUMN barcode_differences_json TEXT NOT NULL DEFAULT '[]'"));
      if (!intakeLineColumnNames.has("barcode_lookup_status")) intakeLineAdditions.push(db.prepare("ALTER TABLE inventory_document_lines ADD COLUMN barcode_lookup_status TEXT NOT NULL DEFAULT 'pending'"));
      if (!intakeLineColumnNames.has("field_evidence_json")) intakeLineAdditions.push(db.prepare("ALTER TABLE inventory_document_lines ADD COLUMN field_evidence_json TEXT NOT NULL DEFAULT '{}'"));
      if (intakeLineAdditions.length) await db.batch(intakeLineAdditions);

      const invoiceAnalysisColumns = await db.prepare("PRAGMA table_info(invoice_ai_analyses)").all<{ name: string }>();
      const invoiceAnalysisColumnNames = new Set(invoiceAnalysisColumns.results.map((column) => column.name));
      const invoiceAnalysisAdditions = [];
      const needsApiCostBackfill = !invoiceAnalysisColumnNames.has("api_cost_microusd");
      if (!invoiceAnalysisColumnNames.has("analysis_origin")) invoiceAnalysisAdditions.push(db.prepare("ALTER TABLE invoice_ai_analyses ADD COLUMN analysis_origin TEXT NOT NULL DEFAULT 'OPENAI_API'"));
      if (!invoiceAnalysisColumnNames.has("api_calls")) invoiceAnalysisAdditions.push(db.prepare("ALTER TABLE invoice_ai_analyses ADD COLUMN api_calls INTEGER NOT NULL DEFAULT 1"));
      if (needsApiCostBackfill) invoiceAnalysisAdditions.push(db.prepare("ALTER TABLE invoice_ai_analyses ADD COLUMN api_cost_microusd INTEGER NOT NULL DEFAULT 0"));
      if (invoiceAnalysisAdditions.length) await db.batch(invoiceAnalysisAdditions);
      if (needsApiCostBackfill) await db.prepare("UPDATE invoice_ai_analyses SET api_cost_microusd=estimated_cost_microusd").run();

      const backupColumns = await db.prepare("PRAGMA table_info(import_backup_products)").all<{ name: string }>();
      const backupColumnNames = new Set(backupColumns.results.map((column) => column.name));
      const backupAdditions = [];
      if (!backupColumnNames.has("restock_purchased_at")) backupAdditions.push(db.prepare("ALTER TABLE import_backup_products ADD COLUMN restock_purchased_at TEXT"));
      if (!backupColumnNames.has("zero_stock_since")) backupAdditions.push(db.prepare("ALTER TABLE import_backup_products ADD COLUMN zero_stock_since TEXT"));
      if (!backupColumnNames.has("version")) backupAdditions.push(db.prepare("ALTER TABLE import_backup_products ADD COLUMN version INTEGER NOT NULL DEFAULT 1"));
      if (backupAdditions.length) await db.batch(backupAdditions);

      const importRowColumns = await db.prepare("PRAGMA table_info(import_job_rows)").all<{ name: string }>();
      const importRowColumnNames = new Set(importRowColumns.results.map((column) => column.name));
      const importRowAdditions = [];
      if (!importRowColumnNames.has("claim_token")) importRowAdditions.push(db.prepare("ALTER TABLE import_job_rows ADD COLUMN claim_token TEXT"));
      if (!importRowColumnNames.has("claimed_at")) importRowAdditions.push(db.prepare("ALTER TABLE import_job_rows ADD COLUMN claimed_at TEXT"));
      if (importRowAdditions.length) await db.batch(importRowAdditions);

      const deletionRowColumns = await db.prepare("PRAGMA table_info(product_deletion_rows)").all<{ name: string }>();
      const deletionRowColumnNames = new Set(deletionRowColumns.results.map((column) => column.name));
      const deletionRowAdditions = [];
      if (!deletionRowColumnNames.has("claim_token")) deletionRowAdditions.push(db.prepare("ALTER TABLE product_deletion_rows ADD COLUMN claim_token TEXT"));
      if (!deletionRowColumnNames.has("claimed_at")) deletionRowAdditions.push(db.prepare("ALTER TABLE product_deletion_rows ADD COLUMN claimed_at TEXT"));
      if (deletionRowAdditions.length) await db.batch(deletionRowAdditions);

      await db.batch([
        db.prepare("CREATE INDEX IF NOT EXISTS import_job_rows_claim_idx ON import_job_rows (import_id, processed, claimed_at, id)"),
        db.prepare("CREATE INDEX IF NOT EXISTS product_deletion_rows_claim_idx ON product_deletion_rows (deletion_id, processed, claimed_at, id)"),
      ]);
    })().catch((error) => { initialization = null; throw error; });
  }
  await initialization;
}
