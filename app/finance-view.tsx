"use client";

import { AlertCircle, BarChart3, Banknote, CalendarDays, Check, ChevronRight, Download, FileText, Loader2, Plus, Receipt, RefreshCw, RotateCcw, TrendingDown, TrendingUp, WalletCards, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Notice = { type: "success" | "error" | "warning" | "info"; text: string };
type Category = { key: string; label: string };
type Expense = { id: string; date: string; category: string; categoryLabel: string; description: string; amountCrc: number; currency: string; paymentMethod: string; provider: string | null; routeId: string | null; orderId: string | null; sourceType: string; sourceId: string | null; entryType: string; businessScope: string };
type Sale = { id: string; orderId: string; orderNumber: string; customerName: string; deliveredAt: string; deliveredDate: string; routeId: string | null; productGross: number; discount: number; productNet: number; deliveryIncome: number; totalIncome: number; cogs: number | null; costStatus: string; grossProfit: number | null };
type FinanceData = {
  range: { from: string; to: string };
  metrics: { sales: number; netProfit: number | null; operatingExpenses: number; cashNet: number; grossProfit: number | null; cogs: number | null; knownCogs: number; deliveryIncome: number; deliveredOrders: number; marginPercent: number | null; costsComplete: boolean };
  trace: { sales: Sale[]; expenses: Expense[]; payments: Array<{ id: string; orderId: string; orderNumber: string; customerName: string; amount: number; signedAmount: number; method: string; type: string; createdAt: string }> };
  sales: Sale[];
  expenses: Expense[];
  cash: { incoming: number; outgoing: number; net: number; methods: Record<string, { incoming: number; outgoing: number; net: number }>; payments: FinanceData["trace"]["payments"]; expenses: Expense[] };
  receivables: Array<Sale & { paidTotal: number; balance: number; ageDays: number }>;
  payables: [];
  profitability: {
    products: Array<{ productId: number | null; name: string; units: number; income: number; cogs: number | null; profit: number | null; marginPercent: number | null }>;
    orders: Array<Sale & { directExpenses: number; result: number | null }>;
    routes: Array<{ routeId: string; date: string; label: string; products: number; delivery: number; cogs: number | null; expenses: number; result: number | null }>;
  };
  charts: { daily: Array<{ date: string; sales: number; expenses: number; cashIn: number; cashOut: number }>; expenseByCategory: Array<{ category: string; label: string; amount: number }>; topProducts: FinanceData["profitability"]["products"] };
  dailySummary: { date: string; deliveredSales: number; collections: number; expenses: number; cashIn: number; cashOut: number; netCash: number };
  recurringTemplates: Array<{ id: string; name: string; category: string; categoryLabel: string; amountCrc: number; paymentMethod: string; frequency: string; nextDueDate: string; provider: string | null; active: boolean }>;
  budgets: Array<{ id: string; category: string; categoryLabel: string; yearMonth: string; amountCrc: number; spent: number; available: number }>;
  invoices: Array<{ id: string; provider: string; invoiceNumber: string | null; orderNumber: string | null; documentDate: string | null; confirmedAt: string; currency: string | null; suggestedAmount: number | null; alreadyLinked: boolean }>;
  routes: Array<{ id: string; date: string; label: string | null; status: string }>;
  categories: Category[];
};

type View = "summary" | "sales" | "expenses" | "cash" | "receivables" | "profitability";
type Trace = "sales" | "profit" | "expenses" | "cash" | null;

class FinanceApiError extends Error {
  constructor(message: string, public payload: Record<string, unknown>) { super(message); }
}

async function api<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new FinanceApiError(body.error || "No pudimos completar la operación.", body as Record<string, unknown>);
  return body;
}

function crc(value: number | null) {
  return value == null ? "No disponible" : `₡${new Intl.NumberFormat("es-CR", { maximumFractionDigits: 0 }).format(Math.round(value))}`;
}

function isoToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function rangeFor(period: "today" | "week" | "month") {
  const today = isoToday();
  if (period === "today") return { from: today, to: today };
  if (period === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  const start = new Date(`${today}T12:00:00Z`);
  const day = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - day + 1);
  return { from: start.toISOString().slice(0, 10), to: today };
}

function operationId(prefix: string) {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function BarList({ items }: { items: Array<{ label: string; value: number; secondary?: number }> }) {
  const maximum = Math.max(1, ...items.map((item) => Math.max(item.value, item.secondary || 0)));
  return <div className="finance-bars">{items.length ? items.map((item) => <div key={item.label}><span>{item.label}</span><div><i style={{ width: `${Math.max(2, (item.value / maximum) * 100)}%` }} />{item.secondary != null && <em style={{ width: `${Math.max(2, (item.secondary / maximum) * 100)}%` }} />}</div><b>{crc(item.value)}</b></div>) : <p>Sin movimientos en el período.</p>}</div>;
}

export function FinanceView({ active, onOpenOrder, onNavigateView, onNotify }: { active: boolean; onOpenOrder: (orderId: string) => void; onNavigateView: (view: View) => void; onNotify: (notice: Notice) => void }) {
  const [view, setView] = useState<View>("summary");
  const [period, setPeriod] = useState<"today" | "week" | "month" | "custom">("month");
  const [range, setRange] = useState(rangeFor("month"));
  const [data, setData] = useState<FinanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [trace, setTrace] = useState<Trace>(null);
  const [reversal, setReversal] = useState<Expense | null>(null);
  const [reversalReason, setReversalReason] = useState("");
  const [expense, setExpense] = useState({ date: isoToday(), category: "FUEL", description: "", amount: "", currency: "CRC", exchangeRate: "", paymentMethod: "SINPE", provider: "", notes: "", routeId: "", orderId: "", invoiceId: "", paidConfirmed: false, personal: false });
  const [template, setTemplate] = useState({ name: "", category: "SOFTWARE", amount: "", paymentMethod: "CARD", frequency: "MONTHLY", nextDueDate: isoToday(), provider: "" });
  const [budget, setBudget] = useState({ category: "ADVERTISING", yearMonth: isoToday().slice(0, 7), amount: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api<FinanceData>(`/api/finance?from=${range.from}&to=${range.to}`)); }
    catch (error) { onNotify({ type: "error", text: error instanceof Error ? error.message : "No pudimos cargar Finanzas. Los datos guardados no cambiaron." }); }
    finally { setLoading(false); }
  }, [onNotify, range.from, range.to]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [active, load]);

  useEffect(() => {
    const onLocation = (event: Event) => {
      const requested = (event as CustomEvent<{ view?: string }>).detail?.view;
      const next = ["summary", "sales", "expenses", "cash", "receivables", "profitability"].includes(requested || "") ? requested as View : "summary";
      setTrace(null);
      setReversal(null);
      setView(next);
    };
    const onBack = (event: Event) => {
      if (!active) return;
      if (trace) { event.preventDefault(); setTrace(null); }
      else if (reversal) { event.preventDefault(); setReversal(null); setReversalReason(""); }
    };
    window.addEventListener("nutriplus:finance-location", onLocation);
    window.addEventListener("nutriplus:navigation-back", onBack);
    return () => {
      window.removeEventListener("nutriplus:finance-location", onLocation);
      window.removeEventListener("nutriplus:navigation-back", onBack);
    };
  }, [active, reversal, trace]);

  const choosePeriod = (next: typeof period) => {
    setPeriod(next);
    if (next !== "custom") setRange(rangeFor(next));
  };

  async function saveExpense(event: FormEvent, confirmDuplicate = false) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const amountNumber = Number(expense.amount);
      const originalAmountMinor = expense.currency === "USD" ? Math.round(amountNumber * 100) : Math.round(amountNumber);
      await api("/api/finance/expenses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        operationId: operationId("expense"), date: expense.date, category: expense.category, description: expense.description,
        originalAmountMinor, currency: expense.currency, exchangeRateCrc: expense.currency === "USD" ? Number(expense.exchangeRate) : 1,
        paymentMethod: expense.paymentMethod, provider: expense.provider, notes: expense.notes, routeId: expense.routeId || null, orderId: expense.orderId || null,
        invoiceId: expense.invoiceId || null, paidConfirmed: expense.paidConfirmed, personal: expense.personal, confirmDuplicate,
      }) });
      setExpense((current) => ({ ...current, description: "", amount: "", provider: "", notes: "", routeId: "", orderId: "", invoiceId: "", paidConfirmed: false, personal: false }));
      onNotify({ type: "success", text: "Gasto registrado una sola vez. Caja y rentabilidad ya fueron recalculadas." });
      await load();
    } catch (error) {
      if (error instanceof FinanceApiError && error.payload.code === "FINANCE_POSSIBLE_DUPLICATE" && !confirmDuplicate) {
        if (window.confirm(`${error.message}\n\n¿Querés registrarlo de todos modos como un gasto distinto?`)) {
          setBusy(false);
          return void saveExpense(event, true);
        }
      } else onNotify({ type: "error", text: error instanceof Error ? error.message : "No pudimos registrar el gasto. No se creó ningún movimiento." });
    } finally { setBusy(false); }
  }

  async function reverse() {
    if (!reversal || reversalReason.trim().length < 3 || busy) return;
    setBusy(true);
    try {
      await api(`/api/finance/expenses/${reversal.id}/reverse`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId: operationId("expense-reversal"), reason: reversalReason }) });
      setReversal(null); setReversalReason("");
      onNotify({ type: "success", text: "Reversa registrada con trazabilidad. El gasto original permanece en el historial." });
      await load();
    } catch (error) { onNotify({ type: "error", text: error instanceof Error ? error.message : "No pudimos registrar la reversa. El gasto original no cambió." }); }
    finally { setBusy(false); }
  }

  async function saveTemplate(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await api("/api/finance/recurring", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...template, amountCrc: Math.round(Number(template.amount)) }) });
      setTemplate((current) => ({ ...current, name: "", amount: "", provider: "" }));
      onNotify({ type: "success", text: "Plantilla recurrente guardada. No se registró ningún gasto pagado automáticamente." });
      await load();
    } catch (error) { onNotify({ type: "error", text: error instanceof Error ? error.message : "No pudimos guardar la plantilla. No se creó ningún gasto." }); }
    finally { setBusy(false); }
  }

  async function generateTemplate(id: string) {
    setBusy(true);
    try {
      await api(`/api/finance/recurring/${id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId: operationId("recurring-expense") }) });
      onNotify({ type: "success", text: "Gasto recurrente confirmado explícitamente. Se registró una única salida de caja." });
      await load();
    } catch (error) { onNotify({ type: "error", text: error instanceof Error ? error.message : "No pudimos generar el gasto. No se creó ninguna salida." }); }
    finally { setBusy(false); }
  }

  async function saveBudget(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await api("/api/finance/budgets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId: operationId("budget"), category: budget.category, yearMonth: budget.yearMonth, amountCrc: Math.round(Number(budget.amount)) }) });
      setBudget((current) => ({ ...current, amount: "" }));
      onNotify({ type: "success", text: "Presupuesto guardado. No modifica caja ni rentabilidad." });
      await load();
    } catch (error) { onNotify({ type: "error", text: error instanceof Error ? error.message : "No pudimos guardar el presupuesto. Las cifras no cambiaron." }); }
    finally { setBusy(false); }
  }

  async function download(format: "pdf" | "excel") {
    try {
      const response = await fetch(`/api/finance/export?from=${range.from}&to=${range.to}&format=${format}`);
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error || "No pudimos generar la exportación.");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `finanzas-${range.from}-${range.to}.${format === "pdf" ? "pdf" : "xlsx"}`; anchor.click(); URL.revokeObjectURL(url);
    } catch (error) { onNotify({ type: "error", text: error instanceof Error ? error.message : "No pudimos descargar Finanzas. Los datos guardados no cambiaron." }); }
  }

  const tabs: Array<[View, string]> = [["summary", "Resumen"], ["sales", "Ventas"], ["expenses", "Gastos"], ["cash", "Caja"], ["receivables", "Cuentas por cobrar"], ["profitability", "Rentabilidad"]];
  const maximumChart = useMemo(() => Math.max(1, ...(data?.charts.daily || []).flatMap((item) => [item.sales, item.expenses])), [data]);
  if (loading && !data) return <div className="finance-loading"><Loader2 className="spin" />Cargando cifras trazables…</div>;
  if (!data) return <div className="empty"><AlertCircle /><h2>Finanzas no disponible</h2><p>Reintentá. Ningún pedido, pago ni gasto fue modificado.</p><button className="btn secondary" onClick={() => void load()}><RefreshCw />Reintentar</button></div>;

  return <div className="view finance-view"><header className="view-head finance-head"><div><span className="eyebrow">Control financiero trazable</span><h1>Ventas y gastos</h1><p>Ventas solo al entregar; caja al cobrar o pagar. Cada cifra abre su origen.</p></div><div className="finance-export"><button className="btn secondary small" onClick={() => void download("excel")}><Download />Excel</button><button className="btn secondary small" onClick={() => void download("pdf")}><FileText />PDF</button></div></header>
    <section className="finance-period"><div><button className={period === "today" ? "active" : ""} onClick={() => choosePeriod("today")}>Hoy</button><button className={period === "week" ? "active" : ""} onClick={() => choosePeriod("week")}>Semana</button><button className={period === "month" ? "active" : ""} onClick={() => choosePeriod("month")}>Mes</button><button className={period === "custom" ? "active" : ""} onClick={() => choosePeriod("custom")}>Rango</button></div>{period === "custom" && <span><input type="date" value={range.from} onChange={(event) => setRange((current) => ({ ...current, from: event.target.value }))} /><input type="date" value={range.to} onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))} /></span>}</section>
    <nav className="finance-tabs" aria-label="Secciones de Finanzas">{tabs.map(([id, label]) => <button className={view === id ? "active" : ""} onClick={() => { setView(id); onNavigateView(id); }} key={id}>{label}</button>)}</nav>

    {view === "summary" && <><section className="finance-kpis primary"><button onClick={() => setTrace("sales")}><TrendingUp /><span>Ventas</span><b>{crc(data.metrics.sales)}</b><small>{data.metrics.deliveredOrders} entregados</small></button><button onClick={() => setTrace("profit")}><BarChart3 /><span>Ganancia neta</span><b>{crc(data.metrics.netProfit)}</b><small>{data.metrics.costsComplete ? "Trazabilidad completa" : "Costo histórico incompleto"}</small></button><button onClick={() => setTrace("expenses")}><TrendingDown /><span>Gastos operativos</span><b>{crc(data.metrics.operatingExpenses)}</b><small>Sin compras de inventario</small></button><button onClick={() => setTrace("cash")}><WalletCards /><span>Flujo neto de caja</span><b>{crc(data.metrics.cashNet)}</b><small>Cobros menos salidas</small></button></section>
      <section className="finance-kpis secondary"><button onClick={() => setTrace("profit")}><b>{crc(data.metrics.grossProfit)}</b><small>Ganancia bruta</small></button><button onClick={() => setTrace("profit")}><b>{crc(data.metrics.cogs)}</b><small>COGS</small></button><button onClick={() => setTrace("sales")}><b>{crc(data.metrics.deliveryIncome)}</b><small>Ingresos por envío</small></button><button onClick={() => setTrace("profit")}><b>{data.metrics.marginPercent == null ? "No disponible" : `${data.metrics.marginPercent.toFixed(1)}%`}</b><small>Margen productos</small></button></section>
      {!data.metrics.costsComplete && <p className="alert warning"><AlertCircle />Al menos una venta no tiene costo histórico fiable. NutriPlus muestra ingresos y COGS conocido, pero no fabrica una ganancia total con el costo actual.</p>}
      <div className="finance-chart-grid"><section className="surface finance-chart"><h2>Ventas vs gastos</h2><div className="daily-bars">{data.charts.daily.length ? data.charts.daily.map((item) => <div key={item.date}><span>{item.date.slice(5)}</span><i style={{ height: `${Math.max(3, item.sales / maximumChart * 100)}%` }} title={`Ventas ${crc(item.sales)}`} /><em style={{ height: `${Math.max(3, item.expenses / maximumChart * 100)}%` }} title={`Gastos ${crc(item.expenses)}`} /></div>) : <p>Sin movimientos</p>}</div></section><section className="surface finance-chart"><h2>Gastos por categoría</h2><BarList items={data.charts.expenseByCategory.map((item) => ({ label: item.label, value: item.amount }))} /></section><section className="surface finance-chart"><h2>Productos con mayor ingreso</h2><BarList items={data.charts.topProducts.map((item) => ({ label: item.name, value: item.income }))} /></section><section className="surface finance-chart"><h2>Entradas vs salidas de caja</h2><BarList items={[{ label: "Caja", value: data.cash.incoming, secondary: data.cash.outgoing }]} /></section></div>
      <section className="surface finance-daily"><header><CalendarDays /><div><h2>Cierre diario verificable</h2><p>{data.dailySummary.date} · resumen, no cierre irreversible</p></div></header><div><span><small>Ventas entregadas</small><b>{crc(data.dailySummary.deliveredSales)}</b></span><span><small>Cobros</small><b>{crc(data.dailySummary.collections)}</b></span><span><small>Gastos</small><b>{crc(data.dailySummary.expenses)}</b></span><span><small>Entradas</small><b>{crc(data.dailySummary.cashIn)}</b></span><span><small>Salidas</small><b>{crc(data.dailySummary.cashOut)}</b></span><span><small>Flujo neto</small><b>{crc(data.dailySummary.netCash)}</b></span></div></section>
      {data.budgets.length > 0 && <section className="surface budget-list"><h2>Presupuesto vs gasto</h2>{data.budgets.map((item) => <article key={item.id}><div><b>{item.categoryLabel}</b><small>{item.yearMonth}</small></div><span>Presupuesto <b>{crc(item.amountCrc)}</b></span><span>Gastado <b>{crc(item.spent)}</b></span><span className={item.available < 0 ? "negative" : ""}>Disponible <b>{crc(item.available)}</b></span></article>)}</section>}</>}

    {view === "sales" && <section className="surface finance-list"><header><h2>Ventas reconocidas</h2><span>{data.sales.length}</span></header>{data.sales.length ? data.sales.map((sale) => <button key={sale.id} onClick={() => onOpenOrder(sale.orderId)}><div><b>{sale.orderNumber} · {sale.customerName}</b><small>{sale.deliveredDate}</small></div><span><small>Productos</small><b>{crc(sale.productNet)}</b></span><span><small>Envío</small><b>{crc(sale.deliveryIncome)}</b></span><span><small>COGS</small><b>{crc(sale.cogs)}</b></span><ChevronRight /></button>) : <p className="empty-summary">No hay pedidos entregados en este período.</p>}</section>}

    {view === "expenses" && <div className="finance-expenses-layout"><form className="surface finance-form" onSubmit={(event) => void saveExpense(event)}><header><Receipt /><div><h2>Registrar gasto</h2><p>Confirmado, auditable e idempotente.</p></div></header><div className="two"><label className="field"><span>Fecha</span><input type="date" value={expense.date} onChange={(event) => setExpense({ ...expense, date: event.target.value })} required /></label><label className="field"><span>Categoría</span><select value={expense.category} onChange={(event) => setExpense({ ...expense, category: event.target.value, invoiceId: event.target.value === "INVENTORY_PURCHASE" ? expense.invoiceId : "", paidConfirmed: false })}>{data.categories.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</select></label></div><label className="field"><span>Descripción</span><input value={expense.description} onChange={(event) => setExpense({ ...expense, description: event.target.value })} placeholder="Qué se pagó" required /></label><div className="three"><label className="field"><span>Monto</span><input type="number" min="0.01" step={expense.currency === "USD" ? ".01" : "1"} value={expense.amount} onChange={(event) => setExpense({ ...expense, amount: event.target.value })} required /></label><label className="field"><span>Moneda</span><select value={expense.currency} onChange={(event) => setExpense({ ...expense, currency: event.target.value })}><option value="CRC">CRC</option><option value="USD">USD</option></select></label>{expense.currency === "USD" && <label className="field"><span>Tipo de cambio</span><input type="number" min="1" step="1" value={expense.exchangeRate} onChange={(event) => setExpense({ ...expense, exchangeRate: event.target.value })} required /></label>}<label className="field"><span>Método</span><select value={expense.paymentMethod} onChange={(event) => setExpense({ ...expense, paymentMethod: event.target.value })}><option value="CASH">Efectivo</option><option value="SINPE">SINPE</option><option value="CARD">Tarjeta</option><option value="OTHER">Otro</option></select></label></div><div className="three"><label className="field"><span>Proveedor/comercio</span><input value={expense.provider} onChange={(event) => setExpense({ ...expense, provider: event.target.value })} /></label><label className="field"><span>Ruta asociada</span><select value={expense.routeId} onChange={(event) => setExpense({ ...expense, routeId: event.target.value })}><option value="">Ninguna</option>{data.routes.map((route) => <option value={route.id} key={route.id}>{route.date} · {route.label || "Ruta"}</option>)}</select></label><label className="field"><span>Pedido asociado</span><select value={expense.orderId} onChange={(event) => setExpense({ ...expense, orderId: event.target.value })}><option value="">Ninguno</option>{data.sales.map((sale) => <option value={sale.orderId} key={sale.id}>{sale.orderNumber} · {sale.customerName}</option>)}</select></label></div>{expense.category === "INVENTORY_PURCHASE" && <div className="invoice-link"><label className="field"><span>Factura de Inventario opcional</span><select value={expense.invoiceId} onChange={(event) => setExpense({ ...expense, invoiceId: event.target.value, paidConfirmed: false })}><option value="">Gasto manual sin factura vinculada</option>{data.invoices.map((invoice) => <option value={invoice.id} disabled={invoice.alreadyLinked} key={invoice.id}>{invoice.provider} · {invoice.invoiceNumber || invoice.orderNumber || invoice.documentDate || "Factura"}{invoice.alreadyLinked ? " · ya registrada" : ""}</option>)}</select></label>{expense.invoiceId && <label className="check-line"><input type="checkbox" checked={expense.paidConfirmed} onChange={(event) => setExpense({ ...expense, paidConfirmed: event.target.checked })} /><span><b>Confirmo que esta factura fue pagada</b><small>Solo entonces se registra una salida de caja. No afecta COGS hasta vender unidades.</small></span></label>}</div>}<label className="field"><span>Notas</span><textarea value={expense.notes} onChange={(event) => setExpense({ ...expense, notes: event.target.value })} /></label><label className="check-line personal"><input type="checkbox" checked={expense.personal} onChange={(event) => setExpense({ ...expense, personal: event.target.checked })} /><span><b>Personal / excluir de NutriPlus</b><small>No afectará dashboard, gastos operativos ni rentabilidad.</small></span></label><button className="btn primary full" disabled={busy || !expense.description.trim() || !expense.amount || Boolean(expense.invoiceId && !expense.paidConfirmed)}>{busy ? <Loader2 className="spin" /> : <Plus />}Registrar gasto</button></form>
      <section className="surface finance-list expense-history"><header><h2>Historial de gastos</h2><span>{data.expenses.length}</span></header>{data.expenses.length ? data.expenses.map((item) => <article className={`${item.entryType.toLowerCase()} ${item.businessScope.toLowerCase()}`} key={item.id}><div><b>{item.categoryLabel} · {item.description}</b><small>{item.date} · {item.paymentMethod}{item.provider ? ` · ${item.provider}` : ""}{item.businessScope === "PERSONAL" ? " · Excluido" : ""}</small></div><strong>{item.entryType === "REVERSAL" ? "+" : "-"}{crc(item.amountCrc)}</strong>{item.entryType === "EXPENSE" && <button className="btn ghost small" onClick={() => { setReversal(item); setReversalReason(""); }}><RotateCcw />Reversar</button>}</article>) : <p className="empty-summary">No hay gastos en este período.</p>}</section>
      <details className="surface finance-secondary-form"><summary>Gastos recurrentes</summary><form onSubmit={(event) => void saveTemplate(event)}><p>La plantilla no se paga sola: cada gasto se confirma explícitamente.</p><div className="two"><label className="field"><span>Nombre</span><input value={template.name} onChange={(event) => setTemplate({ ...template, name: event.target.value })} required /></label><label className="field"><span>Categoría</span><select value={template.category} onChange={(event) => setTemplate({ ...template, category: event.target.value })}>{data.categories.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</select></label></div><div className="three"><label className="field"><span>Monto esperado</span><input type="number" min="1" step="1" value={template.amount} onChange={(event) => setTemplate({ ...template, amount: event.target.value })} required /></label><label className="field"><span>Frecuencia</span><select value={template.frequency} onChange={(event) => setTemplate({ ...template, frequency: event.target.value })}><option value="WEEKLY">Semanal</option><option value="MONTHLY">Mensual</option><option value="QUARTERLY">Trimestral</option><option value="YEARLY">Anual</option></select></label><label className="field"><span>Próximo vencimiento</span><input type="date" value={template.nextDueDate} onChange={(event) => setTemplate({ ...template, nextDueDate: event.target.value })} /></label></div><button className="btn secondary"><Plus />Guardar plantilla</button></form><div className="recurring-list">{data.recurringTemplates.map((item) => <article key={item.id}><div><b>{item.name}</b><small>{item.categoryLabel} · vence {item.nextDueDate}</small></div><strong>{crc(item.amountCrc)}</strong><button className="btn primary small" onClick={() => void generateTemplate(item.id)} disabled={busy}><Check />Confirmar gasto</button></article>)}</div></details>
      <details className="surface finance-secondary-form"><summary>Presupuesto mensual</summary><form onSubmit={(event) => void saveBudget(event)}><div className="three"><label className="field"><span>Categoría</span><select value={budget.category} onChange={(event) => setBudget({ ...budget, category: event.target.value })}>{data.categories.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</select></label><label className="field"><span>Mes</span><input type="month" value={budget.yearMonth} onChange={(event) => setBudget({ ...budget, yearMonth: event.target.value })} /></label><label className="field"><span>Presupuesto</span><input type="number" min="1" step="1" value={budget.amount} onChange={(event) => setBudget({ ...budget, amount: event.target.value })} required /></label></div><button className="btn secondary"><Check />Guardar presupuesto</button></form></details></div>}

    {view === "cash" && <><section className="finance-kpis secondary cash"><span><b>{crc(data.cash.incoming)}</b><small>Entradas reales</small></span><span><b>{crc(data.cash.outgoing)}</b><small>Salidas reales</small></span><span><b>{crc(data.cash.net)}</b><small>Flujo neto</small></span></section><section className="surface cash-methods"><h2>Por método</h2>{Object.entries(data.cash.methods).map(([method, item]) => <article key={method}><b>{method === "CASH" ? "Efectivo" : method === "SINPE" ? "SINPE" : method === "CARD" ? "Tarjeta" : "Otro"}</b><span>Entradas {crc(item.incoming)}</span><span>Salidas {crc(item.outgoing)}</span><strong>{crc(item.net)}</strong></article>)}</section><section className="surface finance-list"><header><h2>Movimientos de caja</h2></header>{[...data.cash.payments.map((item) => ({ id: item.id, date: item.createdAt, label: `${item.orderNumber} · ${item.customerName}`, method: item.method, amount: item.signedAmount })), ...data.cash.expenses.map((item) => ({ id: item.id, date: item.date, label: item.description, method: item.paymentMethod, amount: item.entryType === "REVERSAL" ? item.amountCrc : -item.amountCrc }))].sort((a, b) => b.date.localeCompare(a.date)).map((item) => <article key={item.id}><div><b>{item.label}</b><small>{item.date.replace("T", " ").slice(0, 16)} · {item.method}</small></div><strong className={item.amount < 0 ? "negative" : "positive"}>{item.amount < 0 ? "-" : "+"}{crc(Math.abs(item.amount))}</strong></article>)}</section></>}

    {view === "receivables" && <><section className="surface finance-list receivables"><header><h2>Cuentas por cobrar</h2><span>{data.receivables.length}</span></header>{data.receivables.length ? data.receivables.map((item) => <button key={item.id} onClick={() => onOpenOrder(item.orderId)}><div><b>{item.orderNumber} · {item.customerName}</b><small>Entregado {item.deliveredDate} · {item.ageDays} días pendiente</small></div><span><small>Total</small><b>{crc(item.totalIncome)}</b></span><span><small>Abonado</small><b>{crc(item.paidTotal)}</b></span><span><small>Saldo</small><b>{crc(item.balance)}</b></span><ChevronRight /></button>) : <p className="empty-summary">No hay ventas entregadas con saldo pendiente.</p>}</section><section className="surface empty-payables"><Banknote /><div><h2>Cuentas por pagar</h2><p>No hay compras a crédito registradas. Las facturas pagadas no se convierten en obligaciones.</p></div></section></>}

    {view === "profitability" && <><section className="surface finance-list"><header><h2>Por producto</h2></header>{data.profitability.products.map((item) => <article key={`${item.productId}-${item.name}`}><div><b>{item.name}</b><small>{item.units} unidad{item.units === 1 ? "" : "es"} · ingreso {crc(item.income)}</small></div><span><small>COGS</small><b>{crc(item.cogs)}</b></span><span><small>Ganancia</small><b className={item.profit != null && item.profit < 0 ? "negative" : ""}>{crc(item.profit)}</b></span><span><small>Margen</small><b>{item.marginPercent == null ? "No disponible" : `${item.marginPercent.toFixed(1)}%`}</b></span></article>)}</section><section className="surface finance-list"><header><h2>Por pedido</h2></header>{data.profitability.orders.map((item) => <button key={item.id} onClick={() => onOpenOrder(item.orderId)}><div><b>{item.orderNumber} · {item.customerName}</b><small>Productos {crc(item.productNet)} · descuento -{crc(item.discount)} · envío +{crc(item.deliveryIncome)} · gasto directo -{crc(item.directExpenses)}</small></div><span><small>COGS</small><b>{crc(item.cogs)}</b></span><span><small>Resultado</small><b>{crc(item.result)}</b></span><ChevronRight /></button>)}</section><section className="surface finance-list"><header><h2>Por ruta</h2></header>{data.profitability.routes.length ? data.profitability.routes.map((item) => <article key={item.routeId}><div><b>{item.date} · {item.label}</b><small>Productos {crc(item.products)} + envíos {crc(item.delivery)} - gastos directos {crc(item.expenses)}</small></div><span><small>COGS</small><b>{crc(item.cogs)}</b></span><span><small>Resultado</small><b>{crc(item.result)}</b></span></article>) : <p className="empty-summary">No hay ventas entregadas vinculadas a rutas en este período.</p>}</section></>}

    {trace && <div className="modal" role="dialog" aria-modal="true" aria-label="Detalle de cifra financiera" onPointerDown={() => setTrace(null)}><div className="finance-trace" onPointerDown={(event) => event.stopPropagation()}><header><div><span className="eyebrow">Origen de la cifra</span><h2>{trace === "sales" ? "Ventas" : trace === "profit" ? "Ganancia neta" : trace === "expenses" ? "Gastos operativos" : "Flujo de caja"}</h2></div><button className="icon-btn" onClick={() => setTrace(null)}><X /></button></header>{trace === "profit" && <div className="trace-equation"><span>Ventas productos <b>{crc(data.sales.reduce((sum, sale) => sum + sale.productNet, 0))}</b></span><span>+ Envíos <b>{crc(data.metrics.deliveryIncome)}</b></span><span>- COGS <b>{crc(data.metrics.cogs)}</b></span><span>- Gastos operativos <b>{crc(data.metrics.operatingExpenses)}</b></span><strong>= {crc(data.metrics.netProfit)}</strong></div>}{(trace === "sales" || trace === "profit") && <div className="trace-list">{data.sales.map((sale) => <button onClick={() => onOpenOrder(sale.orderId)} key={sale.id}><span>{sale.orderNumber} · {sale.customerName}</span><b>{crc(sale.totalIncome)}</b></button>)}</div>}{trace === "expenses" && <div className="trace-list">{data.expenses.filter((item) => item.businessScope === "BUSINESS" && item.category !== "INVENTORY_PURCHASE").map((item) => <span key={item.id}><i>{item.date} · {item.description}</i><b>{item.entryType === "REVERSAL" ? "+" : "-"}{crc(item.amountCrc)}</b></span>)}</div>}{trace === "cash" && <div className="trace-equation"><span>Entradas <b>{crc(data.cash.incoming)}</b></span><span>- Salidas <b>{crc(data.cash.outgoing)}</b></span><strong>= {crc(data.cash.net)}</strong></div>}</div></div>}
    {reversal && <div className="modal" role="alertdialog" aria-modal="true" aria-label="Reversar gasto"><div className="confirm-card"><RotateCcw /><h2>Reversar gasto</h2><p>El movimiento original permanecerá visible. Se agregará una reversa por {crc(reversal.amountCrc)}.</p><label className="field"><span>Motivo obligatorio</span><textarea value={reversalReason} onChange={(event) => setReversalReason(event.target.value)} /></label><div className="confirm-actions"><button className="btn secondary" onClick={() => setReversal(null)}>Cancelar</button><button className="btn primary" onClick={() => void reverse()} disabled={busy || reversalReason.trim().length < 3}>{busy ? <Loader2 className="spin" /> : <RotateCcw />}Registrar reversa</button></div></div></div>}
  </div>;
}
