import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { LocalD1Database, LocalR2Bucket } from "./helpers/local-bindings.mjs";
import { invoiceFinanceReversalStatements, invoiceFinanceStatements } from "../lib/inventory-invoice-finance.ts";

const DB = new LocalD1Database();
const BUCKET = new LocalR2Bucket();
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("invoiceFinance", `${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
const env = { DB, BUCKET, ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const ctx = { waitUntil() {}, passThroughOnException() {} };
await worker.fetch(new Request("http://local.test/api/settings"), env, ctx);

const extraction = {
  invoice: { currency: "USD", total: 90, purchase_date: "2026-08-20" },
  payment_status: "PAID",
  payments: [
    { payment_method: "American Express", normalized_method: "CARD", amount: 81, currency: "USD", last4: "7706", cash_affecting: true },
    { payment_method: "Store Credit", normalized_method: "OTHER", amount: 9, currency: "USD", last4: null, cash_affecting: false },
  ],
};

DB.sqlite.prepare(`INSERT INTO inventory_documents (
  id,file_fingerprint,file_name,mime_types_json,provider,invoice_number,document_date,page_count,file_count,processing_mode,
  analysis_status,active_analysis_id,field_evidence_json,status,warnings_json
) VALUES ('invoice-partial','fp-partial','invoice.pdf','["application/pdf"]','iherb','946971969','2026-08-20',1,1,'chatgpt_import','completed','analysis-partial','{}','processing','[]')`).run();
DB.sqlite.prepare(`INSERT INTO invoice_ai_analyses (
  id,document_id,file_fingerprint,analysis_number,model,analysis_origin,api_calls,status,extraction_json
) VALUES ('analysis-partial','invoice-partial','fp-partial',1,'ChatGPT Import','CHATGPT_IMPORT',0,'completed',?)`).run(JSON.stringify(extraction));
const invoiceBytes = new TextEncoder().encode("%PDF-1.4\n% invoice finance link\n%%EOF");
const invoiceStorageKey = "inventory-invoices/invoice-partial/000";
await BUCKET.put(invoiceStorageKey, invoiceBytes, { httpMetadata: { contentType: "application/pdf" } });
DB.sqlite.prepare(`INSERT INTO inventory_document_files (
  id,document_id,file_index,storage_key,file_name,mime_type,size_bytes,file_sha256
) VALUES (?,?,?,?,?,?,?,?)`).run(
  "ifile-partial", "invoice-partial", 0, invoiceStorageKey, "invoice.pdf", "application/pdf", invoiceBytes.byteLength,
  createHash("sha256").update(invoiceBytes).digest("hex"),
);
const document = DB.sqlite.prepare("SELECT * FROM inventory_documents WHERE id='invoice-partial'").get();

function line(id, net, options = {}) {
  return {
    id,
    action: options.action || "existing",
    originalTotal: options.originalTotal || 1,
    totalToAdd: options.totalToAdd || 1,
    fieldEvidence: { net_line_cost: { value: net.toFixed(2), source: "chatgpt_import" } },
  };
}

async function post(operationId, sourceLine) {
  await DB.batch(await invoiceFinanceStatements(DB, document, [sourceLine], "2026-08-29T12:00:00.000Z", operationId));
}

const lineA = line("business-a", 20);
const lineB = line("business-b", 30);
const lineC = line("business-c", 40);
const personal = line("personal-only", 30, { action: "ignore" });

// A is the only line confirmed in the first ingress. The paid invoice remains
// a source document, but only A is a business purchase at this point.
await post("ingress-a", lineA);
assert.equal(Number(DB.sqlite.prepare("SELECT COALESCE(SUM(original_amount_minor),0) AS total FROM finance_expenses WHERE entry_type='EXPENSE'").get().total), 2000);
await post("ingress-a", lineA); // retry must not create a second posting
assert.equal(Number(DB.sqlite.prepare("SELECT COUNT(*) AS total FROM finance_expenses WHERE entry_type='EXPENSE'").get().total), 2);

await post("ingress-b", lineB);
assert.equal(Number(DB.sqlite.prepare("SELECT COALESCE(SUM(original_amount_minor),0) AS total FROM finance_expenses WHERE entry_type='EXPENSE'").get().total), 5000);
await post("ingress-c", lineC);
await post("ingress-personal", personal);
assert.equal(Number(DB.sqlite.prepare("SELECT COALESCE(SUM(original_amount_minor),0) AS total FROM finance_expenses WHERE entry_type='EXPENSE'").get().total), 9000, "A + B + C only; omitted line is never recognized");

const originalRows = DB.sqlite.prepare("SELECT * FROM finance_expenses WHERE entry_type='EXPENSE' ORDER BY source_id").all();
assert.equal(originalRows.length, 6, "each recognized line retains each payment component");
assert.ok(originalRows.every((row) => String(row.source_id).startsWith("invoice-partial:business-")));
assert.ok(originalRows.some((row) => row.source_type === "INVENTORY_INVOICE_LINE_NON_CASH"));
assert.ok(originalRows.some((row) => /terminación 7706/.test(String(row.notes))));
assert.ok(originalRows.every((row) => !/\d{12,}/.test(String(row.notes))), "no card/account data beyond last4 is stored");

// Reversing the original ingress changes only A's active financial impact and
// preserves both original ledger rows plus linked append-only reversals.
const reversals = await invoiceFinanceReversalStatements(DB, "ingress-a", "reverse-a", "Corrección de cantidad", "2026-08-29T13:00:00.000Z");
assert.equal(reversals.length, 2);
await DB.batch(reversals);
assert.equal((await invoiceFinanceReversalStatements(DB, "ingress-a", "reverse-a", "Corrección de cantidad", "2026-08-29T13:01:00.000Z")).length, 0, "retry does not duplicate invoice reversals");
const signedMinor = DB.sqlite.prepare("SELECT COALESCE(SUM(CASE WHEN entry_type='REVERSAL' THEN -original_amount_minor ELSE original_amount_minor END),0) AS total FROM finance_expenses").get();
assert.equal(Number(signedMinor.total), 7000, "after A reversal, B + C are the only active purchase cost");

// A can be processed again after its reversal. This creates a new, traceable
// line posting rather than reviving or mutating the historical entry.
await post("ingress-a-reprocessed", lineA);
const reprocessedSigned = DB.sqlite.prepare("SELECT COALESCE(SUM(CASE WHEN entry_type='REVERSAL' THEN -original_amount_minor ELSE original_amount_minor END),0) AS total FROM finance_expenses").get();
assert.equal(Number(reprocessedSigned.total), 9000);

// The first confirmed line establishes the document's accounting date, exactly
// as the intake confirmation endpoint does in production.
DB.sqlite.prepare("UPDATE inventory_documents SET confirmed_at='2026-08-29T12:00:00.000Z',confirmed_by='owner' WHERE id='invoice-partial'").run();
const financeResponse = await worker.fetch(new Request("http://local.test/api/finance?from=2026-08-29&to=2026-08-29"), env, ctx);
assert.equal(financeResponse.status, 200);
const finance = await financeResponse.json();
const invoiceExpenses = finance.expenses.filter((item) => item.sourceType.startsWith("INVENTORY_INVOICE_"));
assert.equal(invoiceExpenses.length, 10, "original, reversal and reprocessed ledger rows are all auditable");
assert.ok(invoiceExpenses.every((item) => item.invoice?.provider === "iherb"));
assert.ok(invoiceExpenses.some((item) => item.invoice?.payment?.last4 === "7706"));
assert.ok(invoiceExpenses.some((item) => item.sourceType === "INVENTORY_INVOICE_LINE_NON_CASH"));
assert.ok(finance.cash.expenses.every((item) => !item.sourceType.endsWith("NON_CASH")), "Store Credit never becomes a cash outflow");
assert.equal(finance.dailySummary.expenses, 0, "inventory purchases remain outside operating expenses and COGS");
const linkedInvoice = finance.invoices.find((item) => item.id === "invoice-partial");
assert.equal(linkedInvoice?.fileUrl, "/api/inventory-intake/invoice-partial/file?index=0");
assert.deepEqual(linkedInvoice?.payments.map((payment) => payment.last4), ["7706", null]);
const invoiceHead = await worker.fetch(new Request("http://local.test/api/inventory-intake/invoice-partial/file?index=0", { method: "HEAD" }), env, ctx);
assert.equal(invoiceHead.status, 200);
assert.equal(invoiceHead.headers.get("content-type"), "application/pdf");
assert.equal(invoiceHead.headers.get("cache-control"), "private, no-store");
assert.equal(Number(invoiceHead.headers.get("content-length")), invoiceBytes.byteLength);
const invoiceFile = await worker.fetch(new Request("http://local.test/api/inventory-intake/invoice-partial/file?index=0"), env, ctx);
assert.equal(invoiceFile.status, 200);
assert.deepEqual(Buffer.from(await invoiceFile.arrayBuffer()), Buffer.from(invoiceBytes));

DB.close();
console.log("Invoice finance: partial recognition, invoice file link, personal exclusion, reversals, reprocessing, split payments and idempotency passed");
