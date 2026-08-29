type Row = Record<string, unknown>;

function centsFromEvidence(row: Row) {
  try {
    const evidence = JSON.parse(String(row.field_evidence_json || "{}")) as Row;
    const net = evidence.net_line_cost as Row | undefined;
    const value = Number(net?.value);
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : 0;
  } catch { return 0; }
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

export async function invoiceFinanceStatements(
  db: D1Database,
  document: Row,
  documentLines: Row[],
  now: string,
) {
  if (String(document.processing_mode) !== "chatgpt_import" || !document.active_analysis_id) return [] as D1PreparedStatement[];
  const analysis = await db.prepare("SELECT extraction_json FROM invoice_ai_analyses WHERE id=? LIMIT 1")
    .bind(String(document.active_analysis_id)).first<Row>();
  if (!analysis) return [] as D1PreparedStatement[];
  let extraction: Row;
  try { extraction = JSON.parse(String(analysis.extraction_json || "{}")) as Row; }
  catch { return [] as D1PreparedStatement[]; }
  const invoice = extraction.invoice && typeof extraction.invoice === "object" ? extraction.invoice as Row : {};
  const payments = Array.isArray(extraction.payments) ? extraction.payments.filter((item): item is Row => Boolean(item && typeof item === "object")) : [];
  const currency = String(invoice.currency || payments[0]?.currency || "USD").toUpperCase();
  const invoiceTotalMinor = Math.round(Number(invoice.total || 0) * (currency === "CRC" ? 1 : 100));
  if (!payments.length || invoiceTotalMinor <= 0) return [] as D1PreparedStatement[];
  const businessProductCents = documentLines.filter((line) => String(line.status) !== "ignored" && String(line.action) !== "ignore")
    .reduce((sum, line) => sum + centsFromEvidence(line), 0);
  if (businessProductCents <= 0) return [] as D1PreparedStatement[];
  const rawWeights = payments.map((payment) => Math.max(0, Math.round(Number(payment.amount || 0) * (currency === "CRC" ? 1 : 100))));
  const businessMinor = currency === "CRC" ? Math.round(businessProductCents / 100) : businessProductCents;
  const allocations = allocate(businessMinor, rawWeights);
  const settings = await db.prepare("SELECT exchange_rate_crc FROM settings WHERE id=1").first<Row>();
  const exchangeRate = currency === "CRC" ? 1 : Math.max(1, Math.round(Number(settings?.exchange_rate_crc || 520)));
  const date = financialPostingDate(String(document.confirmed_at || now));
  const provider = String(document.provider || "Proveedor");
  return payments.flatMap((payment, index) => {
    const originalMinor = allocations[index];
    if (originalMinor <= 0) return [];
    const method = ["CASH", "SINPE", "CARD", "OTHER"].includes(String(payment.normalized_method)) ? String(payment.normalized_method) : "OTHER";
    const cashAffecting = payment.cash_affecting !== false;
    const sourceType = cashAffecting ? "INVENTORY_INVOICE_PAYMENT" : "INVENTORY_INVOICE_NON_CASH";
    const sourceId = `${String(document.id)}:payment:${index}`;
    const last4 = /^\d{4}$/.test(String(payment.last4 || "")) ? ` · terminación ${String(payment.last4)}` : "";
    const amountCrc = currency === "CRC" ? originalMinor : Math.round((originalMinor / 100) * exchangeRate);
    const id = `expense-invoice-${crypto.randomUUID()}`;
    return [db.prepare(`INSERT OR IGNORE INTO finance_expenses (
      id,expense_date,category,description,amount_crc,original_amount_minor,currency,exchange_rate_crc,payment_method,
      provider,notes,route_id,order_id,source_type,source_id,idempotency_key,entry_type,reverses_expense_id,business_scope,created_at
    ) VALUES (?,?, 'INVENTORY_PURCHASE',?,?,?,?,?,?, ?,?,NULL,NULL,?,?,?,'EXPENSE',NULL,'BUSINESS',?)`).bind(
      id, date, `Compra de inventario · ${String(document.invoice_number || document.order_number || "Factura")}`,
      amountCrc, originalMinor, currency, exchangeRate, method, provider,
      `${String(payment.payment_method || "No especificado")}${last4}. Importe comercial; las líneas omitidas permanecen conciliadas pero excluidas.`,
      sourceType, sourceId, `invoice-payment:${sourceId}`, now,
    ), db.prepare(`UPDATE finance_expenses SET expense_date=?
      WHERE source_id=? AND source_type IN ('INVENTORY_INVOICE_PAYMENT','INVENTORY_INVOICE_NON_CASH')
        AND entry_type='EXPENSE' AND expense_date<>?`)
      .bind(date, sourceId, date)];
  });
}

export async function reconcileInventoryInvoicePayments(db: D1Database) {
  const documents = await db.prepare(`SELECT * FROM inventory_documents
    WHERE processing_mode='chatgpt_import' AND confirmed_at IS NOT NULL AND active_analysis_id IS NOT NULL
    ORDER BY confirmed_at DESC LIMIT 100`).all<Row>();
  const statements: D1PreparedStatement[] = [];
  for (const document of documents.results) {
    const lines = await db.prepare("SELECT * FROM inventory_document_lines WHERE document_id=? ORDER BY line_index,id")
      .bind(String(document.id)).all<Row>();
    statements.push(...await invoiceFinanceStatements(db, document, lines.results, String(document.confirmed_at)));
  }
  if (statements.length) await db.batch(statements);
}
