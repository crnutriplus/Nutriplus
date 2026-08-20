import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  INVENTORY_MOVEMENT_CAPACITY_TRIGGER_SQL,
  INVENTORY_MOVEMENT_NONNEGATIVE_TRIGGER_SQL,
} from "../lib/inventory-movement-guard-sql.ts";

const sqlite = new DatabaseSync(":memory:");

try {
  sqlite.exec(`
    CREATE TABLE inventory_documents (
      id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE inventory_document_lines (
      id TEXT PRIMARY KEY NOT NULL,
      document_id TEXT NOT NULL,
      action TEXT NOT NULL,
      total_to_add INTEGER NOT NULL,
      review_saved_at TEXT
    );
    CREATE TABLE inventory_operations (
      id TEXT PRIMARY KEY NOT NULL,
      document_id TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE inventory_movements (
      id TEXT PRIMARY KEY NOT NULL,
      operation_id TEXT NOT NULL,
      original_movement_id TEXT,
      document_line_id TEXT,
      quantity_change INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX inventory_movements_operation_line_unique
      ON inventory_movements (operation_id, document_line_id);
    CREATE UNIQUE INDEX inventory_movements_invoice_line_unique
      ON inventory_movements (document_line_id)
      WHERE original_movement_id IS NULL AND document_line_id LIKE 'iline-%';

    INSERT INTO inventory_documents (id,status) VALUES ('idoc-v211','processed');
    INSERT INTO inventory_document_lines (id,document_id,action,total_to_add,review_saved_at)
      VALUES ('iline-v211','idoc-v211','existing',5,'2026-08-19T10:00:00.000Z');
    INSERT INTO inventory_operations (id,document_id,status) VALUES
      ('ingress-v211','idoc-v211','completed'),
      ('reversal-v211','idoc-v211','completed');
    INSERT INTO inventory_movements (id,operation_id,original_movement_id,document_line_id,quantity_change) VALUES
      ('mov-ingress-v211','ingress-v211',NULL,'iline-v211',5),
      ('mov-reversal-v211','reversal-v211','mov-ingress-v211','iline-v211',-5);
  `);

  const migration = await readFile(new URL("../drizzle/0014_woozy_madrox.sql", import.meta.url), "utf8");
  const migrationStatements = migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean);
  for (const statement of migrationStatements) {
    sqlite.exec(statement);
  }
  // A failed deploy may have executed DROP INDEX before recording the
  // migration. Reapplying the safe statements must remain harmless.
  for (const statement of migrationStatements) sqlite.exec(statement);

  const indexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name);
  assert.ok(!indexes.includes("inventory_movements_invoice_line_unique"));
  assert.ok(indexes.includes("inventory_movements_operation_line_unique"));
  assert.equal(sqlite.prepare("SELECT status FROM inventory_documents WHERE id='idoc-v211'").get().status, "partial");

  // ensureDatabase() installs each guard as one prepared D1 statement before
  // any API mutation; trigger bodies intentionally do not live in Sites SQL.
  sqlite.exec(INVENTORY_MOVEMENT_CAPACITY_TRIGGER_SQL);
  sqlite.exec(INVENTORY_MOVEMENT_NONNEGATIVE_TRIGGER_SQL);

  sqlite.exec("INSERT INTO inventory_operations (id,document_id,status) VALUES ('reingress-v212','idoc-v211','pending')");
  sqlite.exec(`INSERT INTO inventory_movements (id,operation_id,original_movement_id,document_line_id,quantity_change)
    VALUES ('mov-reingress-v212','reingress-v212',NULL,'iline-v211',5)`);
  sqlite.exec("UPDATE inventory_operations SET status='completed' WHERE id='reingress-v212'");

  sqlite.exec("INSERT INTO inventory_operations (id,document_id,status) VALUES ('accidental-v212','idoc-v211','pending')");
  assert.throws(
    () => sqlite.exec(`INSERT INTO inventory_movements (id,operation_id,original_movement_id,document_line_id,quantity_change)
      VALUES ('mov-accidental-v212','accidental-v212',NULL,'iline-v211',1)`),
    /INVENTORY_LINE_CAPACITY_EXCEEDED/,
  );

  sqlite.exec("INSERT INTO inventory_operations (id,document_id,status) VALUES ('quick-v212',NULL,'pending')");
  sqlite.exec(`INSERT INTO inventory_movements (id,operation_id,original_movement_id,document_line_id,quantity_change)
    VALUES ('mov-quick-v212','quick-v212',NULL,'quick:QTY-001',7)`);

  sqlite.exec("INSERT INTO inventory_operations (id,document_id,status) VALUES ('excess-reversal-v212','idoc-v211','pending')");
  assert.throws(
    () => sqlite.exec(`INSERT INTO inventory_movements (id,operation_id,original_movement_id,document_line_id,quantity_change)
      VALUES ('mov-excess-reversal-v212','excess-reversal-v212','mov-reingress-v212','iline-v211',-6)`),
    /INVENTORY_LINE_ACTIVE_NEGATIVE/,
  );

  assert.equal(
    sqlite.prepare("SELECT COALESCE(SUM(quantity_change),0) AS active FROM inventory_movements WHERE document_line_id='iline-v211'").get().active,
    5,
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM inventory_movements WHERE document_line_id='iline-v211'").get().total, 3);

  console.log("Migration 0014: v2.11 history, reversal reingress, capacity, quick inventory, and nonnegative active balance passed");
} finally {
  sqlite.close();
}
