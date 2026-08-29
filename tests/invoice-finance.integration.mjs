import assert from "node:assert/strict";
import { LocalD1Database } from "./helpers/local-bindings.mjs";
import { invoiceFinanceStatements } from "../lib/inventory-invoice-finance.ts";

const DB = new LocalD1Database();
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("invoiceFinance", `${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
await worker.fetch(new Request("http://local.test/api/settings"), { DB, ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });

const extraction = {
  invoice: { currency: "USD", total: 141.02 },
  payment_status: "PAID",
  payments: [
    { payment_method: "American Express", normalized_method: "CARD", amount: 127.82, currency: "USD", last4: "7706", cash_affecting: true },
    { payment_method: "Store Credit", normalized_method: "OTHER", amount: 13.20, currency: "USD", last4: null, cash_affecting: false },
  ],
};
DB.sqlite.prepare(`INSERT INTO inventory_documents (
  id,file_fingerprint,file_name,mime_types_json,provider,invoice_number,document_date,page_count,file_count,processing_mode,
  analysis_status,active_analysis_id,field_evidence_json,status,warnings_json
) VALUES ('invoice-auto-paid','fp-auto-paid','invoice.pdf','["application/pdf"]','iherb','946971969','2026-08-29',1,1,'chatgpt_import','completed','analysis-auto-paid','{}','draft','[]')`).run();
DB.sqlite.prepare(`INSERT INTO invoice_ai_analyses (
  id,document_id,file_fingerprint,analysis_number,model,analysis_origin,api_calls,status,extraction_json
) VALUES ('analysis-auto-paid','invoice-auto-paid','fp-auto-paid',1,'ChatGPT Import','CHATGPT_IMPORT',0,'completed',?)`).run(JSON.stringify(extraction));
const evidence = (net) => JSON.stringify({ net_line_cost: { value: net.toFixed(2), source: "chatgpt_import" } });
DB.sqlite.prepare(`INSERT INTO inventory_document_lines (id,document_id,line_key,original_description,name,field_evidence_json,status,action)
  VALUES ('business-line','invoice-auto-paid','business','Negocio','Negocio',?,'confirmed','existing')`).run(evidence(70));
DB.sqlite.prepare(`INSERT INTO inventory_document_lines (id,document_id,line_key,original_description,name,field_evidence_json,status,action)
  VALUES ('personal-line','invoice-auto-paid','personal','Personal','Personal',?,'ignored','ignore')`).run(evidence(30));

const document = DB.sqlite.prepare("SELECT * FROM inventory_documents WHERE id='invoice-auto-paid'").get();
const lines = DB.sqlite.prepare("SELECT * FROM inventory_document_lines WHERE document_id='invoice-auto-paid'").all();
const statements = await invoiceFinanceStatements(DB, document, lines, "2026-08-29T12:00:00.000Z");
await DB.batch(statements);
await DB.batch(await invoiceFinanceStatements(DB, document, lines, "2026-08-29T12:00:01.000Z"));
const expenses = DB.sqlite.prepare("SELECT * FROM finance_expenses WHERE source_id LIKE 'invoice-auto-paid:payment:%' ORDER BY source_id").all();
assert.equal(expenses.length, 2);
assert.equal(expenses.reduce((sum, row) => sum + Number(row.original_amount_minor), 0), 7000);
assert.equal(expenses[0].payment_method, "CARD");
assert.match(expenses[0].notes, /7706/);
assert.equal(expenses[1].source_type, "INVENTORY_INVOICE_NON_CASH");
assert.ok(!expenses[0].notes.includes("American Express x7706") || !/\d{12,}/.test(expenses[0].notes));

DB.close();
console.log("Invoice finance: automatic paid status, split methods, safe last4, personal exclusion and retry idempotency passed");
