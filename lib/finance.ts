import { newOrderChildId } from "./orders";
import { isInvoiceNonCash, reconcileInventoryInvoicePayments } from "./inventory-invoice-finance";

type Row = Record<string, unknown>;

export const FINANCE_CATEGORIES = [
  "FUEL",
  "TOLLS",
  "SUPPLIES",
  "ADVERTISING",
  "COURIER",
  "SOFTWARE",
  "BANK_FEES",
  "INVENTORY_PURCHASE",
  "OTHER",
] as const;

export const FINANCE_CATEGORY_LABELS: Record<(typeof FINANCE_CATEGORIES)[number], string> = {
  FUEL: "Combustible",
  TOLLS: "Peajes",
  SUPPLIES: "Insumos",
  ADVERTISING: "Publicidad / Meta Ads",
  COURIER: "Casillero / courier",
  SOFTWARE: "Software y suscripciones",
  BANK_FEES: "Comisiones bancarias / pagos",
  INVENTORY_PURCHASE: "Compra de inventario/productos",
  OTHER: "Otros",
};

const PAYMENT_METHODS = ["CASH", "SINPE", "CARD", "OTHER"] as const;
const FREQUENCIES = ["WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"] as const;

export class FinanceError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "FINANCE_INVALID_REQUEST",
    public title = "No pudimos completar el movimiento",
    public details: Record<string, unknown> = {},
  ) { super(message); }
}

export function financeErrorResponse(error: unknown) {
  if (error instanceof FinanceError) {
    return Response.json({ error: error.message, title: error.title, code: error.code, ...error.details }, { status: error.status });
  }
  const reference = crypto.randomUUID().slice(0, 8).toUpperCase();
  console.error("[FINANCE]", { code: "FINANCE_UNEXPECTED", reference, errorName: error instanceof Error ? error.name : typeof error });
  return Response.json({
    error: "No pudimos actualizar Finanzas por un problema temporal. Intentá nuevamente. No se creó ni duplicó ningún movimiento.",
    title: "Finanzas no disponible",
    code: "FINANCE_UNEXPECTED",
    reference,
  }, { status: 500 });
}

function text(value: unknown, maximum = 500) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maximum) : "";
}

function operationId(value: unknown) {
  const clean = text(value, 160);
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(clean)) {
    throw new FinanceError("La operación no tiene un identificador seguro. Volvé a intentarlo; no se creó ningún movimiento.", 400, "FINANCE_OPERATION_ID_INVALID", "Operación inválida");
  }
  return clean;
}

function date(value: unknown, label = "La fecha") {
  const clean = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean) || Number.isNaN(Date.parse(`${clean}T12:00:00Z`))) {
    throw new FinanceError(`${label} no es válida. Corregila; no se creó ningún movimiento.`, 400, "FINANCE_DATE_INVALID", "Fecha inválida");
  }
  return clean;
}

function positiveInteger(value: unknown, label: string, maximum = 1_000_000_000) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new FinanceError(`${label} debe ser un monto mayor que cero. Corregilo; no se creó ningún movimiento.`, 400, "FINANCE_AMOUNT_INVALID", "Monto inválido");
  }
  return number;
}

function category(value: unknown) {
  const clean = text(value, 40).toUpperCase();
  if (!FINANCE_CATEGORIES.includes(clean as (typeof FINANCE_CATEGORIES)[number])) {
    throw new FinanceError("Seleccioná una categoría de gasto válida. No se creó ningún movimiento.", 400, "FINANCE_CATEGORY_INVALID", "Categoría inválida");
  }
  return clean as (typeof FINANCE_CATEGORIES)[number];
}

function paymentMethod(value: unknown) {
  const clean = text(value, 20).toUpperCase();
  if (!PAYMENT_METHODS.includes(clean as (typeof PAYMENT_METHODS)[number])) {
    throw new FinanceError("Seleccioná un método de pago válido. No se creó ningún movimiento.", 400, "FINANCE_PAYMENT_METHOD_INVALID", "Método inválido");
  }
  return clean as (typeof PAYMENT_METHODS)[number];
}

function moneyMinor(value: unknown, label: string) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(clean)) throw new FinanceError(`${label} debe ser un monto positivo con máximo dos decimales. Corregilo; no se creó ningún movimiento.`, 400, "FINANCE_AMOUNT_INVALID", "Monto inválido");
  const [whole, decimals = ""] = clean.split(".");
  const minor = Number(whole) * 100 + Number(decimals.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new FinanceError(`${label} debe ser mayor que cero. Corregilo; no se creó ningún movimiento.`, 400, "FINANCE_AMOUNT_INVALID", "Monto inválido");
  return minor;
}

function expenseFromRow(row: Row) {
  return {
    id: String(row.id),
    date: String(row.expense_date),
    category: String(row.category),
    categoryLabel: FINANCE_CATEGORY_LABELS[String(row.category) as keyof typeof FINANCE_CATEGORY_LABELS] || String(row.category),
    description: String(row.description),
    amountCrc: Number(row.amount_crc),
    originalAmountMinor: Number(row.original_amount_minor),
    exactOriginalAmount: String(row.source_type) === "MANUAL_CRC_CENTS" ? Number(row.original_amount_minor) / 100 : String(row.currency) === "USD" ? Number(row.original_amount_minor) / 100 : Number(row.original_amount_minor),
    currency: String(row.currency),
    exchangeRateCrc: Number(row.exchange_rate_crc),
    paymentMethod: String(row.payment_method),
    provider: row.provider ? String(row.provider) : null,
    notes: row.notes ? String(row.notes) : null,
    routeId: row.route_id ? String(row.route_id) : null,
    orderId: row.order_id ? String(row.order_id) : null,
    sourceType: String(row.source_type),
    sourceId: row.source_id ? String(row.source_id) : null,
    entryType: String(row.entry_type),
    reversesExpenseId: row.reverses_expense_id ? String(row.reverses_expense_id) : null,
    businessScope: String(row.business_scope),
    createdAt: String(row.created_at),
  };
}

function saleId(sourceOperationId: string) {
  return `finance-sale:${sourceOperationId}`;
}

export function financeSaleStatements(db: D1Database, order: Row, lines: Row[], sourceOperationId: string, deliveredAt: string) {
  const id = saleId(sourceOperationId);
  const activeLines = lines.filter((line) => !line.removed_at);
  const costsComplete = activeLines.every((line) => line.historical_cost_snapshot != null);
  const cogs = costsComplete
    ? activeLines.reduce((sum, line) => sum + Number(line.historical_cost_snapshot) * Number(line.quantity), 0)
    : null;
  const productGross = Number(order.subtotal || 0);
  const discount = Number(order.discount_total || 0);
  const productNet = productGross - discount;
  const delivery = Number(order.delivery_fee || 0);
  const total = Number(order.total || productNet + delivery);
  const lineDiscountTotal = activeLines.reduce((sum, line) => sum + Number(line.discount_amount || 0), 0);
  let allocated = 0;
  const discountByLine = new Map(activeLines.map((line, index) => {
    const gross = Number(line.line_subtotal);
    const amount = lineDiscountTotal === discount
      ? Number(line.discount_amount || 0)
      : index === activeLines.length - 1 ? discount - allocated : Math.floor(productGross > 0 ? (discount * gross) / productGross : 0);
    allocated += amount;
    return [String(line.id), amount];
  }));
  const snapshot = { productGross, discount, productNet, delivery, total, cogs, costStatus: costsComplete ? "COMPLETE" : "MISSING" };
  return [
    db.prepare(`INSERT OR IGNORE INTO finance_sales (
      id,order_id,order_number,customer_name_snapshot,delivered_at,route_id,currency,product_gross_total,
      discount_total,product_net_total,delivery_income,total_income,historical_cogs_total,cost_status,
      source_operation_id,status,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'RECOGNIZED',?)`).bind(
      id, String(order.id), String(order.order_number), String(order.customer_name_snapshot), deliveredAt,
      order.route_id ? String(order.route_id) : null, String(order.currency || "CRC"), productGross, discount,
      productNet, delivery, total, cogs, costsComplete ? "COMPLETE" : "MISSING", sourceOperationId, deliveredAt,
    ),
    ...activeLines.map((line) => {
      const unitCost = line.historical_cost_snapshot == null ? null : Number(line.historical_cost_snapshot);
      const lineCogs = unitCost == null ? null : unitCost * Number(line.quantity);
      const lineDiscount = discountByLine.get(String(line.id)) || 0;
      const net = Number(line.line_subtotal) - lineDiscount;
      return db.prepare(`INSERT OR IGNORE INTO finance_sale_lines (
        id,sale_id,order_line_id,product_id,product_name_snapshot,quantity,unit_price_real,gross_income,
        allocated_discount,net_income,historical_unit_cost,historical_cogs,gross_profit,created_at
      ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM finance_sales WHERE id=?)`).bind(
        `${id}:${String(line.id)}`, id, String(line.id), line.product_id == null ? null : Number(line.product_id),
        String(line.product_name_snapshot), Number(line.quantity), Number(line.unit_price_sold), Number(line.line_subtotal),
        lineDiscount, net, unitCost, lineCogs, lineCogs == null ? null : net - lineCogs, deliveredAt, id,
      );
    }),
    db.prepare(`INSERT OR IGNORE INTO finance_sale_events (
      id,sale_id,event_type,source_operation_id,reason,previous_json,next_json,created_at
    ) SELECT ?,?,'RECOGNITION',?,NULL,'{}',?,? WHERE EXISTS (SELECT 1 FROM finance_sales WHERE id=?)`).bind(
      `${id}:recognition`, id, sourceOperationId, JSON.stringify(snapshot), deliveredAt, id,
    ),
  ];
}

export function financeSaleReversalStatements(db: D1Database, sale: Row, sourceOperationId: string, reason: string, reversedAt: string) {
  const previous = {
    productGross: Number(sale.product_gross_total),
    discount: Number(sale.discount_total),
    productNet: Number(sale.product_net_total),
    delivery: Number(sale.delivery_income),
    total: Number(sale.total_income),
    cogs: sale.historical_cogs_total == null ? null : Number(sale.historical_cogs_total),
    costStatus: String(sale.cost_status),
  };
  return [
    db.prepare("UPDATE finance_sales SET status='REVERSED',reversed_at=? WHERE id=? AND status='RECOGNIZED'").bind(reversedAt, String(sale.id)),
    db.prepare(`INSERT OR IGNORE INTO finance_sale_events (
      id,sale_id,event_type,source_operation_id,reason,previous_json,next_json,created_at
    ) VALUES (?,?,'REVERSAL',?,?,?,'{}',?)`).bind(
      newOrderChildId("financeevent"), String(sale.id), sourceOperationId, reason, JSON.stringify(previous), reversedAt,
    ),
  ];
}

export async function reconcileDeliveredSales(db: D1Database) {
  const missing = await db.prepare(`SELECT o.*,
    COALESCE((SELECT f.operation_id FROM order_fulfillments f WHERE f.order_id=o.id AND f.status='DELIVERED' ORDER BY f.delivered_at DESC,f.id DESC LIMIT 1),'') AS fulfillment_operation
    FROM orders o
    WHERE o.status='DELIVERED' AND NOT EXISTS (
      SELECT 1 FROM finance_sales fs WHERE fs.order_id=o.id AND fs.status='RECOGNIZED'
    ) ORDER BY o.delivered_at,o.id LIMIT 1000`).all<Row>();
  for (const order of missing.results) {
    const lines = await db.prepare("SELECT * FROM order_lines WHERE order_id=? AND removed_at IS NULL ORDER BY position,id")
      .bind(String(order.id)).all<Row>();
    const source = text(order.fulfillment_operation, 160) || `historical:${String(order.id)}:${String(order.delivered_at || order.updated_at)}`;
    await db.batch(financeSaleStatements(db, order, lines.results, source, String(order.delivered_at || order.updated_at)));
  }
  return missing.results.length;
}

function defaultRange() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const to = `${values.year}-${values.month}-${values.day}`;
  return { from: `${values.year}-${values.month}-01`, to };
}

function costaRicaDay(timestamp: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
}

function rangeTimestamps(range: { from: string; to: string }) {
  const exclusive = new Date(`${range.to}T00:00:00-06:00`);
  exclusive.setUTCDate(exclusive.getUTCDate() + 1);
  return { from: new Date(`${range.from}T00:00:00-06:00`).toISOString(), toExclusive: exclusive.toISOString() };
}

export function financeRange(url: URL) {
  const fallback = defaultRange();
  const from = url.searchParams.get("from") ? date(url.searchParams.get("from"), "La fecha inicial") : fallback.from;
  const to = url.searchParams.get("to") ? date(url.searchParams.get("to"), "La fecha final") : fallback.to;
  if (from > to) throw new FinanceError("La fecha inicial no puede ser posterior a la final. Corregí el rango; no se modificó ningún dato.", 400, "FINANCE_RANGE_INVALID", "Rango inválido");
  return { from, to };
}

function saleFromRow(row: Row) {
  const cogs = row.historical_cogs_total == null ? null : Number(row.historical_cogs_total);
  const productNet = Number(row.product_net_total);
  const deliveredAt = String(row.delivered_at);
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    orderNumber: String(row.order_number),
    customerName: String(row.customer_name_snapshot),
    deliveredAt,
    deliveredDate: costaRicaDay(deliveredAt),
    routeId: row.route_id ? String(row.route_id) : null,
    productGross: Number(row.product_gross_total),
    discount: Number(row.discount_total),
    productNet,
    deliveryIncome: Number(row.delivery_income),
    totalIncome: Number(row.total_income),
    cogs,
    costStatus: String(row.cost_status),
    grossProfit: cogs == null ? null : productNet - cogs,
  };
}

export async function loadFinanceSnapshot(db: D1Database, range: { from: string; to: string }) {
  await reconcileDeliveredSales(db);
  await reconcileInventoryInvoicePayments(db);
  const timestamps = rangeTimestamps(range);
  const [salesResult, lineResult, paymentResult, receivableResult, expenseResult, templateResult, budgetResult, invoiceResult, routeResult] = await Promise.all([
    db.prepare(`SELECT * FROM finance_sales WHERE status='RECOGNIZED' AND delivered_at>=? AND delivered_at<? ORDER BY delivered_at DESC,id DESC`).bind(timestamps.from, timestamps.toExclusive).all<Row>(),
    db.prepare(`SELECT sl.*,fs.order_id,fs.order_number,fs.delivered_at,fs.route_id
      FROM finance_sale_lines sl JOIN finance_sales fs ON fs.id=sl.sale_id
      WHERE fs.status='RECOGNIZED' AND fs.delivered_at>=? AND fs.delivered_at<? ORDER BY fs.delivered_at DESC,sl.id`).bind(timestamps.from, timestamps.toExclusive).all<Row>(),
    db.prepare(`SELECT p.*,o.order_number,o.customer_name_snapshot FROM order_payments p JOIN orders o ON o.id=p.order_id
      WHERE p.status='POSTED' AND p.created_at>=? AND p.created_at<? ORDER BY p.created_at DESC,p.id DESC`).bind(timestamps.from, timestamps.toExclusive).all<Row>(),
    db.prepare(`SELECT fs.*,COALESCE((SELECT SUM(CASE WHEN p.payment_type='PAYMENT' THEN p.amount ELSE -p.amount END)
      FROM order_payments p WHERE p.order_id=fs.order_id AND p.status='POSTED'),0) AS paid_total
      FROM finance_sales fs WHERE fs.status='RECOGNIZED' ORDER BY fs.delivered_at,fs.id`).all<Row>(),
    db.prepare(`SELECT e.*,original.source_id AS reversed_source_id
      FROM finance_expenses e LEFT JOIN finance_expenses original ON original.id=e.reverses_expense_id
      WHERE e.expense_date BETWEEN ? AND ? ORDER BY e.expense_date DESC,e.created_at DESC,e.id DESC`).bind(range.from, range.to).all<Row>(),
    db.prepare("SELECT * FROM finance_recurring_templates ORDER BY active DESC,next_due_date,id").all<Row>(),
    db.prepare("SELECT * FROM finance_budgets WHERE year_month BETWEEN substr(?,1,7) AND substr(?,1,7) ORDER BY year_month,category").bind(range.from, range.to).all<Row>(),
    db.prepare(`SELECT d.id,d.provider,d.invoice_number,d.order_number,d.document_date,d.confirmed_at,
      a.extraction_json FROM inventory_documents d LEFT JOIN invoice_ai_analyses a ON a.id=d.active_analysis_id
      WHERE d.confirmed_at IS NOT NULL ORDER BY d.confirmed_at DESC,d.id DESC LIMIT 100`).all<Row>(),
    db.prepare("SELECT id,route_date,label,status FROM delivery_routes ORDER BY route_date DESC,id DESC LIMIT 200").all<Row>(),
  ]);
  const invoiceMetadata = new Map(invoiceResult.results.map((row) => {
    let parsed: Row = {};
    try { parsed = JSON.parse(String(row.extraction_json || "{}")) as Row; } catch { parsed = {}; }
    const invoice = parsed.invoice && typeof parsed.invoice === "object" ? parsed.invoice as Row : {};
    const payments = Array.isArray(parsed.payments) ? parsed.payments.filter((item): item is Row => Boolean(item && typeof item === "object")) : [];
    return [String(row.id), {
      documentId: String(row.id), provider: String(row.provider), invoiceNumber: row.invoice_number ? String(row.invoice_number) : null,
      orderNumber: row.order_number ? String(row.order_number) : null, documentDate: row.document_date ? String(row.document_date) : null,
      currency: invoice.currency ? String(invoice.currency) : null,
      payments: payments.map((payment) => ({ method: text(payment.payment_method || payment.normalized_method, 100), last4: /^\d{4}$/.test(String(payment.last4 || "")) ? String(payment.last4) : null, amount: Number(payment.amount || 0), currency: text(payment.currency || invoice.currency, 3).toUpperCase() || null, cashAffecting: payment.cash_affecting !== false })),
    }];
  }));
  const sourceDocumentId = (sourceId: string | null | undefined) => {
    const id = String(sourceId || "").split(":")[0];
    return invoiceMetadata.has(id) ? id : "";
  };
  const sales = salesResult.results.map(saleFromRow);
  const expenses = expenseResult.results.map((row) => {
    const expense = expenseFromRow(row);
    const documentId = sourceDocumentId(expense.sourceId) || sourceDocumentId(row.reversed_source_id ? String(row.reversed_source_id) : "");
    const component = Number(String(expense.sourceId || row.reversed_source_id || "").match(/:payment:(\d+)$/)?.[1]);
    return { ...expense, invoice: documentId ? { ...invoiceMetadata.get(documentId)!, payment: Number.isInteger(component) ? invoiceMetadata.get(documentId)!.payments[component] || null : null } : null };
  });
  const businessExpenses = expenses.filter((item) => item.businessScope === "BUSINESS");
  const signedExpense = (item: ReturnType<typeof expenseFromRow>) => item.entryType === "REVERSAL" ? -item.amountCrc : item.amountCrc;
  const operatingExpenses = businessExpenses.filter((item) => item.category !== "INVENTORY_PURCHASE").reduce((sum, item) => sum + signedExpense(item), 0);
  const cashExpenses = businessExpenses.filter((item) => !isInvoiceNonCash(item.sourceType));
  const allCashOut = cashExpenses.reduce((sum, item) => sum + signedExpense(item), 0);
  const salesTotal = sales.reduce((sum, sale) => sum + sale.totalIncome, 0);
  const productSales = sales.reduce((sum, sale) => sum + sale.productNet, 0);
  const deliveryIncome = sales.reduce((sum, sale) => sum + sale.deliveryIncome, 0);
  const costsComplete = sales.every((sale) => sale.cogs != null);
  const cogsKnown = sales.reduce((sum, sale) => sum + (sale.cogs || 0), 0);
  const grossProfit = costsComplete ? productSales - cogsKnown : null;
  const netProfit = grossProfit == null ? null : grossProfit + deliveryIncome - operatingExpenses;
  const paymentEntries = paymentResult.results.map((row) => ({
    id: String(row.id), orderId: String(row.order_id), orderNumber: String(row.order_number), customerName: String(row.customer_name_snapshot),
    amount: Number(row.amount), signedAmount: String(row.payment_type) === "PAYMENT" ? Number(row.amount) : -Number(row.amount),
    method: String(row.method), type: String(row.payment_type), createdAt: String(row.created_at),
  }));
  const cashIn = paymentEntries.reduce((sum, item) => sum + item.signedAmount, 0);
  const methods = Object.fromEntries(PAYMENT_METHODS.map((method) => {
    const incoming = paymentEntries.filter((item) => item.method === method).reduce((sum, item) => sum + item.signedAmount, 0);
    const outgoing = cashExpenses.filter((item) => item.paymentMethod === method).reduce((sum, item) => sum + signedExpense(item), 0);
    return [method, { incoming, outgoing, net: incoming - outgoing }];
  }));
  const today = defaultRange().to;
  const dailySales = sales.filter((sale) => sale.deliveredDate === today).reduce((sum, sale) => sum + sale.totalIncome, 0);
  const dailyCashIn = paymentEntries.filter((item) => costaRicaDay(item.createdAt) === today).reduce((sum, item) => sum + item.signedAmount, 0);
  const dailyExpenses = businessExpenses.filter((item) => item.date === today && item.category !== "INVENTORY_PURCHASE").reduce((sum, item) => sum + signedExpense(item), 0);
  const receivables = receivableResult.results.map((row) => {
    const sale = saleFromRow(row);
    const paid = Number(row.paid_total || 0);
    const deliveredDate = sale.deliveredDate;
    const ageDays = Math.max(0, Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${deliveredDate}T12:00:00Z`)) / 86_400_000));
    return { ...sale, paidTotal: paid, balance: Math.max(0, sale.totalIncome - paid), ageDays };
  }).filter((item) => item.balance > 0);
  const expenseByCategory = Object.entries(businessExpenses.reduce<Record<string, number>>((map, item) => {
    if (item.category === "INVENTORY_PURCHASE") return map;
    map[item.category] = (map[item.category] || 0) + signedExpense(item);
    return map;
  }, {})).map(([key, amount]) => ({ category: key, label: FINANCE_CATEGORY_LABELS[key as keyof typeof FINANCE_CATEGORY_LABELS] || key, amount }));
  const daily = new Map<string, { date: string; sales: number; expenses: number; cashIn: number; cashOut: number }>();
  const day = (key: string) => {
    const existing = daily.get(key) || { date: key, sales: 0, expenses: 0, cashIn: 0, cashOut: 0 };
    daily.set(key, existing);
    return existing;
  };
  sales.forEach((sale) => { day(sale.deliveredDate).sales += sale.totalIncome; });
  businessExpenses.forEach((item) => { const amount = signedExpense(item); if (!isInvoiceNonCash(item.sourceType)) day(item.date).cashOut += amount; if (item.category !== "INVENTORY_PURCHASE") day(item.date).expenses += amount; });
  paymentEntries.forEach((item) => { day(costaRicaDay(item.createdAt)).cashIn += item.signedAmount; });
  const productProfitability = Object.values(lineResult.results.reduce<Record<string, {
    productId: number | null; name: string; units: number; income: number; cogsKnown: number; missingCost: boolean;
  }>>((map, row) => {
    const key = row.product_id == null ? `manual:${String(row.product_name_snapshot)}` : `product:${String(row.product_id)}`;
    const current = map[key] || { productId: row.product_id == null ? null : Number(row.product_id), name: String(row.product_name_snapshot), units: 0, income: 0, cogsKnown: 0, missingCost: false };
    current.units += Number(row.quantity);
    current.income += Number(row.net_income);
    if (row.historical_cogs == null) current.missingCost = true;
    else current.cogsKnown += Number(row.historical_cogs);
    map[key] = current;
    return map;
  }, {})).map((item) => ({
    ...item,
    cogs: item.missingCost ? null : item.cogsKnown,
    profit: item.missingCost ? null : item.income - item.cogsKnown,
    marginPercent: item.missingCost || item.income === 0 ? null : ((item.income - item.cogsKnown) / item.income) * 100,
  })).sort((left, right) => right.income - left.income);
  const orderProfitability = sales.map((sale) => {
    const directExpenses = businessExpenses.filter((expense) => expense.orderId === sale.orderId).reduce((sum, expense) => sum + signedExpense(expense), 0);
    return { ...sale, directExpenses, result: sale.grossProfit == null ? null : sale.grossProfit + sale.deliveryIncome - directExpenses };
  });
  const routeProfitability = Object.values(sales.filter((sale) => sale.routeId).reduce<Record<string, {
    routeId: string; date: string; label: string; products: number; delivery: number; cogsKnown: number; missingCost: boolean; expenses: number;
  }>>((map, sale) => {
    const route = routeResult.results.find((row) => String(row.id) === sale.routeId);
    const key = sale.routeId || "";
    const current = map[key] || { routeId: key, date: route ? String(route.route_date) : sale.deliveredDate, label: route?.label ? String(route.label) : "Ruta", products: 0, delivery: 0, cogsKnown: 0, missingCost: false, expenses: 0 };
    current.products += sale.productNet;
    current.delivery += sale.deliveryIncome;
    if (sale.cogs == null) current.missingCost = true;
    else current.cogsKnown += sale.cogs;
    map[key] = current;
    return map;
  }, {})).map((item) => {
    item.expenses = businessExpenses.filter((expense) => expense.routeId === item.routeId).reduce((sum, expense) => sum + signedExpense(expense), 0);
    return { ...item, cogs: item.missingCost ? null : item.cogsKnown, result: item.missingCost ? null : item.products + item.delivery - item.cogsKnown - item.expenses };
  });
  const budgets = budgetResult.results.map((row) => {
    const spent = businessExpenses.filter((item) => item.category === String(row.category) && item.date.startsWith(String(row.year_month))).reduce((sum, item) => sum + signedExpense(item), 0);
    return { id: String(row.id), category: String(row.category), categoryLabel: FINANCE_CATEGORY_LABELS[String(row.category) as keyof typeof FINANCE_CATEGORY_LABELS] || String(row.category), yearMonth: String(row.year_month), amountCrc: Number(row.amount_crc), spent, available: Number(row.amount_crc) - spent };
  });
  const invoices = invoiceResult.results.map((row) => {
    let parsed: Row = {};
    try { parsed = JSON.parse(String(row.extraction_json || "{}")) as Row; } catch { parsed = {}; }
    const invoice = parsed.invoice && typeof parsed.invoice === "object" ? parsed.invoice as Row : {};
    return {
      id: String(row.id), provider: String(row.provider), invoiceNumber: row.invoice_number ? String(row.invoice_number) : null,
      orderNumber: row.order_number ? String(row.order_number) : null, documentDate: row.document_date ? String(row.document_date) : null,
      confirmedAt: String(row.confirmed_at), currency: invoice.currency ? String(invoice.currency) : null,
      suggestedAmount: invoice.total == null ? null : Number(invoice.total),
      payments: invoiceMetadata.get(String(row.id))?.payments || [],
      fileUrl: `/api/inventory-intake/${encodeURIComponent(String(row.id))}/file?index=0`,
      alreadyLinked: expenses.some((expense) => expense.entryType === "EXPENSE" && (expense.sourceType === "INVENTORY_INVOICE" && expense.sourceId === String(row.id)
        || expense.sourceType.startsWith("INVENTORY_INVOICE_") && expense.sourceId?.startsWith(`${String(row.id)}:`))),
    };
  });
  return {
    range,
    metrics: {
      sales: salesTotal,
      netProfit,
      operatingExpenses,
      cashNet: cashIn - allCashOut,
      grossProfit,
      cogs: costsComplete ? cogsKnown : null,
      knownCogs: cogsKnown,
      deliveryIncome,
      deliveredOrders: sales.length,
      marginPercent: grossProfit == null || productSales === 0 ? null : (grossProfit / productSales) * 100,
      costsComplete,
    },
    trace: { sales, expenses: businessExpenses, payments: paymentEntries },
    sales,
    expenses,
    cash: { incoming: cashIn, outgoing: allCashOut, net: cashIn - allCashOut, methods, payments: paymentEntries, expenses: cashExpenses },
    receivables,
    payables: [],
    profitability: { products: productProfitability, orders: orderProfitability, routes: routeProfitability },
    charts: { daily: [...daily.values()].sort((left, right) => left.date.localeCompare(right.date)), expenseByCategory, topProducts: productProfitability.slice(0, 8) },
    dailySummary: { date: today, deliveredSales: dailySales, collections: dailyCashIn, expenses: dailyExpenses, cashIn: dailyCashIn, cashOut: cashExpenses.filter((item) => item.date === today).reduce((sum, item) => sum + signedExpense(item), 0), netCash: dailyCashIn - cashExpenses.filter((item) => item.date === today).reduce((sum, item) => sum + signedExpense(item), 0) },
    recurringTemplates: templateResult.results.map((row) => ({ id: String(row.id), name: String(row.name), category: String(row.category), categoryLabel: FINANCE_CATEGORY_LABELS[String(row.category) as keyof typeof FINANCE_CATEGORY_LABELS] || String(row.category), amountCrc: Number(row.amount_crc), currency: String(row.currency), exchangeRateCrc: Number(row.exchange_rate_crc), paymentMethod: String(row.payment_method), frequency: String(row.frequency), nextDueDate: String(row.next_due_date), provider: row.provider ? String(row.provider) : null, notes: row.notes ? String(row.notes) : null, active: Boolean(row.active) })),
    budgets,
    invoices,
    routes: routeResult.results.map((row) => ({ id: String(row.id), date: String(row.route_date), label: row.label ? String(row.label) : null, status: String(row.status) })),
    categories: FINANCE_CATEGORIES.map((key) => ({ key, label: FINANCE_CATEGORY_LABELS[key] })),
    generatedAt: new Date().toISOString(),
  };
}

export async function createExpense(db: D1Database, payload: Row) {
  const idempotencyKey = operationId(payload.operationId ?? payload.idempotencyKey);
  const existing = await db.prepare("SELECT * FROM finance_expenses WHERE idempotency_key=? LIMIT 1").bind(idempotencyKey).first<Row>();
  if (existing) return { expense: expenseFromRow(existing), idempotent: true };
  const expenseDate = date(payload.date ?? payload.expenseDate);
  const expenseCategory = category(payload.category);
  const description = text(payload.description, 500);
  if (description.length < 3) throw new FinanceError("Describí el gasto con al menos tres caracteres. No se creó ningún movimiento.", 400, "FINANCE_DESCRIPTION_REQUIRED", "Descripción requerida");
  const currency = text(payload.currency || "CRC", 3).toUpperCase();
  if (!['CRC', 'USD'].includes(currency)) throw new FinanceError("Finanzas v1 admite gastos en CRC o USD. Corregí la moneda; no se creó ningún movimiento.", 400, "FINANCE_CURRENCY_INVALID", "Moneda inválida");
  const exactManualMinor = payload.amount == null ? null : moneyMinor(payload.amount, "El monto original");
  const originalAmountMinor = exactManualMinor ?? positiveInteger(payload.originalAmountMinor, "El monto original");
  const exchangeRateCrc = currency === "CRC" ? 1 : positiveInteger(payload.exchangeRateCrc, "El tipo de cambio", 100_000);
  const amountCrc = currency === "CRC" ? (exactManualMinor == null ? originalAmountMinor : Math.max(1, Math.round(originalAmountMinor / 100))) : Math.round((originalAmountMinor / 100) * exchangeRateCrc);
  const method = paymentMethod(payload.paymentMethod ?? payload.method);
  const provider = text(payload.provider, 250) || null;
  const notes = text(payload.notes, 2000) || null;
  const routeId = text(payload.routeId, 160) || null;
  const orderId = text(payload.orderId, 160) || null;
  const businessScope = payload.personal === true || text(payload.businessScope, 20).toUpperCase() === "PERSONAL" ? "PERSONAL" : "BUSINESS";
  const invoiceId = text(payload.invoiceId, 160) || null;
  let sourceType = currency === "CRC" && exactManualMinor != null ? "MANUAL_CRC_CENTS" : "MANUAL";
  let sourceId: string | null = null;
  if (invoiceId) {
    if (expenseCategory !== "INVENTORY_PURCHASE") throw new FinanceError("Una factura de compra solo puede vincularse a Compra de inventario/productos. Corregí la categoría; no se creó ningún movimiento.", 400, "FINANCE_INVOICE_CATEGORY_INVALID", "Categoría incompatible");
    if (payload.paidConfirmed !== true) throw new FinanceError("Confirmá que la factura realmente fue pagada antes de registrarla como salida de caja. No se creó ningún movimiento.", 409, "FINANCE_INVOICE_PAYMENT_UNCONFIRMED", "Pago no confirmado");
    const invoice = await db.prepare("SELECT id,confirmed_at FROM inventory_documents WHERE id=? LIMIT 1").bind(invoiceId).first<Row>();
    if (!invoice?.confirmed_at) throw new FinanceError("La factura todavía no está confirmada en Inventario. Procesala primero; no se creó ninguna salida de caja.", 409, "FINANCE_INVOICE_NOT_CONFIRMED", "Factura no confirmada");
    sourceType = "INVENTORY_INVOICE";
    sourceId = invoiceId;
  }
  if (sourceId) {
    const linked = await db.prepare("SELECT * FROM finance_expenses WHERE source_type=? AND source_id=? AND entry_type='EXPENSE' LIMIT 1").bind(sourceType, sourceId).first<Row>();
    if (linked) return { expense: expenseFromRow(linked), idempotent: true };
  }
  const possible = await db.prepare(`SELECT * FROM finance_expenses WHERE entry_type='EXPENSE' AND expense_date=? AND category=? AND amount_crc=?
    AND lower(trim(description))=lower(trim(?)) AND lower(trim(COALESCE(provider,'')))=lower(trim(COALESCE(?,''))) LIMIT 1`)
    .bind(expenseDate, expenseCategory, amountCrc, description, provider).first<Row>();
  if (possible && payload.confirmDuplicate !== true) {
    throw new FinanceError("Ya existe un movimiento con la misma fecha, categoría, monto, descripción y proveedor. Revisalo antes de continuar. No se creó ningún cargo adicional.", 409, "FINANCE_POSSIBLE_DUPLICATE", "Posible duplicado", { duplicateId: String(possible.id) });
  }
  if (routeId) {
    const route = await db.prepare("SELECT id FROM delivery_routes WHERE id=? LIMIT 1").bind(routeId).first();
    if (!route) throw new FinanceError("La ruta seleccionada ya no existe. Actualizá Finanzas; no se creó ningún movimiento.", 409, "FINANCE_ROUTE_NOT_FOUND", "Ruta no encontrada");
  }
  if (orderId) {
    const order = await db.prepare("SELECT id FROM orders WHERE id=? LIMIT 1").bind(orderId).first();
    if (!order) throw new FinanceError("El pedido seleccionado ya no existe. Actualizá Finanzas; no se creó ningún movimiento.", 409, "FINANCE_ORDER_NOT_FOUND", "Pedido no encontrado");
  }
  const id = newOrderChildId("expense");
  const now = new Date().toISOString();
  try {
    await db.prepare(`INSERT INTO finance_expenses (
      id,expense_date,category,description,amount_crc,original_amount_minor,currency,exchange_rate_crc,payment_method,
      provider,notes,route_id,order_id,source_type,source_id,idempotency_key,entry_type,reverses_expense_id,business_scope,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'EXPENSE',NULL,?,?)`).bind(
      id, expenseDate, expenseCategory, description, amountCrc, originalAmountMinor, currency, exchangeRateCrc, method,
      provider, notes, routeId, orderId, sourceType, sourceId, idempotencyKey, businessScope, now,
    ).run();
  } catch (error) {
    if (/finance_expenses_idempotency_unique|UNIQUE constraint failed: finance_expenses\.idempotency_key/i.test(error instanceof Error ? error.message : "")) {
      const replay = await db.prepare("SELECT * FROM finance_expenses WHERE idempotency_key=? LIMIT 1").bind(idempotencyKey).first<Row>();
      if (replay) return { expense: expenseFromRow(replay), idempotent: true };
    }
    if (/finance_expenses_source_unique|UNIQUE constraint failed: finance_expenses\.source_type/i.test(error instanceof Error ? error.message : "")) {
      const linked = await db.prepare("SELECT * FROM finance_expenses WHERE source_type=? AND source_id=? AND entry_type='EXPENSE' LIMIT 1").bind(sourceType, sourceId).first<Row>();
      if (linked) return { expense: expenseFromRow(linked), idempotent: true };
    }
    throw error;
  }
  return { expense: expenseFromRow((await db.prepare("SELECT * FROM finance_expenses WHERE id=?").bind(id).first<Row>())!), idempotent: false };
}

export async function reverseExpense(db: D1Database, expenseId: string, payload: Row) {
  const key = operationId(payload.operationId);
  const replay = await db.prepare("SELECT * FROM finance_expenses WHERE idempotency_key=? LIMIT 1").bind(key).first<Row>();
  if (replay) return { expense: expenseFromRow(replay), idempotent: true };
  const original = await db.prepare("SELECT * FROM finance_expenses WHERE id=? AND entry_type='EXPENSE' LIMIT 1").bind(expenseId).first<Row>();
  if (!original) throw new FinanceError("No encontramos el gasto original. Actualizá Finanzas; no se creó ninguna reversa.", 404, "FINANCE_EXPENSE_NOT_FOUND", "Gasto no encontrado");
  const prior = await db.prepare("SELECT * FROM finance_expenses WHERE reverses_expense_id=? LIMIT 1").bind(expenseId).first<Row>();
  if (prior) return { expense: expenseFromRow(prior), idempotent: true };
  const reason = text(payload.reason, 1000);
  if (reason.length < 3) throw new FinanceError("Indicá el motivo de la reversa. El gasto original permanece sin cambios y no se creó ningún movimiento.", 400, "FINANCE_REVERSAL_REASON_REQUIRED", "Motivo requerido");
  const id = newOrderChildId("expense-reversal");
  try {
    await db.prepare(`INSERT INTO finance_expenses (
      id,expense_date,category,description,amount_crc,original_amount_minor,currency,exchange_rate_crc,payment_method,
      provider,notes,route_id,order_id,source_type,source_id,idempotency_key,entry_type,reverses_expense_id,business_scope,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'REVERSAL',?,?,?)`).bind(
      id, defaultRange().to, String(original.category), `Reversa: ${String(original.description)}`,
      Number(original.amount_crc), Number(original.original_amount_minor), String(original.currency), Number(original.exchange_rate_crc),
      String(original.payment_method), original.provider || null, reason, original.route_id || null, original.order_id || null, "EXPENSE_REVERSAL", expenseId,
      key, expenseId, String(original.business_scope), new Date().toISOString(),
    ).run();
  } catch (error) {
    if (/finance_expenses_(idempotency|reversal)_unique|UNIQUE constraint failed: finance_expenses\.(idempotency_key|reverses_expense_id)/i.test(error instanceof Error ? error.message : "")) {
      const replayed = await db.prepare("SELECT * FROM finance_expenses WHERE idempotency_key=? OR reverses_expense_id=? LIMIT 1").bind(key, expenseId).first<Row>();
      if (replayed) return { expense: expenseFromRow(replayed), idempotent: true };
    }
    throw error;
  }
  return { expense: expenseFromRow((await db.prepare("SELECT * FROM finance_expenses WHERE id=?").bind(id).first<Row>())!), idempotent: false };
}

export async function createRecurringTemplate(db: D1Database, payload: Row) {
  const id = newOrderChildId("recurring");
  const name = text(payload.name, 250);
  if (name.length < 3) throw new FinanceError("Nombrá la plantilla recurrente. No se guardó ningún cambio.", 400, "FINANCE_RECURRING_NAME_REQUIRED", "Nombre requerido");
  const amountCrc = positiveInteger(payload.amountCrc, "El monto esperado");
  const frequency = text(payload.frequency, 20).toUpperCase();
  if (!FREQUENCIES.includes(frequency as (typeof FREQUENCIES)[number])) throw new FinanceError("Seleccioná una frecuencia válida. No se guardó la plantilla.", 400, "FINANCE_RECURRING_FREQUENCY_INVALID", "Frecuencia inválida");
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO finance_recurring_templates (
    id,name,category,amount_crc,currency,exchange_rate_crc,payment_method,frequency,next_due_date,provider,notes,active,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).bind(
    id, name, category(payload.category), amountCrc, "CRC", 1, paymentMethod(payload.paymentMethod), frequency,
    date(payload.nextDueDate, "El próximo vencimiento"), text(payload.provider, 250) || null, text(payload.notes, 2000) || null, now, now,
  ).run();
  return { templateId: id };
}

function nextDueDate(current: string, frequency: string) {
  const source = new Date(`${current}T12:00:00Z`);
  if (frequency === "WEEKLY") source.setUTCDate(source.getUTCDate() + 7);
  else if (frequency === "MONTHLY") source.setUTCMonth(source.getUTCMonth() + 1);
  else if (frequency === "QUARTERLY") source.setUTCMonth(source.getUTCMonth() + 3);
  else source.setUTCFullYear(source.getUTCFullYear() + 1);
  return source.toISOString().slice(0, 10);
}

export async function generateRecurringExpense(db: D1Database, templateId: string, payload: Row) {
  const key = operationId(payload.operationId);
  const replay = await db.prepare("SELECT * FROM finance_expenses WHERE idempotency_key=? LIMIT 1").bind(key).first<Row>();
  if (replay) return { expense: expenseFromRow(replay), idempotent: true };
  const template = await db.prepare("SELECT * FROM finance_recurring_templates WHERE id=? AND active=1 LIMIT 1").bind(templateId).first<Row>();
  if (!template) throw new FinanceError("La plantilla recurrente ya no está activa. Actualizá Finanzas; no se creó ningún gasto.", 404, "FINANCE_RECURRING_NOT_FOUND", "Plantilla no disponible");
  const due = String(template.next_due_date);
  const sourceId = `${templateId}:${due}`;
  const prior = await db.prepare("SELECT * FROM finance_expenses WHERE source_type='RECURRING_TEMPLATE' AND source_id=? AND entry_type='EXPENSE' LIMIT 1").bind(sourceId).first<Row>();
  if (prior) return { expense: expenseFromRow(prior), idempotent: true };
  const id = newOrderChildId("expense");
  const now = new Date().toISOString();
  try {
    await db.batch([
      db.prepare(`INSERT INTO finance_expenses (
        id,expense_date,category,description,amount_crc,original_amount_minor,currency,exchange_rate_crc,payment_method,
        provider,notes,route_id,order_id,source_type,source_id,idempotency_key,entry_type,reverses_expense_id,business_scope,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'RECURRING_TEMPLATE',?,?,'EXPENSE',NULL,'BUSINESS',?)`).bind(
        id, date(payload.date || due), String(template.category), String(template.name), Number(template.amount_crc), Number(template.amount_crc),
        "CRC", 1, String(template.payment_method), template.provider || null, template.notes || null, sourceId, key, now,
      ),
      db.prepare("UPDATE finance_recurring_templates SET next_due_date=?,updated_at=? WHERE id=? AND next_due_date=?")
        .bind(nextDueDate(due, String(template.frequency)), now, templateId, due),
    ]);
  } catch (error) {
    if (/finance_expenses_(idempotency|source)_unique|UNIQUE constraint failed: finance_expenses\.(idempotency_key|source_type)/i.test(error instanceof Error ? error.message : "")) {
      const replayed = await db.prepare("SELECT * FROM finance_expenses WHERE idempotency_key=? OR (source_type='RECURRING_TEMPLATE' AND source_id=?) LIMIT 1").bind(key, sourceId).first<Row>();
      if (replayed) return { expense: expenseFromRow(replayed), idempotent: true };
    }
    throw error;
  }
  return { expense: expenseFromRow((await db.prepare("SELECT * FROM finance_expenses WHERE id=?").bind(id).first<Row>())!), idempotent: false };
}

export async function saveBudget(db: D1Database, payload: Row) {
  const operation = operationId(payload.operationId);
  const expenseCategory = category(payload.category);
  const yearMonth = text(payload.yearMonth, 7);
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) throw new FinanceError("El mes del presupuesto no es válido. Corregilo; no se guardó ningún cambio.", 400, "FINANCE_BUDGET_MONTH_INVALID", "Mes inválido");
  const amountCrc = positiveInteger(payload.amountCrc, "El presupuesto");
  const id = newOrderChildId("budget");
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO finance_budgets (id,category,year_month,amount_crc,operation_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(category,year_month) DO UPDATE SET amount_crc=excluded.amount_crc,operation_id=excluded.operation_id,updated_at=excluded.updated_at`)
    .bind(id, expenseCategory, yearMonth, amountCrc, operation, now, now).run();
  return { budget: await db.prepare("SELECT * FROM finance_budgets WHERE category=? AND year_month=?").bind(expenseCategory, yearMonth).first<Row>() };
}
