import { getD1 } from "@/db";

type Row = Record<string, unknown>;
type Probe = { status: "PASS"; value: string | number } | { status: "FAIL"; error: string };

const DOCUMENT_PREFIX = "doc-deb6fd67-%";

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

function normalizedValue(value: unknown, exposeLiteral = false): string | number {
  if (typeof value === "number") return Number.isFinite(value) ? value : "NON_FINITE";
  if (exposeLiteral && typeof value === "string") return value;
  if (value == null) return "NULL";
  return typeof value === "string" && value.length === 0 ? "EMPTY" : "NON_NULL";
}

async function probe(db: D1Database, sql: string, bindings: unknown[] = [], exposeLiteral = false): Promise<Probe> {
  try {
    // Each probe creates and executes a new statement. Empty bindings intentionally skip .bind().
    const statement = bindings.length ? db.prepare(sql).bind(...bindings) : db.prepare(sql);
    const row = await statement.first<Row>();
    return { status: "PASS", value: normalizedValue(row?.value, exposeLiteral) };
  } catch (error) {
    return { status: "FAIL", error: errorCode(error) };
  }
}

async function firstExistingSourceId(db: D1Database) {
  try {
    const row = await db.prepare("SELECT source_id FROM finance_expenses WHERE source_id IS NOT NULL LIMIT 1").first<Row>();
    const sourceId = typeof row?.source_id === "string" && row.source_id.length ? row.source_id : null;
    return { status: "PASS" as const, sourceId };
  } catch (error) {
    return { status: "FAIL" as const, error: errorCode(error) };
  }
}

/**
 * Temporary owner-only production probe. It accepts no input and runs only fixed SELECT statements.
 * It intentionally avoids ensureDatabase() because that normal-app initializer may issue compatibility DDL.
 */
export async function GET() {
  const db = getD1();

  const results = {
    runtime: await probe(db, "SELECT 1 AS value"),
    binding: await probe(db, "SELECT ? AS value", ["ok"], true),
    settingsCount: await probe(db, "SELECT COUNT(*) AS value FROM settings"),
    financeExpensesCount: await probe(db, "SELECT COUNT(*) AS value FROM finance_expenses"),
    columns: {
      id: await probe(db, "SELECT id AS value FROM finance_expenses LIMIT 1"),
      originalAmountMinor: await probe(db, "SELECT original_amount_minor AS value FROM finance_expenses LIMIT 1"),
      entryType: await probe(db, "SELECT entry_type AS value FROM finance_expenses LIMIT 1"),
      sourceType: await probe(db, "SELECT source_type AS value FROM finance_expenses LIMIT 1"),
      sourceId: await probe(db, "SELECT source_id AS value FROM finance_expenses LIMIT 1"),
      reversesExpenseId: await probe(db, "SELECT reverses_expense_id AS value FROM finance_expenses LIMIT 1"),
    },
    simpleSum: await probe(db, "SELECT COALESCE(SUM(original_amount_minor),0) AS value FROM finance_expenses"),
    individualPredicates: {
      entryType: await probe(db, "SELECT COUNT(*) AS value FROM finance_expenses WHERE entry_type='EXPENSE'"),
      sourceType: await probe(db, "SELECT COUNT(*) AS value FROM finance_expenses WHERE source_type='INVENTORY_INVOICE_LINE_PAYMENT'"),
      sourcePrefix: await probe(db, `SELECT COUNT(*) AS value FROM finance_expenses WHERE source_id LIKE '${DOCUMENT_PREFIX}'`),
    },
    sourceIdFilter: {
      literalLike: await probe(db, `SELECT COUNT(*) AS value FROM finance_expenses WHERE source_id LIKE '${DOCUMENT_PREFIX}'`),
      boundLike: await probe(db, "SELECT COUNT(*) AS value FROM finance_expenses WHERE source_id LIKE ?", [DOCUMENT_PREFIX]),
    },
  };

  const existingSource = await firstExistingSourceId(db);
  const exactBound = existingSource.status === "PASS" && existingSource.sourceId
    ? await probe(db, "SELECT COUNT(*) AS value FROM finance_expenses WHERE source_id = ?", [existingSource.sourceId])
    : existingSource.status === "FAIL"
      ? { status: "FAIL" as const, error: existingSource.error }
      : { status: "FAIL" as const, error: "NO_EXISTING_SOURCE_ID" };

  return Response.json({
    target: "finance-expenses-minimal-read-only-probe",
    d1Binding: "DB",
    harness: "fresh-statement-and-try-catch-per-query; sequential; no-input; no-ddl; select-only",
    ...results,
    sourceIdFilter: { ...results.sourceIdFilter, exactBound },
  });
}
