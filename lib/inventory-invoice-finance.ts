type Row = Record<string, unknown>;

const LINE_PAYMENT = "INVENTORY_INVOICE_LINE_PAYMENT";
const LINE_NON_CASH = "INVENTORY_INVOICE_LINE_NON_CASH";
const LEGACY_PAYMENT = "INVENTORY_INVOICE_PAYMENT";
const LEGACY_NON_CASH = "INVENTORY_INVOICE_NON_CASH";

function object(value: unknown): Row {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Row;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {};
  } catch { return {}; }
}

function centsFromEvidence(row: Row) {
  const evidence = object(row.fieldEvidence ?? row.field_evidence_json);
  const net = object(evidence.net_line_cost);
  const value = Number(net.value);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : 0;
}

function quantity(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function allocate(total: number, weights: number[]) {
  const sum = weights.reduce((value, weight) => value + weight, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => total * weight / sum);
  const result = exact.map(Math.floor);
  let remaining = total - result.reduce((value, item) => value + item, 0);
  exact.map((value, index) => ({ index, residue: value - result[index] }))
    .sort((a, b) => b.residue - a.residue || a.index - b.index)
    .forEach(({ index }) => { if (remaining > 0) { result[index] += 1; remaining -= 1; } });
  return result;
}

function moneyMinor(value: unknown, currency: string) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * (currency === "CRC" ? 1 : 100)) : 0;
}

function text(value: unknown, maximum = 250) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maximum) : "";
}

export function financialPostingDate(timestamp: string) {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return timestamp.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Costa_Rica",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

export function isInvoiceNonCash(sourceType: string) {
  return sourceType === LINE_NON_CASH || sourceType === LEGACY_NON_CASH;
}

async function invoiceDetails(db: D1Database, document: Row) {
  if (String(document.processing_mode) !== "chatgpt_import" || !document.active_analysis_id) return null;
  const analysis = await db.prepare("SELECT extraction_json FROM invoice_ai_analyses WHERE id=? LIMIT 1")
    .bind(String(document.active_analysis_id)).first<Row>();
  if (!analysis) return null;
  const extraction = object(analysis.extraction_json);
  const invoice = object(extraction.invoice);
  const payments = Array.isArray(extraction.payments)
    ? extraction.payments.filter((item): item is Row => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
  const currency = text(invoice.currency || payments[0]?.currency || "USD", 3).toUpperCase();
  if (!payments.length || !["USD", "CRC"].includes(currency)) return null;
  const settings = await db.prepare("SELECT exchange_rate_crc FROM settings WHERE id=1").first<Row>();
  return {
    invoice,
    payments,
    currency,
    exchangeRate: currency === "CRC" ? 1 : Math.max(1, Math.round(Number(settings?.exchange_rate_crc || 520))),
  };
}

async function activeInventoryQuantity(db: D1Database, lineId: string) {
  const row = await db.prepare(`SELECT COALESCE(SUM(m.quantity_change),0) AS quantity
    FROM inventory_movements m JOIN inventory_operations o ON o.id=m.operation_id
    WHERE m.document_line_id=? AND o.status='completed'`).bind(lineId).first<Row>();
  return Math.max(0, quantity(row?.quantity));
}

async function activeRecognizedMinor(db: D1Database, documentId: string, lineId: string) {
  const row = await db.prepare(`SELECT COALESCE(SUM(e.original_amount_minor),0) AS total
    FROM finance_expenses e
    WHERE e.entry_type='EXPENSE' AND e.source_type IN (?,?) AND instr(e.source_id, ?) = 1
      AND NOT EXISTS (SELECT 1 FROM finance_expenses r WHERE r.reverses_expense_id=e.id)`)
    .bind(LINE_PAYMENT, LINE_NON_CASH, `${documentId}:${lineId}:`).first<Row>();
  return Math.max(0, quantity(row?.total));
}

function statementFor(
  db: D1Database,
  details: NonNullable<Awaited<ReturnType<typeof invoiceDetails>>>,
  document: Row,
  line: Row,
  operationId: string,
  now: string,
  amountMinor: number,
  payment: Row,
  paymentIndex: number,
) {
  if (amountMinor <= 0) return null;
  const cashAffecting = payment.cash_affecting !== false;
  const sourceType = cashAffecting ? LINE_PAYMENT : LINE_NON_CASH;
  const sourceId = `${String(document.id)}:${String(line.id)}:${operationId}:payment:${paymentIndex}`;
  const method = ["CASH", "SINPE", "CARD", "OTHER"].includes(String(payment.normalized_method)) ? String(payment.normalized_method) : "OTHER";
  const last4 = /^\d{4}$/.test(String(payment.last4 || "")) ? ` · terminación ${String(payment.last4)}` : "";
  const invoiceReference = text(document.invoice_number || document.order_number || "Factura", 160);
  const documentDate = text(document.document_date || details.invoice.purchase_date, 30);
  const amountCrc = details.currency === "CRC" ? amountMinor : Math.round((amountMinor / 100) * details.exchangeRate);
  return db.prepare(`INSERT OR IGNORE INTO finance_expenses (
    id,expense_date,category,description,amount_crc,original_amount_minor,currency,exchange_rate_crc,payment_method,
    provider,notes,route_id,order_id,source_type,source_id,idempotency_key,entry_type,reverses_expense_id,business_scope,created_at
  ) VALUES (?,?, 'INVENTORY_PURCHASE',?,?,?,?,?,?, ?,?,NULL,NULL,?,?,?,'EXPENSE',NULL,'BUSINESS',?)`).bind(
    `expense-invoice-${crypto.randomUUID()}`, financialPostingDate(now), `Compra de inventario · ${invoiceReference}`,
    amountCrc, amountMinor, details.currency, details.exchangeRate, method, String(document.provider || "Proveedor"),
    `Factura ${invoiceReference}${documentDate ? ` · fecha factura ${documentDate}` : ""} · ${String(payment.payment_method || "No especificado")}${last4}. Compra de inventario reconocida solo por esta línea confirmada.`,
    sourceType, sourceId, `invoice-line-payment:${sourceId}`, now,
  );
}

/** Posts only the net commercial portion newly recognized by this inventory operation. */
export async function invoiceFinanceStatements(
  db: D1Database,
  document: Row,
  confirmedLines: Row[],
  now: string,
  operationId = `legacy-${String(document.id)}`,
) {
  const details = await invoiceDetails(db, document);
  if (!details) return [] as D1PreparedStatement[];
  const paymentWeights = details.payments.map((payment) => moneyMinor(payment.amount, details.currency));
  if (!paymentWeights.some(Boolean)) return [] as D1PreparedStatement[];
  const statements: D1PreparedStatement[] = [];
  for (const line of confirmedLines) {
    if (String(line.action) === "ignore" || String(line.status) === "ignored") continue;
    const lineId = text(line.id, 160);
    const fullQuantity = quantity(line.originalTotal ?? line.original_quantity ?? line.total_to_add);
    const requestedQuantity = quantity(line.totalToAdd ?? line.total_to_add ?? line.requestedQuantity);
    const totalMinor = centsFromEvidence(line);
    if (!lineId || fullQuantity <= 0 || totalMinor <= 0) continue;
    const currentInventory = await activeInventoryQuantity(db, lineId);
    const activeFinancial = await activeRecognizedMinor(db, String(document.id), lineId);
    const explicitTargetQuantity = line.financialTargetQuantity == null ? null : quantity(line.financialTargetQuantity);
    const targetQuantity = explicitTargetQuantity == null
      ? Math.min(fullQuantity, currentInventory + requestedQuantity)
      : Math.min(fullQuantity, explicitTargetQuantity);
    const newlyRecognized = Math.round(totalMinor * targetQuantity / fullQuantity) - activeFinancial;
    if (newlyRecognized <= 0) continue;
    const allocations = allocate(newlyRecognized, paymentWeights);
    details.payments.forEach((payment, paymentIndex) => {
      const statement = statementFor(db, details, document, line, operationId, now, allocations[paymentIndex], payment, paymentIndex);
      if (statement) statements.push(statement);
    });
  }
  return statements;
}

function reversalStatement(db: D1Database, original: Row, reversalOperationId: string, reason: string, now: string) {
  return db.prepare(`INSERT OR IGNORE INTO finance_expenses (
    id,expense_date,category,description,amount_crc,original_amount_minor,currency,exchange_rate_crc,payment_method,
    provider,notes,route_id,order_id,source_type,source_id,idempotency_key,entry_type,reverses_expense_id,business_scope,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'REVERSAL',?,?,?)`).bind(
    `expense-invoice-reversal-${crypto.randomUUID()}`, financialPostingDate(now), String(original.category),
    `Reversa: ${String(original.description)}`, Number(original.amount_crc), Number(original.original_amount_minor),
    String(original.currency), Number(original.exchange_rate_crc), String(original.payment_method), original.provider || null,
    reason, original.route_id || null, original.order_id || null, "INVENTORY_INVOICE_LINE_REVERSAL",
    `${reversalOperationId}:${String(original.id)}`, `invoice-line-reversal:${reversalOperationId}:${String(original.id)}`,
    String(original.id), String(original.business_scope || "BUSINESS"), now,
  );
}

/** Creates exactly one linked ledger reversal for each original invoice line posting. */
export async function invoiceFinanceReversalStatements(db: D1Database, originalOperationId: string, reversalOperationId: string, reason: string, now: string) {
  const originals = await db.prepare(`SELECT * FROM finance_expenses e
    WHERE e.entry_type='EXPENSE' AND e.source_type IN (?,?) AND instr(e.source_id, ?) > 0
      AND NOT EXISTS (SELECT 1 FROM finance_expenses r WHERE r.reverses_expense_id=e.id)`)
    .bind(LINE_PAYMENT, LINE_NON_CASH, `:${originalOperationId}:payment:`).all<Row>();
  return originals.results.map((original) => reversalStatement(db, original, reversalOperationId, reason, now));
}

/** Reconciles pre-v2.26 document-wide postings without rewriting ledger history. */
export async function reconcileInventoryInvoicePayments(db: D1Database) {
  const legacy = await db.prepare(`SELECT * FROM finance_expenses e
    WHERE e.entry_type='EXPENSE' AND e.source_type IN (?,?)
      AND NOT EXISTS (SELECT 1 FROM finance_expenses r WHERE r.reverses_expense_id=e.id)
    ORDER BY e.created_at,e.id LIMIT 200`).bind(LEGACY_PAYMENT, LEGACY_NON_CASH).all<Row>();
  const statements: D1PreparedStatement[] = [];
  const seenDocuments = new Set<string>();
  const now = new Date().toISOString();
  for (const original of legacy.results) {
    const documentId = String(original.source_id || "").split(":payment:")[0];
    if (!documentId) continue;
    if (!seenDocuments.has(documentId)) {
      seenDocuments.add(documentId);
      const document = await db.prepare("SELECT * FROM inventory_documents WHERE id=? LIMIT 1").bind(documentId).first<Row>();
      if (document) {
        const lines = await db.prepare(`SELECT l.*,COALESCE((SELECT SUM(m.quantity_change) FROM inventory_movements m
          JOIN inventory_operations o ON o.id=m.operation_id WHERE m.document_line_id=l.id AND o.status='completed'),0) AS active_quantity
          FROM inventory_document_lines l WHERE l.document_id=?`).bind(documentId).all<Row>();
        statements.push(...await invoiceFinanceStatements(db, document, lines.results.map((line) => ({
          ...line,
          financialTargetQuantity: Math.max(0, quantity(line.active_quantity)),
        })), now, `legacy-reconcile-${documentId}`));
      }
    }
    statements.push(reversalStatement(db, original, `legacy-reconcile-${documentId}`, "Corrección trazable: la compra se reconoce por las líneas de inventario activas.", now));
  }
  if (statements.length) await db.batch(statements);
}

export const invoiceFinanceSourceTypes = { LINE_PAYMENT, LINE_NON_CASH, LEGACY_PAYMENT, LEGACY_NON_CASH };
