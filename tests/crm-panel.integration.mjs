import assert from "node:assert/strict";
import test from "node:test";
import { LocalD1Database } from "./helpers/local-bindings.mjs";
import { CrmError } from "../lib/crm.ts";
import { getCrmPanel, getCrmPanelOrder, parseCrmPanelContext } from "../lib/crm-panel.ts";

const customerId = "customer-panel-00000000-0000-4000-8000-000000000001";
const orderA = "order-00000000-0000-4000-8000-000000000001";
const orderB = "order-00000000-0000-4000-8000-000000000002";

function fixture() {
  const db = new LocalD1Database();
  db.sqlite.exec(`
    CREATE TABLE customers (id TEXT PRIMARY KEY,name TEXT NOT NULL,phone_raw TEXT,phone_normalized TEXT,customer_status TEXT,province TEXT,canton TEXT,district TEXT,default_delivery_address TEXT,location_url TEXT,location_reference TEXT,latitude REAL,longitude REAL,preferred_payment_method TEXT);
    CREATE TABLE orders (id TEXT PRIMARY KEY,order_number TEXT NOT NULL,order_type TEXT NOT NULL,customer_id TEXT,customer_name_snapshot TEXT NOT NULL,delivery_address TEXT,delivery_instructions TEXT,province TEXT,canton TEXT,district TEXT,latitude REAL,longitude REAL,scheduled_delivery_date TEXT,status TEXT NOT NULL,total INTEGER NOT NULL,expected_payment_method TEXT,delivery_notes TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE chatwoot_contact_links (id TEXT PRIMARY KEY,chatwoot_account_id INTEGER,chatwoot_contact_id INTEGER,customer_id TEXT);
    CREATE TABLE chatwoot_conversation_order_links (id TEXT PRIMARY KEY,chatwoot_account_id INTEGER,chatwoot_conversation_id INTEGER,order_id TEXT,link_role TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE special_order_details (order_id TEXT PRIMARY KEY,special_order_status TEXT);
    CREATE TABLE order_lines (id TEXT PRIMARY KEY,order_id TEXT,position INTEGER,product_name_snapshot TEXT,presentation_snapshot TEXT,quantity INTEGER,unit_price_original INTEGER,unit_price_sold INTEGER,discount_amount INTEGER,line_total INTEGER,removed_at TEXT);
    CREATE TABLE order_payments (id TEXT PRIMARY KEY,order_id TEXT,amount INTEGER,method TEXT,payment_type TEXT,status TEXT,reference TEXT,created_at TEXT);
  `);
  db.sqlite.prepare("INSERT INTO customers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(customerId, "Cliente panel", "+50670000000", "+50670000000", "ACTIVE", "San José", "Central", "Carmen", "Dirección de prueba", "https://maps.example/panel", "Casa azul", 9.93, -84.08, "SINPE");
  db.sqlite.prepare("INSERT INTO chatwoot_contact_links VALUES (?,?,?,?)").run("link-1", 1, 77, customerId);
  const insertOrder = db.sqlite.prepare("INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insertOrder.run(orderA, "NP-100", "STANDARD", customerId, "Cliente panel", "Dirección A", "Portón negro", "San José", "Central", "Carmen", 9.93, -84.08, "2026-09-10", "CONFIRMED", 10000, "SINPE", "Sin notas sensibles", "2026-09-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z");
  insertOrder.run(orderB, "NP-099", "SPECIAL_ORDER", customerId, "Cliente panel", "Dirección B", null, "San José", "Central", "Carmen", null, null, null, "DELIVERED", 8000, "CASH", null, "2026-08-01T10:00:00.000Z", "2026-08-01T10:00:00.000Z");
  db.sqlite.prepare("INSERT INTO special_order_details VALUES (?,?)").run(orderB, "DELIVERED");
  db.sqlite.prepare("INSERT INTO chatwoot_conversation_order_links VALUES (?,?,?,?,?,?,?)").run("conversation-link-1", 1, 900, orderA, "PRIMARY", "2026-09-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z");
  db.sqlite.prepare("INSERT INTO order_lines VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("line-1", orderA, 1, "Producto prueba", "60 cápsulas", 2, 5000, 5000, 0, 10000, null);
  db.sqlite.prepare("INSERT INTO order_payments VALUES (?,?,?,?,?,?,?,?)").run("payment-1", orderA, 3000, "SINPE", "PAYMENT", "POSTED", "REF-1", "2026-09-01T12:00:00.000Z");
  return db;
}

const context = { accountId: 1, contactId: 77, conversationId: 900 };
function conversationClient(conversation = { id: 900, account_id: 1, meta: { sender: { id: 77 } } }) {
  return { async getConversation() { return conversation; } };
}

test("CRM mobile panel resolves only the linked customer and remains read-only", async () => {
  const db = fixture();
  const writesBefore = db.sqlite.prepare("SELECT count(*) AS count FROM orders").get().count;
  const panel = await getCrmPanel(db, context, conversationClient());
  assert.equal(panel.customer.id, customerId);
  assert.equal(panel.customer.ordersCount, 2);
  assert.equal(panel.activeOrders.length, 1);
  assert.equal(panel.conversationOrders[0].id, orderA);
  assert.equal(panel.recentOrders[0].paymentStatus, "PARTIAL");
  assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM orders").get().count, writesBefore);
  db.close();
});

test("CRM mobile panel returns order detail only for the resolved customer", async () => {
  const db = fixture();
  const result = await getCrmPanelOrder(db, context, orderA, conversationClient());
  assert.equal(result.order.lines.length, 1);
  assert.equal(result.order.payments.length, 1);
  assert.equal(result.order.balance, 7000);
  await assert.rejects(() => getCrmPanelOrder(db, { ...context, contactId: 999 }, orderA, conversationClient()), (error) => error instanceof CrmError && error.code === "CRM_PANEL_CUSTOMER_NOT_LINKED");
  db.close();
});

test("CRM context preserves customer-link error precedence when Chatwoot also fails", async () => {
  const db = fixture();
  await assert.rejects(
    () => getCrmPanel(
      db,
      { ...context, contactId: 999 },
      { async getConversation() { throw new Error("Chatwoot unavailable"); } },
    ),
    (error) => error instanceof CrmError && error.code === "CRM_PANEL_CUSTOMER_NOT_LINKED",
  );
  db.close();
});

test("CRM mobile panel handles customers without orders, locations, or conversation links", async () => {
  const db = fixture();
  const emptyCustomer = "customer-panel-00000000-0000-4000-8000-000000000002";
  db.sqlite.prepare("INSERT INTO customers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(emptyCustomer, "Cliente sin pedidos", null, null, "PROSPECT", null, null, null, null, null, null, null, null, null);
  db.sqlite.prepare("INSERT INTO chatwoot_contact_links VALUES (?,?,?,?)").run("link-2", 1, 78, emptyCustomer);
  const panel = await getCrmPanel(db, { accountId: 1, contactId: 78, conversationId: 901 }, conversationClient({ id: 901, account_id: 1, meta: { sender: { id: 78 } } }));
  assert.equal(panel.customer.ordersCount, 0);
  assert.equal(panel.customer.locationUrl, null);
  assert.deepEqual(panel.activeOrders, []);
  assert.deepEqual(panel.conversationOrders, []);
  db.close();
});

test("CRM mobile context rejects malformed browser parameters", () => {
  assert.deepEqual(parseCrmPanelContext(new URL("https://panel.test/?account_id=1&contact_id=77&conversation_id=900")), context);
  assert.deepEqual(parseCrmPanelContext(new URL("https://panel.test/?account_id=1&contact_id=77&conversation_id=900&customer_id=other")), context);
  assert.throws(() => parseCrmPanelContext(new URL("https://panel.test/?account_id=1&contact_id=0")), (error) => error instanceof CrmError && error.code === "CRM_PANEL_CONTEXT_INVALID");
});

test("CRM mobile context rejects a tampered account, contact, or conversation before exposing data", async () => {
  const db = fixture();
  await assert.rejects(() => getCrmPanel(db, context, conversationClient({ id: 900, account_id: 1, meta: { sender: { id: 78 } } })), (error) => error instanceof CrmError && error.code === "CRM_PANEL_CONTEXT_MISMATCH");
  await assert.rejects(() => getCrmPanel(db, context, conversationClient({ id: 900, account_id: 2, meta: { sender: { id: 77 } } })), (error) => error instanceof CrmError && error.code === "CRM_PANEL_CONTEXT_MISMATCH");
  await assert.rejects(() => getCrmPanel(db, { ...context, conversationId: 901 }, conversationClient({ id: 901, account_id: 1, meta: { sender: { id: 78 } } })), (error) => error instanceof CrmError && error.code === "CRM_PANEL_CONTEXT_MISMATCH");
  await assert.rejects(() => getCrmPanel(db, context), (error) => error instanceof CrmError && error.code === "CRM_PANEL_CHATWOOT_NOT_CONFIGURED");
  db.close();
});
