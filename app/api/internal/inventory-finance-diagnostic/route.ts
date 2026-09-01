import { ensureDatabase, getD1 } from "@/db";

type Row = Record<string, unknown>;

const DOCUMENT_NUMBER = "946154186";
const LINE_KEY = "chatgpt-import-2";
const PRODUCT_ID = 1174;
const SOURCE_TYPES = ["INVENTORY_INVOICE_LINE_PAYMENT", "INVENTORY_INVOICE_LINE_NON_CASH"] as const;

const CURRENT_QUERY = `SELECT COALESCE(SUM(e.original_amount_minor),0) AS total
  FROM finance_expenses e
  WHERE e.entry_type='EXPENSE'
    AND e.source_type IN (?,?)
    AND e.source_id LIKE ?
    AND NOT EXISTS (
      SELECT 1 FROM finance_expenses r WHERE r.reverses_expense_id=e.id
    )`;

const LEFT_JOIN_QUERY = `SELECT COALESCE(SUM(e.original_amount_minor),0) AS total
  FROM finance_expenses e
  LEFT JOIN finance_expenses r ON r.reverses_expense_id=e.id
  WHERE e.entry_type='EXPENSE'
    AND e.source_type IN (?,?)
    AND e.source_id LIKE ?
    AND r.id IS NULL`;

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "Unknown D1 error");
  return message.replace(/\s+/g, " ").slice(0, 1200);
}

async function checkedTotal(db: D1Database, sql: string, bindings: string[]) {
  try {
    const row = await db.prepare(sql).bind(...bindings).first<Row>();
    return { status: "PASS" as const, total: Number(row?.total || 0) };
  } catch (error) {
    return { status: "FAIL" as const, error: errorMessage(error) };
  }
}

/**
 * Temporary owner-only production probe for one fixed invoice line.
 * It accepts no input and only executes SELECT statements.
 */
export async function GET() {
  await ensureDatabase();
  const db = getD1();
  const target = await db.prepare(`SELECT d.id AS document_id,l.id AS line_id
    FROM inventory_documents d
    JOIN inventory_document_lines l ON l.document_id=d.id
    WHERE d.order_number=? AND l.line_key=? AND l.match_product_id=?
    LIMIT 1`).bind(DOCUMENT_NUMBER, LINE_KEY, PRODUCT_ID).first<Row>();

  if (!target) {
    return Response.json({ status: "TARGET_NOT_FOUND" }, { status: 404 });
  }

  const pattern = `${String(target.document_id)}:${String(target.line_id)}:%`;
  const bindings = [SOURCE_TYPES[0], SOURCE_TYPES[1], pattern];
  const [current, leftJoin, matchingRows, sumWithoutReversalExclusion, relatedReversals] = await Promise.all([
    checkedTotal(db, CURRENT_QUERY, bindings),
    checkedTotal(db, LEFT_JOIN_QUERY, bindings),
    checkedTotal(db, `SELECT COUNT(*) AS total FROM finance_expenses
      WHERE entry_type='EXPENSE' AND source_type IN (?,?) AND source_id LIKE ?`, bindings),
    checkedTotal(db, `SELECT COALESCE(SUM(original_amount_minor),0) AS total FROM finance_expenses
      WHERE entry_type='EXPENSE' AND source_type IN (?,?) AND source_id LIKE ?`, bindings),
    checkedTotal(db, `SELECT COUNT(*) AS total FROM finance_expenses r
      JOIN finance_expenses e ON r.reverses_expense_id=e.id
      WHERE e.entry_type='EXPENSE' AND e.source_type IN (?,?) AND e.source_id LIKE ?`, bindings),
  ]);

  return Response.json({
    target: "invoice-946154186-line-chatgpt-import-2-product-1174",
    current,
    leftJoin,
    controls: { matchingRows, sumWithoutReversalExclusion, relatedReversals },
  });
}
