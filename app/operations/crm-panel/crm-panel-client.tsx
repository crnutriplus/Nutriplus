"use client";

import { AlertCircle, CalendarDays, ChevronLeft, ExternalLink, Loader2, MapPin, Minus, Package, Plus, ReceiptText, RefreshCw, Search, ShieldCheck, ShoppingCart, Trash2, UserRound, WalletCards } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type Context = { accountId: string; contactId: string; conversationId: string };
type Order = { id: string; orderNumber: string; orderType: string; status: string; total: number; paidTotal: number; balance: number; paymentStatus: string; deliveryMethod: string | null; deliveryDate: string | null; createdAt: string };
type Customer = { id: string; name: string; phone: string | null; customerStatus: string; province: string | null; canton: string | null; district: string | null; defaultDeliveryAddress: string | null; locationUrl: string | null; locationReference: string | null; latitude: number | null; longitude: number | null; preferredPaymentMethod: string | null; ordersCount: number; lastOrderDate: string | null };
export type Panel = { customer: Customer; activeOrders: Order[]; recentOrders: Order[]; conversationOrders: Order[] };
type Detail = { order: Order & { deliveryAddress: string | null; deliveryInstructions: string | null; province: string | null; canton: string | null; district: string | null; locationUrl: string | null; latitude: number | null; longitude: number | null; expectedPaymentMethod: string | null; deliveryNotes: string | null; specialOrderStatus: string | null; lines: Array<{ product_name_snapshot: string; presentation_snapshot: string | null; quantity: number; unit_price_original: number | null; unit_price_sold: number; discount_amount: number; line_total: number }>; payments: Array<{ amount: number; method: string; payment_type: string; reference: string | null; created_at: string }> } };
type SearchProduct = { id: number; kind: "INVENTORY" | "SPECIAL_ORDER"; name: string; brand: string | null; presentation: string | null; code: string | null; commercialPrice: number | null; quantityAvailable: number | null; availability: "AVAILABLE" | "OUT_OF_STOCK" | "SPECIAL_ORDER" | "PRICE_UNAVAILABLE" };
type CartLine = Omit<SearchProduct, "commercialPrice" | "availability"> & { commercialPrice: number; availability: "AVAILABLE" | "SPECIAL_ORDER"; quantity: number; discountAmount: number };

const money = new Intl.NumberFormat("es-CR", { style: "currency", currency: "CRC", maximumFractionDigits: 0 });
const date = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("es-CR", { dateStyle: "medium" }).format(new Date(value)) : "—";
function query(context: Context) { const params = new URLSearchParams(); if (context.accountId) params.set("account_id", context.accountId); if (context.contactId) params.set("contact_id", context.contactId); if (context.conversationId) params.set("conversation_id", context.conversationId); return params.toString(); }
function mapUrl(latitude: number | null, longitude: number | null) { return latitude != null && longitude != null ? `https://www.google.com/maps?q=${latitude},${longitude}` : null; }

export function CrmPanelClient({ context, userName, initialPanel = null }: { context: Context; userName: string; initialPanel?: Panel | null }) {
  const params = useMemo(() => query(context), [context]);
  const [panel, setPanel] = useState<Panel | null>(initialPanel);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initialPanel);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const load = useCallback(async () => { setLoading(true); setError(null); setDetail(null); try { const response = await fetch(`/api/operations/crm-panel?${params}`, { cache: "no-store" }); const body = await response.json() as Panel & { error?: { message?: string } }; if (!response.ok) throw new Error(body.error?.message || "No se pudo consultar el cliente."); setPanel(body); } catch (cause) { setPanel(null); setError(cause instanceof Error ? cause.message : "No se pudo consultar el cliente."); } finally { setLoading(false); } }, [params]);
  useEffect(() => {
    if (initialPanel) return;
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [initialPanel, load]);
  async function openOrder(id: string) { setLoadingDetail(true); setError(null); try { const response = await fetch(`/api/operations/crm-panel/orders/${encodeURIComponent(id)}?${params}`, { cache: "no-store" }); const body = await response.json() as Detail & { error?: { message?: string } }; if (!response.ok) throw new Error(body.error?.message || "No se pudo abrir el pedido."); setDetail(body); } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo abrir el pedido."); } finally { setLoadingDetail(false); } }
  if (loading) return <main className="crm-panel-shell"><div className="crm-panel-loading"><Loader2 className="spin" /> Cargando consulta CRM…</div></main>;
  if (error || !panel) return <main className="crm-panel-shell"><section className="crm-panel-error"><AlertCircle /><div><h1>Consulta CRM</h1><p>{error || "No se encontró información disponible."}</p><button type="button" onClick={() => void load()}><RefreshCw /> Reintentar</button></div></section></main>;
  const { customer } = panel, location = customer.locationUrl || mapUrl(customer.latitude, customer.longitude);
  return <main className="crm-panel-shell"><header className="crm-panel-header"><div><p className="crm-panel-eyebrow"><ShieldCheck /> Contexto validado</p><h1>Consulta CRM</h1><p>Conversación de Chatwoot · Sesión: {userName}</p></div><button className="crm-panel-icon" type="button" aria-label="Actualizar consulta" onClick={() => void load()}><RefreshCw /></button></header>
    <section className="crm-panel-card crm-panel-customer"><div className="crm-panel-title"><UserRound /><div><h2>{customer.name}</h2><p>{customer.phone || "Sin teléfono"} · {customer.customerStatus}</p></div></div><div className="crm-panel-stats"><span><strong>{customer.ordersCount}</strong> pedidos</span><span><strong>{date(customer.lastOrderDate)}</strong> última compra</span></div><details open><summary>Dirección y ubicación</summary><p>{[customer.defaultDeliveryAddress, customer.district, customer.canton, customer.province].filter(Boolean).join(", ") || "Sin dirección registrada"}</p>{customer.locationReference && <p className="crm-panel-muted">{customer.locationReference}</p>}{location && <a className="crm-panel-link" href={location} target="_blank" rel="noreferrer"><MapPin /> Abrir ubicación <ExternalLink /></a>}</details><p className="crm-panel-muted">Pago preferido: {customer.preferredPaymentMethod || "No definido"}</p></section>
    {detail ? <OrderDetail detail={detail} onBack={() => setDetail(null)} /> : <><OrderComposer context={context} customer={customer} onCreated={load} /><OrderList title="Pedidos activos" icon={<Package />} orders={panel.activeOrders} onOpen={openOrder} loading={loadingDetail} empty="No hay pedidos activos." />{panel.conversationOrders.length > 0 && <OrderList title="Pedidos vinculados a esta conversación" icon={<ReceiptText />} orders={panel.conversationOrders} onOpen={openOrder} loading={loadingDetail} empty="" />}{panel.recentOrders.length > 0 && <OrderList title="Historial reciente" icon={<CalendarDays />} orders={panel.recentOrders} onOpen={openOrder} loading={loadingDetail} empty="" />}{panel.recentOrders.length === 0 && <section className="crm-panel-card crm-panel-empty"><Package /><p>Este cliente todavía no tiene pedidos.</p></section>}</>}
  </main>;
}

function OrderList({ title, icon, orders, onOpen, loading, empty }: { title: string; icon: ReactNode; orders: Order[]; onOpen: (id: string) => void; loading: boolean; empty: string }) { return <section className="crm-panel-card"><h2 className="crm-panel-section-title">{icon}{title}</h2>{orders.length === 0 ? <p className="crm-panel-muted">{empty}</p> : <div className="crm-panel-orders">{orders.map((order) => <article className="crm-panel-order" key={order.id}><div><strong>{order.orderNumber}</strong><p>{date(order.createdAt)} · {order.status}</p><p>{order.orderType === "SPECIAL_ORDER" ? "Encargo" : "Pedido"} · {order.paymentStatus}</p></div><div className="crm-panel-order-side"><strong>{money.format(order.total)}</strong><span>Saldo {money.format(order.balance)}</span><button type="button" onClick={() => void onOpen(order.id)} disabled={loading}>Ver pedido</button></div></article>)}</div>}</section>; }

function OrderDetail({ detail, onBack }: { detail: Detail; onBack: () => void }) { const order = detail.order, location = order.locationUrl || mapUrl(order.latitude, order.longitude); return <><button className="crm-panel-back" type="button" onClick={onBack}><ChevronLeft /> Volver a pedidos</button><section className="crm-panel-card"><h2 className="crm-panel-section-title"><ReceiptText /> {order.orderNumber}</h2><div className="crm-panel-detail-grid"><span>Estado<strong>{order.status}</strong></span><span>Pago<strong>{order.paymentStatus}</strong></span><span>Total<strong>{money.format(order.total)}</strong></span><span>Saldo<strong>{money.format(order.balance)}</strong></span><span>Entrega<strong>{order.deliveryDate ? date(order.deliveryDate) : "Sin fecha"}</strong></span><span>Método<strong>{order.expectedPaymentMethod || "No definido"}</strong></span></div>{order.specialOrderStatus && <p className="crm-panel-badge">Encargo: {order.specialOrderStatus}</p>}<details open><summary>Productos</summary>{order.lines.map((line, index) => <div className="crm-panel-line" key={`${line.product_name_snapshot}-${index}`}><span><strong>{line.product_name_snapshot}</strong><small>{line.presentation_snapshot || ""} · {line.quantity} unidad(es)</small></span><span>{money.format(line.line_total)}{line.discount_amount > 0 && <small>Descuento {money.format(line.discount_amount)}</small>}</span></div>)}</details><details><summary>Pagos y abonos</summary>{order.payments.length ? order.payments.map((payment, index) => <div className="crm-panel-line" key={`${payment.created_at}-${index}`}><span><strong>{payment.payment_type}</strong><small>{payment.method} · {date(payment.created_at)} {payment.reference ? `· ${payment.reference}` : ""}</small></span><span>{money.format(payment.amount)}</span></div>) : <p className="crm-panel-muted">No hay pagos registrados.</p>}</details><details><summary>Entrega</summary><p>{[order.deliveryAddress, order.district, order.canton, order.province].filter(Boolean).join(", ") || "Sin dirección registrada"}</p>{order.deliveryInstructions && <p className="crm-panel-muted">{order.deliveryInstructions}</p>}{order.deliveryNotes && <p className="crm-panel-muted">{order.deliveryNotes}</p>}{location && <a className="crm-panel-link" href={location} target="_blank" rel="noreferrer"><MapPin /> Abrir ubicación <ExternalLink /></a>}</details></section><section className="crm-panel-card crm-panel-readonly"><WalletCards /><p>La consulta conserva los datos canónicos. Desde el carrito solo se crean borradores: no registra pagos, no modifica clientes ni descuenta inventario.</p></section></>; }

function OrderComposer({ context, customer, onCreated }: { context: Context; customer: Customer; onCreated: () => Promise<void> }) {
  const [term, setTerm] = useState(""); const [results, setResults] = useState<SearchProduct[]>([]); const [cart, setCart] = useState<CartLine[]>([]); const [message, setMessage] = useState<string | null>(null); const [searching, setSearching] = useState(false); const [submitting, setSubmitting] = useState(false); const [deliveryAddress, setDeliveryAddress] = useState(customer.defaultDeliveryAddress || ""); const [scheduledDeliveryDate, setScheduledDeliveryDate] = useState(""); const [expectedPaymentMethod, setExpectedPaymentMethod] = useState(customer.preferredPaymentMethod || "");
  const params = query(context); const total = cart.reduce((sum, line) => sum + line.quantity * line.commercialPrice - line.discountAmount, 0); const cartKind = cart[0]?.kind;
  const searchRequest = useRef(0);
  const searchAbort = useRef<AbortController | null>(null);
  const search = useCallback(async (value: string) => {
    const current = value.trim();
    if (!current) {
      searchRequest.current += 1;
      searchAbort.current?.abort();
      searchAbort.current = null;
      setResults([]);
      setSearching(false);
      setMessage(null);
      return;
    }
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    const requestId = ++searchRequest.current;
    setSearching(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/operations/crm-panel/products?q=${encodeURIComponent(current)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json() as { products?: SearchProduct[]; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message || "No se pudo buscar.");
      if (requestId === searchRequest.current) setResults(body.products || []);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      if (requestId === searchRequest.current) setMessage(error instanceof Error ? error.message : "No se pudo buscar.");
    } finally {
      if (searchAbort.current === controller) searchAbort.current = null;
      if (requestId === searchRequest.current) setSearching(false);
    }
  }, []);

  useEffect(() => {
    const current = term.trim();
    if (!current) return;
    const timer = window.setTimeout(() => void search(current), 100);
    return () => window.clearTimeout(timer);
  }, [term, search]);

  function add(product: SearchProduct) { if (cartKind && cartKind !== product.kind) { setMessage("Inventario y Encargo se crean como pedidos separados."); return; } if (product.availability === "OUT_OF_STOCK") { setMessage("Este producto no tiene stock disponible. Podés buscar un Encargo si corresponde."); return; } if (product.availability === "PRICE_UNAVAILABLE" || product.commercialPrice == null) { setMessage("Este producto todavía no tiene un precio comercial disponible."); return; } const sellable = { ...product, commercialPrice: product.commercialPrice, availability: product.availability }; setCart((current) => { const found = current.find((line) => line.id === product.id && line.kind === product.kind); return found ? current.map((line) => line === found ? { ...line, quantity: line.quantity + 1 } : line) : [...current, { ...sellable, quantity: 1, discountAmount: 0 }]; }); setMessage(null); }
  function change(id: number, kind: CartLine["kind"], patch: Partial<CartLine>) { setCart((current) => current.map((line) => line.id === id && line.kind === kind ? { ...line, ...patch } : line)); }
  async function createDraft() { if (!cart.length || submitting) return; if (!window.confirm("¿Crear este borrador? No descuenta inventario ni registra pagos.")) return; setSubmitting(true); setMessage(null); try { const response = await fetch(`/api/operations/crm-panel/orders?${params}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: `crm-mobile-${crypto.randomUUID()}`, deliveryAddress, scheduledDeliveryDate: scheduledDeliveryDate || null, expectedPaymentMethod: expectedPaymentMethod || null, lines: cart.map(({ id, kind, quantity, discountAmount }) => ({ id, kind, quantity, discountAmount })) }) }); const body = await response.json() as { order?: { orderNumber?: string }; error?: { message?: string } }; if (!response.ok) throw new Error(body.error?.message || "No se pudo crear el borrador."); setCart([]); setResults([]); setTerm(""); setMessage(`Borrador ${body.order?.orderNumber || ""} creado. El inventario no fue modificado.`); await onCreated(); } catch (error) { setMessage(error instanceof Error ? error.message : "No se pudo crear el borrador."); } finally { setSubmitting(false); } }
  return <section className="crm-panel-card crm-panel-composer"><h2 className="crm-panel-section-title"><ShoppingCart /> Crear borrador</h2><p className="crm-panel-muted">Precio validado por NutriPlus. El método de pago esperado no registra un pago.</p><div className="crm-panel-search"><input value={term} onChange={(event) => {
      const value = event.target.value;
      setTerm(value);
      searchRequest.current += 1;
      searchAbort.current?.abort();
      searchAbort.current = null;
      if (!value.trim()) {
        searchRequest.current += 1;
        setResults([]);
        setSearching(false);
        setMessage(null);
      }
    }} onKeyDown={(event) => { if (event.key === "Enter") void search(term); }} placeholder="Buscar nombre, marca, presentación o código" /><button type="button" onClick={() => void search(term)} disabled={searching}><Search /> Buscar</button></div>{results.map((product) => <article className="crm-panel-product" key={`${product.kind}-${product.id}`}><div><strong>{product.name}</strong><small>{[product.brand, product.presentation, product.code].filter(Boolean).join(" · ") || "Sin presentación"}</small><small className={`crm-panel-availability ${product.availability.toLowerCase()}`}>{product.availability === "AVAILABLE" ? `Disponible · ${product.quantityAvailable} unidades` : product.availability === "SPECIAL_ORDER" ? "Encargo" : product.availability === "PRICE_UNAVAILABLE" ? "Precio no disponible" : "Sin stock"}</small></div><div><strong>{product.commercialPrice == null ? "Precio no disponible" : money.format(product.commercialPrice)}</strong><button type="button" onClick={() => add(product)} disabled={product.availability === "OUT_OF_STOCK" || product.availability === "PRICE_UNAVAILABLE" || product.commercialPrice == null}><Plus /> Agregar</button></div></article>)}{cart.length > 0 && <><h3 className="crm-panel-cart-title">Carrito</h3>{cart.map((line) => <article className="crm-panel-cart-line" key={`${line.kind}-${line.id}`}><div><strong>{line.name}</strong><small>{line.kind === "SPECIAL_ORDER" ? "Encargo" : "Inventario"} · {money.format(line.commercialPrice)} c/u</small></div><div className="crm-panel-cart-actions"><button type="button" aria-label="Restar cantidad" onClick={() => change(line.id, line.kind, { quantity: Math.max(1, line.quantity - 1) })}><Minus /></button><strong>{line.quantity}</strong><button type="button" aria-label="Sumar cantidad" onClick={() => change(line.id, line.kind, { quantity: line.quantity + 1 })}><Plus /></button><button type="button" aria-label="Eliminar línea" onClick={() => setCart((current) => current.filter((item) => item !== line))}><Trash2 /></button></div><label className="crm-panel-discount">Descuento ₡<input type="number" min="0" max={line.quantity * line.commercialPrice} value={line.discountAmount} onChange={(event) => change(line.id, line.kind, { discountAmount: Math.max(0, Math.min(line.quantity * line.commercialPrice, Number(event.target.value) || 0)) })} /></label></article>)}<div className="crm-panel-order-fields"><label>Dirección<input value={deliveryAddress} onChange={(event) => setDeliveryAddress(event.target.value)} /></label><label>Fecha de entrega<input type="date" value={scheduledDeliveryDate} onChange={(event) => setScheduledDeliveryDate(event.target.value)} disabled={cartKind === "SPECIAL_ORDER"} /></label><label>Pago esperado<select value={expectedPaymentMethod} onChange={(event) => setExpectedPaymentMethod(event.target.value)}><option value="">No definido</option><option value="CASH">Efectivo</option><option value="SINPE">SINPE</option><option value="CARD">Tarjeta</option><option value="OTHER">Otro</option></select></label></div><div className="crm-panel-cart-total"><span>Total</span><strong>{money.format(total)}</strong></div><button className="crm-panel-create" type="button" disabled={submitting} onClick={() => void createDraft()}>{submitting ? <Loader2 className="spin" /> : <ShoppingCart />} Crear borrador</button></>}{message && <p className="crm-panel-composer-message">{message}</p>}</section>;
}
