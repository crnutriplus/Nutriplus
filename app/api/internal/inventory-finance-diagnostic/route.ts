import { getD1 } from "@/db";

type Row = Record<string, unknown>;
type Probe = { status: "PASS"; value: string | number } | { status: "FAIL"; error: string };
type Target = { status: "PASS"; documentId: string; lineId: string } | { status: "FAIL"; error: string };

const DOCUMENT_NUMBER = "946154186";
const LINE_KEY = "chatgpt-import-2";
const PRODUCT_ID = 1174;
const LINE_PAYMENT = "INVENTORY_INVOICE_LINE_PAYMENT";
const LINE_NON_CASH = "INVENTORY_INVOICE_LINE_NON_CASH";

function errorCode(error: unknown) {
  // Keep D1 messages and SQL out of the response, even on the private site.
  const message = error instanceof Error ? error.message : String(error || "");
  if (/wrong number of parameter bindings/i.test(message)) return "WRONG_NUMBER_OF_BINDINGS";
  if (/no such column/i.test(message)) return "NO_SUCH_COLUMN";
  if (/no such table/i.test(message)) return "NO_SUCH_TABLE";
  if (/syntax error/i.test(message)) return "SQLITE_SYNTAX_ERROR";
  if (/datatype mismatch/i.test(message)) return "SQLITE_DATATYPE_MISMATCH";
  if (/SQLITE_ERROR/i.test(message)) return "SQLITE_ERROR";
  if (/D1_ERROR/i.test(message)) return "D1_ERROR";
  return "UNCLASSIFIED_D1_ERROR";
}

function normalizedValue(value: unknown): string | number {
  if (typeof value === "number") return Number.isFinite(value) ? value : "NON_FINITE";
  if (value == null) return "NULL";
  return typeof value === "string" && value.length === 0 ? "EMPTY" : "NON_NULL";
}

async function probe(db: D1Database, sql: string, bindings: string[] = []): Promise<Probe> {
  try {
    // Every probe creates a fresh statement and catches only its own execution error.
    const statement = bindings.length ? db.prepare(sql).bind(...bindings) : db.prepare(sql);
    const row = await statement.first<Row>();
    return { status: "PASS", value: normalizedValue(row?.value) };
  } catch (error) {
    return { status: "FAIL", error: errorCode(error) };
  }
}

async function resolveFixedTarget(db: D1Database): Promise<Target> {
  try {
    const row = await db.prepare(`SELECT d.id AS document_id,l.id AS line_id
      FROM inventory_documents d
      JOIN inventory_document_lines l ON l.document_id=d.id
      WHERE d.order_number=? AND l.line_key=? AND l.match_product_id=?
      LIMIT 1`).bind(DOCUMENT_NUMBER, LINE_KEY, PRODUCT_ID).first<Row>();
    if (typeof row?.document_id !== "string" || typeof row?.line_id !== "string") {
      return { status: "FAIL", error: "TARGET_NOT_FOUND" };
    }
    return { status: "PASS", documentId: row.document_id, lineId: row.line_id };
  } catch (error) {
    return { status: "FAIL", error: errorCode(error) };
  }
}

/**
 * Temporary owner-only composition probe. It accepts no input and runs only fixed SELECT statements.
 * It intentionally avoids ensureDatabase() because that normal-app initializer may issue compatibility DDL.
 */
export async function GET() {
  const db = getD1();
  const target = await resolveFixedTarget(db);
  if (target.status === "FAIL") return Response.json({ target, d1Binding: "DB" }, { status: 500 });

  const pattern = `${target.documentId}:${target.lineId}:%`;
  const sourceTypes = [LINE_PAYMENT, LINE_NON_CASH];
  const sourceTypeAndPattern = [...sourceTypes, pattern];

  const composition = {
    inTwoBinds: await probe(db, "SELECT COUNT(*) AS value FROM finance_expenses WHERE source_type IN (?,?)", sourceTypes),
    entryTypeAndIn: await probe(db, "SELECT COUNT(*) AS value FROM finance_expenses WHERE entry_type='EXPENSE' AND source_type IN (?,?)", sourceTypes),
    entryTypeInLike: await probe(db, "SELECT COUNT(*) AS value FROM finance_expenses WHERE entry_type='EXPENSE' AND source_type IN (?,?) AND source_id LIKE ?", sourceTypeAndPattern),
    entryTypeOrLike: await probe(db, "SELECT COUNT(*) AS value FROM finance_expenses WHERE entry_type='EXPENSE' AND (source_type=? OR source_type=?) AND source_id LIKE ?", sourceTypeAndPattern),
    completeNotExistsCount: await probe(db, `SELECT COUNT(*) AS value FROM finance_expenses e
      WHERE e.entry_type='EXPENSE' AND e.source_type IN (?,?) AND e.source_id LIKE ?
      AND NOT EXISTS (SELECT 1 FROM finance_expenses r WHERE r.reverses_expense_id=e.id)`, sourceTypeAndPattern),
    minimalNotExistsCount: await probe(db, `SELECT COUNT(*) AS value FROM finance_expenses e
      WHERE NOT EXISTS (SELECT 1 FROM finance_expenses r WHERE r.reverses_expense_id=e.id)`),
    completeNotExistsSum: await probe(db, `SELECT COALESCE(SUM(e.original_amount_minor),0) AS value FROM finance_expenses e
      WHERE e.entry_type='EXPENSE' AND e.source_type IN (?,?) AND e.source_id LIKE ?
      AND NOT EXISTS (SELECT 1 FROM finance_expenses r WHERE r.reverses_expense_id=e.id)`, sourceTypeAndPattern),
  };

  return Response.json({
    target: "invoice-946154186-line-chatgpt-import-2-product-1174",
    d1Binding: "DB",
    harness: "fresh-statement-and-try-catch-per-query; sequential; no-input; no-ddl; select-only",
    composition,
  });
}
