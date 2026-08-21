import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { ORDER_DATABASE_TRIGGER_SQL } from "../lib/orders-database.ts";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys=ON");
sqlite.exec(`
  CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    code TEXT,
    brand TEXT,
    presentation TEXT,
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
  );
  CREATE TABLE inventory_movements (
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
  );
  INSERT INTO products (id,name,normalized_name,code,quantity_available) VALUES (1,'Producto existente','producto existente','LEGACY-1',5);
  INSERT INTO inventory_movements (
    id,operation_id,document_line_id,product_id,product_name,previous_quantity,quantity_change,resulting_quantity
  ) VALUES ('legacy-movement','legacy-operation','iline-legacy',1,'Producto existente',4,1,5);
`);

const migrationUrl = new URL("../drizzle/0015_quiet_anthem.sql", import.meta.url);
const migration = await readFile(migrationUrl, "utf8");
sqlite.exec("BEGIN IMMEDIATE");
try {
  for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) sqlite.exec(statement);
  sqlite.exec("COMMIT");
} catch (error) {
  sqlite.exec("ROLLBACK");
  throw error;
}

// Sites migrations cannot carry trigger bodies with internal terminators.
// ensureDatabase() installs these as individual prepared D1 statements before
// every API operation, matching the established inventory guard pattern.
for (const statement of ORDER_DATABASE_TRIGGER_SQL) sqlite.exec(statement);

const expectedTables = [
  "orders", "order_lines", "order_payments", "order_status_events", "order_events", "order_operations",
  "order_external_references", "delivery_routes", "route_orders", "order_returns", "order_return_lines",
  "order_fulfillments", "order_fulfillment_lines", "order_number_allocations", "special_order_details",
  "special_order_receipts", "special_order_receipt_lines",
];
const tables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
expectedTables.forEach((table) => assert.ok(tables.has(table), `${table} must exist after 0015`));
const movementColumns = new Set(sqlite.prepare("PRAGMA table_info(inventory_movements)").all().map((row) => row.name));
for (const column of ["order_id", "order_line_id", "movement_type"]) assert.ok(movementColumns.has(column));
const orderColumns = new Set(sqlite.prepare("PRAGMA table_info(orders)").all().map((row) => row.name));
assert.ok(orderColumns.has("expected_payment_method"));
assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM inventory_movements WHERE id='legacy-movement'").get().total, 1);

sqlite.exec(`
  INSERT INTO order_number_allocations (order_id) VALUES ('order-migration-test');
  INSERT INTO orders (
    id,order_number,order_type,customer_name_snapshot,status,currency,subtotal,discount_total,delivery_fee,total,source,version
  ) VALUES ('order-migration-test','NP-000001','STANDARD','Cliente','DRAFT','CRC',10000,0,1000,11000,'MANUAL',1);
  INSERT INTO order_lines (
    id,order_id,position,product_id,quantity,product_name_snapshot,unit_price_sold,discount_amount,line_subtotal,line_total
  ) VALUES ('oline-migration-test','order-migration-test',1,1,2,'Producto existente',5000,0,10000,10000);
  INSERT INTO order_operations (operation_id,order_id,operation_type,request_hash,status)
  VALUES ('operation-migration-confirm','order-migration-test','CONFIRM','hash','pending');
`);

sqlite.prepare(`INSERT INTO inventory_movements (
  id,operation_id,order_id,order_line_id,movement_type,product_id,product_name,previous_quantity,
  quantity_change,conversion,resulting_quantity,created_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "movement-order-confirm", "operation-migration-confirm", "order-migration-test", "oline-migration-test",
  "ORDER_CONFIRM", 1, "Producto existente", 5, -2, 1, 3, "2026-08-20T12:00:00.000Z",
);
assert.equal(sqlite.prepare("SELECT quantity_available FROM products WHERE id=1").get().quantity_available, 3);

assert.throws(() => sqlite.prepare(`INSERT INTO inventory_movements (
  id,operation_id,order_id,order_line_id,movement_type,product_id,product_name,previous_quantity,
  quantity_change,conversion,resulting_quantity,created_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "movement-order-overdraw", "operation-overdraw", "order-migration-test", "oline-migration-test",
  "ORDER_EDIT_INCREASE", 1, "Producto existente", 3, -4, 1, -1, "2026-08-20T12:01:00.000Z",
), /ORDER_INSUFFICIENT_STOCK/);
assert.equal(sqlite.prepare("SELECT quantity_available FROM products WHERE id=1").get().quantity_available, 3);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM inventory_movements WHERE id='movement-order-overdraw'").get().total, 0);

assert.throws(() => sqlite.prepare("UPDATE orders SET status='DELIVERED' WHERE id='order-migration-test'").run(), /ORDER_INVALID_TRANSITION/);
sqlite.prepare("UPDATE orders SET status='CONFIRMED' WHERE id='order-migration-test'").run();
sqlite.prepare(`INSERT INTO order_status_events (id,order_id,from_status,to_status,operation_id)
  VALUES ('status-event-migration','order-migration-test','DRAFT','CONFIRMED','operation-migration-confirm')`).run();
assert.throws(() => sqlite.prepare("UPDATE order_status_events SET reason='cambio' WHERE id='status-event-migration'").run(), /ORDER_STATUS_EVENT_APPEND_ONLY/);
assert.throws(() => sqlite.prepare("DELETE FROM order_lines WHERE id='oline-migration-test'").run(), /ORDER_LINE_HARD_DELETE_FORBIDDEN/);

sqlite.exec(`
  INSERT INTO orders (
    id,order_number,order_type,customer_name_snapshot,status,currency,subtotal,discount_total,delivery_fee,total,expected_payment_method,source,version
  ) VALUES ('special-migration-test','NP-000002','SPECIAL_ORDER','Cliente Encargo','DRAFT','CRC',5000,0,0,5000,'SINPE','MANUAL',1);
  INSERT INTO special_order_details (order_id,special_order_status) VALUES ('special-migration-test','REQUESTED');
`);
assert.equal(sqlite.prepare("SELECT expected_payment_method FROM orders WHERE id='special-migration-test'").get().expected_payment_method, "SINPE");
assert.throws(() => sqlite.prepare("UPDATE special_order_details SET special_order_status='IN_TRANSIT' WHERE order_id='special-migration-test'").run(), /SPECIAL_ORDER_INVALID_TRANSITION/);
sqlite.prepare("UPDATE special_order_details SET special_order_status='ORDERED_FROM_SUPPLIER' WHERE order_id='special-migration-test'").run();
assert.equal(sqlite.prepare("SELECT special_order_status FROM special_order_details WHERE order_id='special-migration-test'").get().special_order_status, "ORDERED_FROM_SUPPLIER");

sqlite.close();
console.log("Migration 0015 preserves existing inventory data and adds guarded orders, expected payment, normalized special orders, receipts, and stock movements");
