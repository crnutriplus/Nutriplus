"use client";

import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Banknote,
  CalendarDays,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Eye,
  History,
  Loader2,
  MapPin,
  Package,
  PackageCheck,
  Pencil,
  Phone,
  Plus,
  Save,
  Search,
  ShoppingBag,
  Trash2,
  Truck,
  UserRound,
  WalletCards,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  calculatePrices,
  crc,
  hasCompletePricing,
  normalizeName,
  type NonInventoryRecord,
  type PricingSettings,
  type ProductRecord,
  searchProducts,
} from "@/lib/pricing";

export type OrderScanEvent = { code: string; nonce: number } | null;

type OrderStatus = "DRAFT" | "CONFIRMED" | "PREPARED" | "DELIVERED" | "CANCELLED" | "REOPENED";
type OrderType = "STANDARD" | "SPECIAL_ORDER";
type PaymentMethod = "CASH" | "SINPE" | "CARD" | "OTHER";

type OrderLine = {
  id: string;
  position: number;
  productId: number | null;
  quantity: number;
  productName: string;
  presentation: string | null;
  barcode: string | null;
  unitPriceOriginal: number | null;
  unitPriceSold: number;
  discountAmount: number;
  lineSubtotal: number;
  lineTotal: number;
  deliveredQuantity: number;
  pendingDeliveryQuantity: number;
  returnedQuantity: number;
  receivedQuantity: number;
  pendingReceiptQuantity: number;
};

type OrderPayment = {
  id: string;
  amount: number;
  method: PaymentMethod;
  type: "PAYMENT" | "REVERSAL" | "REFUND" | "VOID";
  status: string;
  reference: string | null;
  reason: string | null;
  createdAt: string;
};

export type OrderRecord = {
  id: string;
  orderNumber: string;
  orderType: OrderType;
  customerName: string;
  phoneRaw: string | null;
  phoneNormalized: string | null;
  deliveryAddress: string | null;
  deliveryInstructions: string | null;
  scheduledDeliveryDate: string | null;
  status: OrderStatus;
  subtotal: number;
  discountTotal: number;
  deliveryFee: number;
  total: number;
  expectedPaymentMethod: PaymentMethod | null;
  specialOrderStatus: string | null;
  estimatedArrivalDate: string | null;
  receiptResolvedAt: string | null;
  paidTotal: number;
  balance: number;
  paymentStatus: "PENDING" | "PARTIAL" | "PAID";
  internalNotes: string | null;
  deliveryNotes: string | null;
  source: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  preparedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  reopenedAt: string | null;
  lineCount: number;
  unitTotal: number;
  productSummary: string | null;
  routeId: string | null;
  routePosition: number | null;
  lines?: OrderLine[];
  removedLines?: OrderLine[];
  payments?: OrderPayment[];
  route?: { id: string; date: string; label: string | null; status: string; position: number } | null;
  specialOrder?: {
    status: string;
    requestedAt: string;
    orderedAt: string | null;
    estimatedArrivalDate: string | null;
    receivedAt: string | null;
    receiptResolvedAt: string | null;
  } | null;
};

type DraftLine = {
  key: string;
  id: string | null;
  productId: number | null;
  productName: string;
  quantity: string;
  unitPriceOriginal: number | null;
  unitPriceSold: string;
  discountAmount: string;
  barcode: string | null;
  presentation: string | null;
  source: "inventory" | "no_inventory" | "manual";
};

type OrderDraft = {
  id: string | null;
  version: number | null;
  status: OrderStatus;
  orderType: OrderType;
  customerName: string;
  phone: string;
  deliveryAddress: string;
  deliveryInstructions: string;
  scheduledDeliveryDate: string;
  estimatedArrivalDate: string;
  expectedPaymentMethod: "" | PaymentMethod;
  deliveryFee: string;
  internalNotes: string;
  deliveryNotes: string;
  lines: DraftLine[];
};

type Notice = { tone: "success" | "warning" | "error"; title: string; message: string } | null;
type OrdersSection = "deliveries" | "special" | "history";

type Props = {
  products: ProductRecord[];
  quotes: NonInventoryRecord[];
  settings: PricingSettings;
  scannedBarcode: OrderScanEvent;
  onConsumeScan: () => void;
  onRequestScan: () => void;
  onInventoryChanged: () => Promise<void> | void;
};

const STATUS_LABELS: Record<OrderStatus, string> = {
  DRAFT: "Borrador",
  CONFIRMED: "Confirmado",
  PREPARED: "Preparado",
  DELIVERED: "Entregado",
  CANCELLED: "Cancelado",
  REOPENED: "Reabierto",
};

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  CASH: "Efectivo",
  SINPE: "SINPE",
  CARD: "Tarjeta",
  OTHER: "Otro",
};

const SPECIAL_LABELS: Record<string, string> = {
  REQUESTED: "Solicitado / Pendiente de pedir",
  ORDERED_FROM_SUPPLIER: "Pedido al proveedor",
  IN_TRANSIT: "En tránsito / Esperando llegada",
  RECEIVED_PENDING_RESOLUTION: "Recibido / Pendiente de resolver",
  PARTIALLY_RECEIVED: "Recepción parcial",
  RECEIVED_READY: "Recibido / Listo para entregar",
  ADDED_TO_ROUTE: "Agregado a ruta",
  DELIVERED: "Entregado",
  CANCELLED: "Cancelado",
};

function operationId(label: string) {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${label}-${id}`;
}

function costaRicaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Costa_Rica",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function addDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return date.toISOString().slice(0, 10);
}

function dateLabel(value: string | null) {
  if (!value) return "Sin fecha";
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("es-CR", { weekday: "short", day: "numeric", month: "short", timeZone: "America/Costa_Rica" })
    .format(new Date(Date.UTC(year, month - 1, day, 18)));
}

function dateTimeLabel(value: string) {
  return new Intl.DateTimeFormat("es-CR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Costa_Rica",
  }).format(new Date(value));
}

function elapsedLabel(target: string | null) {
  if (!target) return null;
  const today = costaRicaDate();
  const difference = Math.round((Date.parse(`${target}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  if (difference === 0) return "Llega hoy";
  if (difference > 0) return `${difference} día${difference === 1 ? "" : "s"} restante${difference === 1 ? "" : "s"}`;
  return `${Math.abs(difference)} día${difference === -1 ? "" : "s"} de atraso`;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({})) as T & { error?: string; title?: string; code?: string };
  if (!response.ok) {
    const error = new Error(payload.error || "No pudimos completar la operación.") as Error & { title?: string; code?: string };
    error.title = payload.title;
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function emptyDraft(orderType: OrderType, date: string): OrderDraft {
  return {
    id: null,
    version: null,
    status: "DRAFT",
    orderType,
    customerName: "",
    phone: "",
    deliveryAddress: "",
    deliveryInstructions: "",
    scheduledDeliveryDate: orderType === "STANDARD" ? date : "",
    estimatedArrivalDate: "",
    expectedPaymentMethod: "",
    deliveryFee: "0",
    internalNotes: "",
    deliveryNotes: "",
    lines: [],
  };
}

function lineKey() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

function orderToDraft(order: OrderRecord): OrderDraft {
  return {
    id: order.id,
    version: order.version,
    status: order.status,
    orderType: order.orderType,
    customerName: order.customerName,
    phone: order.phoneRaw || "",
    deliveryAddress: order.deliveryAddress || "",
    deliveryInstructions: order.deliveryInstructions || "",
    scheduledDeliveryDate: order.scheduledDeliveryDate || "",
    estimatedArrivalDate: order.estimatedArrivalDate || "",
    expectedPaymentMethod: order.expectedPaymentMethod || "",
    deliveryFee: String(order.deliveryFee),
    internalNotes: order.internalNotes || "",
    deliveryNotes: order.deliveryNotes || "",
    lines: (order.lines || []).map((line) => ({
      key: lineKey(),
      id: line.id,
      productId: line.productId,
      productName: line.productName,
      quantity: String(line.quantity),
      unitPriceOriginal: line.unitPriceOriginal,
      unitPriceSold: String(line.unitPriceSold),
      discountAmount: String(line.discountAmount),
      barcode: line.barcode,
      presentation: line.presentation,
      source: line.productId ? "inventory" : "manual",
    })),
  };
}

function draftTotals(lines: DraftLine[], deliveryFee: string) {
  const subtotal = lines.reduce((sum, line) => sum + Math.max(0, Number(line.quantity) || 0) * Math.max(0, Number(line.unitPriceSold) || 0), 0);
  const discounts = lines.reduce((sum, line) => sum + Math.max(0, Number(line.discountAmount) || 0), 0);
  const delivery = Math.max(0, Number(deliveryFee) || 0);
  return { subtotal, discounts, delivery, total: Math.max(0, subtotal - discounts + delivery) };
}

function Modal({ label, children, onClose, wide = false }: { label: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return <div className="modal orders-modal" role="dialog" aria-modal="true" aria-label={label} onPointerDown={onClose}>
    <div className={`orders-modal-card ${wide ? "wide" : ""}`} onPointerDown={(event) => event.stopPropagation()}>{children}</div>
  </div>;
}

function PaymentBadge({ order }: { order: OrderRecord }) {
  return <span className={`orders-payment-badge ${order.paymentStatus.toLowerCase()}`}>
    {order.paymentStatus === "PAID" ? "Pagado" : order.paymentStatus === "PARTIAL" ? `Abonado ${crc(order.paidTotal)}` : "Pendiente de pago"}
  </span>;
}

export function OrdersView({ products, quotes, settings, scannedBarcode, onConsumeScan, onRequestScan, onInventoryChanged }: Props) {
  const today = useMemo(() => costaRicaDate(), []);
  const tomorrow = useMemo(() => addDays(today, 1), [today]);
  const [section, setSection] = useState<OrdersSection>("deliveries");
  const [selectedDate, setSelectedDate] = useState(today);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [upcoming, setUpcoming] = useState<OrderRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice>(null);
  const [selected, setSelected] = useState<OrderRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editor, setEditor] = useState<OrderDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [productQuery, setProductQuery] = useState("");
  const [duplicateOrders, setDuplicateOrders] = useState<OrderRecord[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [reprogramOpen, setReprogramOpen] = useState(false);
  const [reprogramDate, setReprogramDate] = useState("");
  const [reprogramReason, setReprogramReason] = useState("");
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("SINPE");
  const [paymentReference, setPaymentReference] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [preparedChecks, setPreparedChecks] = useState<Set<string>>(new Set());
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyStatus, setHistoryStatus] = useState("");
  const [historyPayment, setHistoryPayment] = useState("");
  const [routeBusy, setRouteBusy] = useState(false);

  const showError = useCallback((error: unknown, fallback: string) => {
    const typed = error as Error & { title?: string };
    setNotice({ tone: "error", title: typed.title || "No se pudo completar", message: typed.message || fallback });
  }, []);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: section === "history" ? "25" : "100", page: String(section === "history" ? page : 1) });
      if (section === "deliveries") {
        params.set("date", selectedDate);
        params.set("orderType", "STANDARD");
      } else if (section === "special") {
        params.set("orderType", "SPECIAL_ORDER");
      }
      if (section === "history" && historyStatus) params.set("status", historyStatus);
      if (section === "history" && historyPayment) params.set("paymentStatus", historyPayment);
      const result = await api<{ orders: OrderRecord[]; total: number }>(`/api/orders?${params}`);
      setOrders(result.orders);
      setTotal(result.total);
    } catch (error) { showError(error, "No se pudo cargar la lista de pedidos."); }
    finally { setLoading(false); }
  }, [historyPayment, historyStatus, page, section, selectedDate, showError]);

  const loadUpcoming = useCallback(async () => {
    try {
      const params = new URLSearchParams({ from: today, orderType: "STANDARD", limit: "100", page: "1" });
      const result = await api<{ orders: OrderRecord[] }>(`/api/orders?${params}`);
      setUpcoming(result.orders.filter((order) => !["CANCELLED", "DELIVERED"].includes(order.status)));
    } catch { /* La lista principal conserva el error accionable. */ }
  }, [today]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadOrders(), 0);
    return () => window.clearTimeout(timer);
  }, [loadOrders]);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadUpcoming(), 0);
    return () => window.clearTimeout(timer);
  }, [loadUpcoming]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const result = await api<{ order: OrderRecord }>(`/api/orders/${id}`);
      setSelected(result.order);
      setPreparedChecks(new Set());
      return result.order;
    } catch (error) {
      showError(error, "No se pudo abrir el pedido.");
      return null;
    } finally { setDetailLoading(false); }
  }, [showError]);

  const refreshAfterMutation = useCallback(async (order: OrderRecord, inventoryChanged = false) => {
    setSelected(order);
    await Promise.all([loadOrders(), loadUpcoming(), inventoryChanged ? Promise.resolve(onInventoryChanged()) : Promise.resolve()]);
  }, [loadOrders, loadUpcoming, onInventoryChanged]);

  const visibleOrders = useMemo(() => {
    if (section !== "history" || !historyQuery.trim()) return orders;
    const query = normalizeName(historyQuery);
    return orders.filter((order) => normalizeName([
      order.orderNumber,
      order.customerName,
      order.phoneRaw || "",
      order.phoneNormalized || "",
      order.productSummary || "",
    ].join(" ")).includes(query));
  }, [historyQuery, orders, section]);

  const daySummaries = useMemo(() => {
    const grouped = new Map<string, { orders: number; units: number }>();
    upcoming.forEach((order) => {
      if (!order.scheduledDeliveryDate) return;
      const current = grouped.get(order.scheduledDeliveryDate) || { orders: 0, units: 0 };
      current.orders += 1;
      current.units += order.unitTotal;
      grouped.set(order.scheduledDeliveryDate, current);
    });
    return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(0, 7);
  }, [upcoming]);

  const productResults = useMemo(() => {
    if (!productQuery.trim()) return [];
    return searchProducts(products, productQuery).slice(0, 8);
  }, [productQuery, products]);

  const quoteResults = useMemo(() => {
    if (!productQuery.trim()) return [];
    return searchProducts(quotes, productQuery).slice(0, 5);
  }, [productQuery, quotes]);

  const openNew = useCallback((type: OrderType) => {
    setSelected(null);
    setEditor(emptyDraft(type, selectedDate));
    setProductQuery("");
    setNotice(null);
  }, [selectedDate]);

  const openEdit = useCallback(async (order: OrderRecord) => {
    const detail = order.lines ? order : await loadDetail(order.id);
    if (!detail) return;
    setEditor(orderToDraft(detail));
    setProductQuery("");
  }, [loadDetail]);

  const addInventoryProduct = useCallback((product: ProductRecord) => {
    if (!editor) return;
    const suggested = hasCompletePricing(product) ? calculatePrices(product.purchasePriceUsd, product.weightLb, settings).gamPriceCrc : 0;
    setEditor({ ...editor, lines: [...editor.lines, {
      key: lineKey(), id: null, productId: product.id, productName: product.name, quantity: "1",
      unitPriceOriginal: suggested, unitPriceSold: String(suggested), discountAmount: "0", barcode: product.code,
      presentation: product.presentation || null, source: "inventory",
    }] });
    setProductQuery("");
  }, [editor, settings]);

  const addQuote = useCallback((quote: NonInventoryRecord) => {
    if (!editor) return;
    const suggested = hasCompletePricing(quote) ? calculatePrices(quote.purchasePriceUsd, quote.weightLb, settings).gamPriceCrc : 0;
    setEditor({ ...editor, lines: [...editor.lines, {
      key: lineKey(), id: null, productId: null, productName: quote.name, quantity: "1",
      unitPriceOriginal: suggested, unitPriceSold: String(suggested), discountAmount: "0", barcode: quote.code,
      presentation: null, source: "no_inventory",
    }] });
    setProductQuery("");
  }, [editor, settings]);

  const addManual = useCallback(() => {
    if (!editor) return;
    setEditor({ ...editor, lines: [...editor.lines, {
      key: lineKey(), id: null, productId: null, productName: productQuery.trim(), quantity: "1",
      unitPriceOriginal: null, unitPriceSold: "0", discountAmount: "0", barcode: null,
      presentation: null, source: "manual",
    }] });
    setProductQuery("");
  }, [editor, productQuery]);

  useEffect(() => {
    if (!scannedBarcode || !editor) return;
    const timer = window.setTimeout(() => {
      const code = scannedBarcode.code.trim().toLowerCase();
      const product = products.find((candidate) => candidate.code?.trim().toLowerCase() === code);
      const quote = quotes.find((candidate) => candidate.code?.trim().toLowerCase() === code);
      if (product) {
        addInventoryProduct(product);
        setNotice({ tone: "success", title: "Producto agregado", message: `${product.name} se agregó al pedido desde el escáner.` });
      } else if (quote) {
        addQuote(quote);
        setNotice({ tone: "success", title: "Producto de No inventario agregado", message: `${quote.name} se agregó sin crear movimientos de inventario.` });
      } else {
        setProductQuery(scannedBarcode.code);
        setNotice({ tone: "warning", title: "Código no encontrado", message: "Podés buscar otro producto o agregar una línea manual. No se inventó ningún código." });
      }
      onConsumeScan();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [addInventoryProduct, addQuote, editor, onConsumeScan, products, quotes, scannedBarcode]);

  const updateLine = useCallback((key: string, field: keyof Pick<DraftLine, "productName" | "quantity" | "unitPriceSold" | "discountAmount">, value: string) => {
    setEditor((current) => current ? { ...current, lines: current.lines.map((line) => line.key === key ? { ...line, [field]: value } : line) } : current);
  }, []);

  const removeLine = useCallback((key: string) => {
    setEditor((current) => current ? { ...current, lines: current.lines.filter((line) => line.key !== key) } : current);
  }, []);

  const persistEditor = useCallback(async (ignoreDuplicate = false) => {
    if (!editor || saving) return;
    if (!editor.customerName.trim()) {
      setNotice({ tone: "warning", title: "Cliente requerido", message: "Ingresá el nombre del cliente antes de guardar." });
      return;
    }
    if (!editor.lines.length || editor.lines.some((line) => !line.productName.trim() || Number(line.quantity) < 1 || Number(line.unitPriceSold) < 0)) {
      setNotice({ tone: "warning", title: "Revisá los productos", message: "Cada línea necesita nombre, cantidad mayor a cero y precio válido." });
      return;
    }
    if (editor.lines.some((line) => Number(line.discountAmount) > Number(line.quantity) * Number(line.unitPriceSold))) {
      setNotice({ tone: "warning", title: "Descuento inválido", message: "Un descuento no puede superar el subtotal de su producto." });
      return;
    }
    setSaving(true);
    try {
      if (!editor.id && !ignoreDuplicate && editor.phone.trim() && editor.scheduledDeliveryDate) {
        const params = new URLSearchParams({ phone: editor.phone, date: editor.scheduledDeliveryDate, limit: "10" });
        const possible = await api<{ orders: OrderRecord[] }>(`/api/orders?${params}`);
        const duplicates = possible.orders.filter((order) => !["CANCELLED", "DELIVERED"].includes(order.status));
        if (duplicates.length) {
          setDuplicateOrders(duplicates);
          return;
        }
      }
      const payload = {
        operationId: operationId(editor.id ? "order-update" : "order-create"),
        ...(editor.id ? { version: editor.version } : {}),
        orderType: editor.orderType,
        customerName: editor.customerName,
        phone: editor.phone,
        deliveryAddress: editor.deliveryAddress,
        deliveryInstructions: editor.deliveryInstructions,
        scheduledDeliveryDate: editor.scheduledDeliveryDate || null,
        estimatedArrivalDate: editor.orderType === "SPECIAL_ORDER" ? editor.estimatedArrivalDate || null : null,
        expectedPaymentMethod: editor.expectedPaymentMethod || null,
        deliveryFee: Math.round(Number(editor.deliveryFee) || 0),
        internalNotes: editor.internalNotes,
        deliveryNotes: editor.deliveryNotes,
        source: "MANUAL",
        lines: editor.lines.map((line) => ({
          ...(line.id ? { id: line.id } : {}),
          productId: line.productId,
          productName: line.productName,
          presentation: line.presentation,
          barcode: line.barcode,
          quantity: Math.round(Number(line.quantity)),
          unitPriceOriginal: line.unitPriceOriginal,
          unitPriceSold: Math.round(Number(line.unitPriceSold)),
          discountAmount: Math.round(Number(line.discountAmount) || 0),
        })),
      };
      const result = await api<{ order: OrderRecord }>(editor.id ? `/api/orders/${editor.id}` : "/api/orders", {
        method: editor.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setEditor(null);
      setDuplicateOrders([]);
      setNotice({ tone: "success", title: editor.id ? "Pedido actualizado" : "Borrador guardado", message: `${result.order.orderNumber} quedó guardado sin mover inventario${editor.id && ["CONFIRMED", "REOPENED"].includes(editor.status) ? "; los cambios confirmados se aplicaron por delta" : ""}.` });
      await refreshAfterMutation(result.order, Boolean(editor.id && ["CONFIRMED", "REOPENED"].includes(editor.status)));
    } catch (error) { showError(error, "No se pudo guardar el pedido."); }
    finally { setSaving(false); }
  }, [editor, refreshAfterMutation, saving, showError]);

  const mutate = useCallback(async (path: string, body: Record<string, unknown>, success: string, inventoryChanged = false) => {
    if (!selected || busyAction) return;
    setBusyAction(path);
    try {
      const result = await api<{ order: OrderRecord }>(`/api/orders/${selected.id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId: operationId(`order-${path}`), version: selected.version, ...body }),
      });
      setNotice({ tone: "success", title: "Pedido actualizado", message: success });
      await refreshAfterMutation(result.order, inventoryChanged);
      setConfirmOpen(false);
      setDeliverOpen(false);
      setCancelOpen(false);
      setReprogramOpen(false);
      setPaymentOpen(false);
      setCancelReason("");
      setReprogramReason("");
      setPaymentAmount("");
      setPaymentReference("");
    } catch (error) { showError(error, "No se pudo actualizar el pedido."); }
    finally { setBusyAction(null); }
  }, [busyAction, refreshAfterMutation, selected, showError]);

  const deleteDraft = useCallback(async () => {
    if (!selected || busyAction) return;
    setBusyAction("delete");
    try {
      await api(`/api/orders/${selected.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId: operationId("order-delete-draft"), version: selected.version }),
      });
      setSelected(null);
      setNotice({ tone: "success", title: "Borrador eliminado", message: "El borrador sin movimientos fue eliminado." });
      await Promise.all([loadOrders(), loadUpcoming()]);
    } catch (error) { showError(error, "No se pudo eliminar el borrador."); }
    finally { setBusyAction(null); }
  }, [busyAction, loadOrders, loadUpcoming, selected, showError]);

  const confirmationRows = useMemo(() => {
    if (!selected?.lines) return [];
    const required = new Map<number, number>();
    selected.lines.forEach((line) => {
      if (line.productId) required.set(line.productId, (required.get(line.productId) || 0) + line.quantity);
    });
    return [...required].map(([productId, quantity]) => {
      const product = products.find((item) => item.id === productId);
      return { productId, name: product?.name || "Producto no disponible", required: quantity, available: product?.quantityAvailable ?? 0 };
    });
  }, [products, selected]);

  const createOrFindRoute = useCallback(async () => {
    const existing = await api<{ routes: Array<{ id: string }> }>(`/api/delivery-routes?date=${selectedDate}&status=OPEN`);
    if (existing.routes[0]) return existing.routes[0].id;
    const created = await api<{ route: { id: string } }>("/api/delivery-routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: selectedDate, label: `Entregas ${dateLabel(selectedDate)}` }),
    });
    return created.route.id;
  }, [selectedDate]);

  const moveOrder = useCallback(async (index: number, direction: -1 | 1) => {
    if (routeBusy) return;
    const target = index + direction;
    if (target < 0 || target >= orders.length) return;
    const next = [...orders];
    [next[index], next[target]] = [next[target], next[index]];
    setOrders(next);
    setRouteBusy(true);
    try {
      const routeId = await createOrFindRoute();
      const active = next.filter((order) => !["DELIVERED", "CANCELLED"].includes(order.status));
      for (const [position, order] of active.entries()) {
        await api(`/api/delivery-routes/${routeId}/orders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: order.id, position: position + 1 }),
        });
      }
      setNotice({ tone: "success", title: "Ruta actualizada", message: "El orden diario quedó guardado para todos los dispositivos." });
      await loadOrders();
    } catch (error) {
      showError(error, "No se pudo guardar el orden de la ruta.");
      await loadOrders();
    } finally { setRouteBusy(false); }
  }, [createOrFindRoute, loadOrders, orders, routeBusy, showError]);

  const totals = editor ? draftTotals(editor.lines, editor.deliveryFee) : null;
  const allPrepared = Boolean(selected?.lines?.length) && selected!.lines!.every((line) => preparedChecks.has(line.id));

  return <div className="view orders-view">
    <header className="view-head orders-head">
      <div><span className="eyebrow">Operación diaria</span><h1>Pedidos</h1><p>Inventario seguro, abonos trazables y entregas organizadas.</p></div>
      <button className="btn primary" onClick={() => openNew(section === "special" ? "SPECIAL_ORDER" : "STANDARD")} disabled={section === "history"}><Plus />{section === "special" ? "Nuevo Encargo" : "Nuevo pedido"}</button>
    </header>

    <nav className="orders-sections" aria-label="Secciones de Pedidos">
      <button className={section === "deliveries" ? "active" : ""} onClick={() => { setSection("deliveries"); setPage(1); }}><Truck />Entregas</button>
      <button className={section === "special" ? "active" : ""} onClick={() => { setSection("special"); setPage(1); }}><ShoppingBag />Encargos</button>
      <button className={section === "history" ? "active" : ""} onClick={() => { setSection("history"); setPage(1); }}><History />Historial</button>
    </nav>

    {notice && <section className={`orders-notice ${notice.tone}`} role="status"><AlertCircle /><div><b>{notice.title}</b><span>{notice.message}</span></div><button onClick={() => setNotice(null)} aria-label="Cerrar aviso"><X /></button></section>}

    {section === "deliveries" && <>
      <section className="surface orders-date-panel">
        <div className="orders-date-buttons">
          <button className={selectedDate === today ? "active" : ""} onClick={() => setSelectedDate(today)}><b>Hoy</b><small>{dateLabel(today)}</small></button>
          <button className={selectedDate === tomorrow ? "active" : ""} onClick={() => setSelectedDate(tomorrow)}><b>Mañana</b><small>{dateLabel(tomorrow)}</small></button>
          <label><CalendarDays /><span>Otra fecha</span><input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value || today)} /></label>
        </div>
        {daySummaries.length > 0 && <div className="orders-upcoming"><span>Próximas fechas</span>{daySummaries.map(([date, summary]) => <button className={date === selectedDate ? "active" : ""} onClick={() => setSelectedDate(date)} key={date}><b>{dateLabel(date)}</b><small>{summary.orders} pedido{summary.orders === 1 ? "" : "s"} · {summary.units} unidades</small></button>)}</div>}
      </section>
      <div className="orders-day-summary"><span><b>{orders.length}</b> pedido{orders.length === 1 ? "" : "s"}</span><span><b>{orders.reduce((sum, order) => sum + order.unitTotal, 0)}</b> unidades</span>{routeBusy && <span><Loader2 className="spin" />Guardando ruta…</span>}</div>
    </>}

    {section === "special" && <section className="surface special-intro"><ShoppingBag /><div><b>Encargos separados del flujo diario</b><p>Crear el Encargo no mueve inventario. Su recepción y vinculación se resuelven de forma explícita antes de confirmar.</p></div></section>}

    {section === "history" && <section className="surface orders-history-filters">
      <div className="input-icon grow"><Search /><input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="Pedido, cliente, teléfono o producto" /></div>
      <select value={historyStatus} onChange={(event) => { setHistoryStatus(event.target.value); setPage(1); }} aria-label="Filtrar por estado"><option value="">Todos los estados</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
      <select value={historyPayment} onChange={(event) => { setHistoryPayment(event.target.value); setPage(1); }} aria-label="Filtrar por pago"><option value="">Todos los pagos</option><option value="PENDING">Pendiente</option><option value="PARTIAL">Abonado</option><option value="PAID">Pagado</option></select>
    </section>}

    {loading ? <section className="surface orders-loading"><Loader2 className="spin" />Cargando pedidos…</section> : visibleOrders.length === 0 ? <section className="surface orders-empty"><Package /><h2>{section === "history" ? "No hay coincidencias" : section === "special" ? "Todavía no hay Encargos" : "No hay pedidos para esta fecha"}</h2><p>{section === "history" ? "Cambiá los filtros o avanzá de página." : "Creá el primero desde el botón superior."}</p></section> : <section className="orders-list">
      {visibleOrders.map((order, index) => <article className={`orders-card status-${order.status.toLowerCase()}`} key={order.id}>
        {section === "deliveries" && !["DELIVERED", "CANCELLED"].includes(order.status) && <div className="orders-route-controls"><button onClick={() => void moveOrder(index, -1)} disabled={index === 0 || routeBusy} aria-label={`Subir ${order.orderNumber}`}><ArrowUp /></button><span>{order.routePosition || index + 1}</span><button onClick={() => void moveOrder(index, 1)} disabled={index === orders.length - 1 || routeBusy} aria-label={`Bajar ${order.orderNumber}`}><ArrowDown /></button></div>}
        <div className="orders-card-main">
          <header><div><span className="orders-number">{order.orderNumber}</span><h2>{order.customerName}</h2></div><span className={`orders-status ${order.status.toLowerCase()}`}>{STATUS_LABELS[order.status]}</span></header>
          <p className="orders-products">{order.productSummary || `${order.lineCount} productos`} </p>
          <div className="orders-meta"><span><CalendarDays />{dateLabel(order.scheduledDeliveryDate)}</span>{order.phoneRaw && <span><Phone />{order.phoneRaw}</span>}{order.deliveryAddress && <span><MapPin />{order.deliveryAddress}</span>}</div>
          {order.orderType === "SPECIAL_ORDER" && <div className="orders-special-state"><ShoppingBag />{SPECIAL_LABELS[order.specialOrderStatus || ""] || order.specialOrderStatus}{order.estimatedArrivalDate && <small>{elapsedLabel(order.estimatedArrivalDate)}</small>}</div>}
          <footer><div><b>{crc(order.total)}</b><PaymentBadge order={order} />{order.expectedPaymentMethod && <small>Esperado: {PAYMENT_LABELS[order.expectedPaymentMethod]}</small>}</div><button className="btn secondary small" onClick={() => void loadDetail(order.id)}><Eye />Abrir</button></footer>
        </div>
      </article>)}
    </section>}

    {section === "history" && total > 25 && <div className="orders-pagination"><button className="btn secondary small" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft />Anterior</button><span>Página {page} de {Math.ceil(total / 25)}</span><button className="btn secondary small" disabled={page >= Math.ceil(total / 25)} onClick={() => setPage((current) => current + 1)}>Siguiente<ChevronRight /></button></div>}

    {detailLoading && <div className="orders-detail-loading"><Loader2 className="spin" />Abriendo pedido…</div>}

    {editor && <Modal label={editor.id ? "Editar pedido" : "Nuevo pedido"} onClose={() => !saving && setEditor(null)} wide>
      <form className="orders-editor" onSubmit={(event: FormEvent) => { event.preventDefault(); void persistEditor(); }}>
        <header className="orders-modal-head"><div><span className="eyebrow">{editor.orderType === "SPECIAL_ORDER" ? "Encargo" : "Entrega"}</span><h2>{editor.id ? "Editar pedido" : "Nuevo pedido"}</h2><p>Los totales se recalculan y validan en el servidor.</p></div><button type="button" className="icon-btn" onClick={() => setEditor(null)} aria-label="Cerrar editor"><X /></button></header>
        <div className="orders-form-grid">
          <label className="field"><span>Cliente <em>*</em></span><input value={editor.customerName} onChange={(event) => setEditor({ ...editor, customerName: event.target.value })} maxLength={250} /></label>
          <label className="field"><span>Teléfono</span><input inputMode="tel" value={editor.phone} onChange={(event) => setEditor({ ...editor, phone: event.target.value })} placeholder="7096-2629" /></label>
          <label className="field wide"><span>Dirección</span><input value={editor.deliveryAddress} onChange={(event) => setEditor({ ...editor, deliveryAddress: event.target.value })} /></label>
          <label className="field wide"><span>Indicaciones de entrega</span><input value={editor.deliveryInstructions} onChange={(event) => setEditor({ ...editor, deliveryInstructions: event.target.value })} /></label>
          <label className="field"><span>Fecha programada de entrega</span><input type="date" value={editor.scheduledDeliveryDate} onChange={(event) => setEditor({ ...editor, scheduledDeliveryDate: event.target.value })} /></label>
          {editor.orderType === "SPECIAL_ORDER" && <label className="field"><span>Fecha estimada de llegada</span><input type="date" value={editor.estimatedArrivalDate} onChange={(event) => setEditor({ ...editor, estimatedArrivalDate: event.target.value })} /></label>}
          <label className="field"><span>Método esperado de pago</span><select value={editor.expectedPaymentMethod} onChange={(event) => setEditor({ ...editor, expectedPaymentMethod: event.target.value as OrderDraft["expectedPaymentMethod"] })}><option value="">Sin definir</option>{Object.entries(PAYMENT_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><small className="hint">Es una expectativa operativa; no registra dinero recibido.</small></label>
          <label className="field"><span>Costo de entrega</span><input type="number" min="0" step="1" value={editor.deliveryFee} onChange={(event) => setEditor({ ...editor, deliveryFee: event.target.value })} /></label>
        </div>

        <section className="orders-product-picker">
          <div className="input-icon grow"><Search /><input value={productQuery} onChange={(event) => setProductQuery(event.target.value)} placeholder="Buscar por nombre o código" /></div>
          <button type="button" className="scan-btn" onClick={onRequestScan}><Camera /><span>Escanear</span></button>
          {productQuery.trim() && <div className="orders-product-results">
            {productResults.map((product) => <button type="button" onClick={() => addInventoryProduct(product)} key={`product-${product.id}`}><span><b>{product.name}</b><small>{product.code || "Sin código"} · Inventario: {product.quantityAvailable}</small></span><strong>{hasCompletePricing(product) ? crc(calculatePrices(product.purchasePriceUsd, product.weightLb, settings).gamPriceCrc) : "Sin precio sugerido"}</strong></button>)}
            {quoteResults.map((quote) => <button type="button" onClick={() => addQuote(quote)} key={`quote-${quote.id}`}><span><b>{quote.name}</b><small>{quote.code || "Sin código"} · No inventario</small></span><strong>{hasCompletePricing(quote) ? crc(calculatePrices(quote.purchasePriceUsd, quote.weightLb, settings).gamPriceCrc) : "Sin precio sugerido"}</strong></button>)}
            <button type="button" className="manual" onClick={addManual}><span><b>Agregar producto manual</b><small>No se vincula ni descuenta inventario.</small></span><Plus /></button>
          </div>}
        </section>

        <section className="orders-lines-editor">
          <header><b>Productos</b><span>{editor.lines.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0)} unidades</span></header>
          {editor.lines.length === 0 ? <div className="orders-lines-empty"><Package />Buscá, escaneá o agregá un producto manual.</div> : editor.lines.map((line) => <article key={line.key}>
            <div className="orders-line-title"><span className={`source ${line.source}`}>{line.source === "inventory" ? "Inventario" : line.source === "no_inventory" ? "No inventario" : "Manual"}</span>{line.productId ? <b>{line.productName}</b> : <input value={line.productName} onChange={(event) => updateLine(line.key, "productName", event.target.value)} placeholder="Nombre del producto" />}<button type="button" onClick={() => removeLine(line.key)} aria-label={`Eliminar ${line.productName || "producto"}`}><Trash2 /></button></div>
            <div className="orders-line-fields"><label><span>Cantidad</span><input type="number" min="1" step="1" value={line.quantity} onChange={(event) => updateLine(line.key, "quantity", event.target.value)} /></label><label><span>Precio vendido</span><input type="number" min="0" step="1" value={line.unitPriceSold} onChange={(event) => updateLine(line.key, "unitPriceSold", event.target.value)} /></label><label><span>Descuento total</span><input type="number" min="0" step="1" value={line.discountAmount} onChange={(event) => updateLine(line.key, "discountAmount", event.target.value)} /></label><strong>{crc(Math.max(0, (Number(line.quantity) || 0) * (Number(line.unitPriceSold) || 0) - (Number(line.discountAmount) || 0)))}</strong></div>
          </article>)}
        </section>

        <div className="orders-form-grid notes">
          <label className="field wide"><span>Notas internas</span><textarea value={editor.internalNotes} onChange={(event) => setEditor({ ...editor, internalNotes: event.target.value })} /></label>
          <label className="field wide"><span>Notas para la entrega</span><textarea value={editor.deliveryNotes} onChange={(event) => setEditor({ ...editor, deliveryNotes: event.target.value })} /></label>
        </div>

        {totals && <section className="orders-totals"><span>Subtotal <b>{crc(totals.subtotal)}</b></span><span>Descuentos <b>-{crc(totals.discounts)}</b></span><span>Entrega <b>{crc(totals.delivery)}</b></span><strong>Total <b>{crc(totals.total)}</b></strong></section>}
        <footer className="orders-editor-actions"><button type="button" className="btn secondary" onClick={() => setEditor(null)}>Cancelar</button><button className="btn primary" disabled={saving}>{saving ? <Loader2 className="spin" /> : <Save />}{editor.id ? "Guardar cambios" : "Guardar borrador"}</button></footer>
      </form>
    </Modal>}

    {duplicateOrders.length > 0 && <Modal label="Posible pedido duplicado" onClose={() => setDuplicateOrders([])}>
      <div className="orders-confirm-card"><header className="orders-modal-head"><div><span className="eyebrow">Verificación</span><h2>Posible pedido duplicado</h2><p>Ya existe un pedido abierto para el mismo teléfono y fecha.</p></div><button className="icon-btn" onClick={() => setDuplicateOrders([])}><X /></button></header>
        <div className="duplicate-list">{duplicateOrders.map((order) => <article key={order.id}><div><b>{order.orderNumber} · {order.customerName}</b><small>{STATUS_LABELS[order.status]} · {crc(order.total)}</small></div><button className="btn secondary small" onClick={() => { setDuplicateOrders([]); void loadDetail(order.id); }}><Eye />Abrir existente</button></article>)}</div>
        <div className="orders-confirm-actions"><button className="btn secondary" onClick={() => setDuplicateOrders([])}>Volver a revisar</button><button className="btn primary" onClick={() => { setDuplicateOrders([]); void persistEditor(true); }}>Continuar de todos modos</button></div>
      </div>
    </Modal>}

    {selected && !editor && <Modal label={`Pedido ${selected.orderNumber}`} onClose={() => setSelected(null)} wide>
      <div className="orders-detail">
        <header className="orders-modal-head"><div><span className="eyebrow">{selected.orderNumber}</span><h2>{selected.customerName}</h2><p>{STATUS_LABELS[selected.status]} · Actualizado {dateTimeLabel(selected.updatedAt)}</p></div><button className="icon-btn" onClick={() => setSelected(null)} aria-label="Cerrar pedido"><X /></button></header>
        <div className="orders-detail-summary"><span><b>{crc(selected.total)}</b><small>Total</small></span><span><b>{crc(selected.paidTotal)}</b><small>Pagado real</small></span><span><b>{crc(selected.balance)}</b><small>Saldo</small></span><span><b>{selected.expectedPaymentMethod ? PAYMENT_LABELS[selected.expectedPaymentMethod] : "Sin definir"}</b><small>Método esperado</small></span></div>
        <section className="orders-detail-info"><div><UserRound /><span><b>{selected.customerName}</b><small>{selected.phoneRaw || "Sin teléfono"}</small></span></div><div><MapPin /><span><b>{selected.deliveryAddress || "Sin dirección"}</b><small>{selected.deliveryInstructions || "Sin indicaciones"}</small></span></div><div><CalendarDays /><span><b>{dateLabel(selected.scheduledDeliveryDate)}</b><small>Fecha programada de entrega</small></span></div></section>
        {selected.orderType === "SPECIAL_ORDER" && <section className="orders-special-detail"><ShoppingBag /><div><b>{SPECIAL_LABELS[selected.specialOrder?.status || selected.specialOrderStatus || ""] || selected.specialOrder?.status}</b><span>Solicitud: {dateTimeLabel(selected.specialOrder?.requestedAt || selected.createdAt)}</span>{selected.estimatedArrivalDate && <span>Estimada: {dateLabel(selected.estimatedArrivalDate)} · {elapsedLabel(selected.estimatedArrivalDate)}</span>}<small>{selected.receiptResolvedAt ? "Recepción resuelta" : "La recepción todavía no autoriza inventario ni confirmación."}</small></div></section>}
        <section className="orders-detail-lines"><header><b>Productos</b><span>{selected.lines?.reduce((sum, line) => sum + line.quantity, 0) || 0} unidades</span></header>{selected.lines?.map((line) => <article key={line.id}><div><b>{line.productName}</b><small>{line.productId ? `Vinculado a inventario #${line.productId}` : "Producto manual · no afecta inventario"}</small></div><span>{line.quantity} × {crc(line.unitPriceSold)}</span><strong>{crc(line.lineTotal)}</strong></article>)}</section>
        <section className="orders-payment-ledger"><header><div><WalletCards /><span><b>Pagos reales</b><small>Ledger separado del método esperado</small></span></div>{selected.status !== "CANCELLED" && selected.balance > 0 && <button className="btn secondary small" onClick={() => { setPaymentAmount(String(selected.balance)); setPaymentOpen(true); }}><Plus />Registrar abono</button>}</header>{selected.payments?.length ? selected.payments.map((payment) => <article key={payment.id}><span><b>{payment.type === "PAYMENT" ? PAYMENT_LABELS[payment.method] : "Reversión"}</b><small>{dateTimeLabel(payment.createdAt)}{payment.reference ? ` · ${payment.reference}` : ""}</small></span><strong className={payment.type === "PAYMENT" ? "" : "reversal"}>{payment.type === "PAYMENT" ? "+" : "-"}{crc(payment.amount)}</strong></article>) : <p>Todavía no hay pagos registrados.</p>}</section>
        {selected.status === "CONFIRMED" && <section className="orders-prepared-checklist"><header><ClipboardCheck /><div><b>Lista de preparación</b><small>Esta lista es operativa local; el estado se guarda al marcar Preparado.</small></div></header>{selected.lines?.map((line) => <label key={line.id}><input type="checkbox" checked={preparedChecks.has(line.id)} onChange={() => setPreparedChecks((current) => { const next = new Set(current); if (next.has(line.id)) next.delete(line.id); else next.add(line.id); return next; })} /><span>{line.productName} × {line.quantity}</span></label>)}</section>}
        {(selected.internalNotes || selected.deliveryNotes) && <section className="orders-notes">{selected.internalNotes && <div><b>Nota interna</b><p>{selected.internalNotes}</p></div>}{selected.deliveryNotes && <div><b>Nota de entrega</b><p>{selected.deliveryNotes}</p></div>}</section>}
        <footer className="orders-detail-actions">
          {["DRAFT", "CONFIRMED", "REOPENED"].includes(selected.status) && <button className="btn secondary" onClick={() => void openEdit(selected)}><Pencil />Editar</button>}
          {["DRAFT", "REOPENED"].includes(selected.status) && <button className="btn primary" onClick={() => setConfirmOpen(true)}><Check />Confirmar</button>}
          {selected.status === "CONFIRMED" && <button className="btn primary" disabled={!allPrepared} onClick={() => void mutate("prepare", {}, "El pedido quedó preparado. Preparar no movió inventario.")}><PackageCheck />Marcar preparado</button>}
          {selected.status === "PREPARED" && <button className="btn primary" onClick={() => setDeliverOpen(true)}><Truck />Marcar entregado</button>}
          {["DRAFT", "CONFIRMED", "PREPARED", "REOPENED"].includes(selected.status) && <button className="btn secondary" onClick={() => { setReprogramDate(selected.scheduledDeliveryDate || today); setReprogramOpen(true); }}><CalendarDays />Reprogramar</button>}
          {["DRAFT", "CONFIRMED", "PREPARED"].includes(selected.status) && <button className="btn danger-outline" onClick={() => setCancelOpen(true)}><X />Cancelar pedido</button>}
          {selected.status === "DRAFT" && !selected.payments?.length && <button className="btn danger-outline" onClick={() => void deleteDraft()} disabled={Boolean(busyAction)}><Trash2 />Eliminar borrador</button>}
        </footer>
      </div>
    </Modal>}

    {confirmOpen && selected && <Modal label="Confirmar pedido" onClose={() => setConfirmOpen(false)}>
      <div className="orders-confirm-card"><header className="orders-modal-head"><div><span className="eyebrow">Revisión final</span><h2>Confirmar {selected.orderNumber}</h2><p>Confirmar descuenta inventario vinculado exactamente una vez.</p></div><button className="icon-btn" onClick={() => setConfirmOpen(false)}><X /></button></header>
        <div className="orders-stock-review">{confirmationRows.length ? confirmationRows.map((row) => <article className={row.available < row.required ? "shortage" : ""} key={row.productId}><span><b>{row.name}</b><small>Necesario: {row.required} · Disponible: {row.available}</small></span>{row.available >= row.required ? <Check /> : <AlertCircle />}</article>) : <p>Todos los productos son manuales; no se descontará inventario.</p>}</div>
        {confirmationRows.some((row) => row.available < row.required) && <p className="orders-blocking-warning"><AlertCircle />Hay faltantes. El servidor volverá a validar y conservará todo sin cambios si el stock no alcanza.</p>}
        <div className="orders-confirm-actions"><button className="btn secondary" onClick={() => setConfirmOpen(false)}>Volver</button><button className="btn primary" disabled={Boolean(busyAction) || confirmationRows.some((row) => row.available < row.required)} onClick={() => void mutate("confirm", {}, "Pedido confirmado; el inventario vinculado se descontó exactamente una vez.", true)}>{busyAction ? <Loader2 className="spin" /> : <Check />}Confirmar pedido</button></div>
      </div>
    </Modal>}

    {deliverOpen && selected && <Modal label="Marcar pedido entregado" onClose={() => setDeliverOpen(false)}>
      <div className="orders-confirm-card"><header className="orders-modal-head"><div><span className="eyebrow">Entrega</span><h2>Confirmar entrega</h2><p>{selected.customerName} · {selected.orderNumber}</p></div><button className="icon-btn" onClick={() => setDeliverOpen(false)}><X /></button></header><div className="delivery-review"><Truck /><div><b>{selected.lines?.reduce((sum, line) => sum + line.pendingDeliveryQuantity, 0)} unidades pendientes</b><span>Marcar entregado registra el cumplimiento; no vuelve a descontar inventario.</span></div></div><div className="orders-confirm-actions"><button className="btn secondary" onClick={() => setDeliverOpen(false)}>Volver</button><button className="btn primary" disabled={Boolean(busyAction)} onClick={() => void mutate("deliver", {}, "Pedido entregado sin movimientos adicionales de inventario.")}>{busyAction ? <Loader2 className="spin" /> : <Truck />}Confirmar entrega</button></div></div>
    </Modal>}

    {cancelOpen && selected && <Modal label="Cancelar pedido" onClose={() => setCancelOpen(false)}>
      <div className="orders-confirm-card"><header className="orders-modal-head"><div><span className="eyebrow">Acción trazable</span><h2>Cancelar pedido</h2><p>{selected.status === "DRAFT" ? "Este borrador no descontó inventario, por lo que no hay stock que devolver." : "El servidor restaurará exactamente el inventario descontado al confirmar."}</p></div><button className="icon-btn" onClick={() => setCancelOpen(false)}><X /></button></header><label className="field"><span>Motivo <em>*</em></span><textarea value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} placeholder="Indicá por qué se cancela" /></label><div className="orders-confirm-actions"><button className="btn secondary" onClick={() => setCancelOpen(false)}>Volver</button><button className="btn danger-solid" disabled={cancelReason.trim().length < 3 || Boolean(busyAction)} onClick={() => void mutate("cancel", { reason: cancelReason }, "Pedido cancelado con su consecuencia de inventario registrada.", selected.status !== "DRAFT")}>{busyAction ? <Loader2 className="spin" /> : <X />}Cancelar pedido</button></div></div>
    </Modal>}

    {reprogramOpen && selected && <Modal label="Reprogramar pedido" onClose={() => setReprogramOpen(false)}>
      <div className="orders-confirm-card"><header className="orders-modal-head"><div><span className="eyebrow">Cambio de fecha</span><h2>Reprogramar entrega</h2><p>La fecha anterior quedará conservada en el historial del pedido.</p></div><button className="icon-btn" onClick={() => setReprogramOpen(false)}><X /></button></header><label className="field"><span>Nueva fecha</span><input type="date" value={reprogramDate} onChange={(event) => setReprogramDate(event.target.value)} /></label><label className="field"><span>Motivo</span><textarea value={reprogramReason} onChange={(event) => setReprogramReason(event.target.value)} /></label><div className="orders-confirm-actions"><button className="btn secondary" onClick={() => setReprogramOpen(false)}>Volver</button><button className="btn primary" disabled={!reprogramDate || Boolean(busyAction)} onClick={() => void mutate("reprogram", { scheduledDeliveryDate: reprogramDate, reason: reprogramReason }, "La entrega fue reprogramada y la fecha anterior quedó en el historial.")}><CalendarDays />Guardar fecha</button></div></div>
    </Modal>}

    {paymentOpen && selected && <Modal label="Registrar abono" onClose={() => setPaymentOpen(false)}>
      <div className="orders-confirm-card"><header className="orders-modal-head"><div><span className="eyebrow">Movimiento real</span><h2>Registrar abono</h2><p>Saldo actual: {crc(selected.balance)}. El método esperado no se modifica.</p></div><button className="icon-btn" onClick={() => setPaymentOpen(false)}><X /></button></header><div className="orders-payment-form"><label className="field"><span>Monto</span><input type="number" min="1" max={selected.balance} step="1" value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} /></label><label className="field"><span>Método real</span><select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)}>{Object.entries(PAYMENT_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label className="field wide"><span>Referencia opcional</span><input value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} placeholder="Comprobante o nota" /></label></div><div className="orders-confirm-actions"><button className="btn secondary" onClick={() => setPaymentOpen(false)}>Volver</button><button className="btn primary" disabled={Number(paymentAmount) < 1 || Number(paymentAmount) > selected.balance || Boolean(busyAction)} onClick={() => void mutate("payments", { amount: Math.round(Number(paymentAmount)), method: paymentMethod, reference: paymentReference }, "Abono registrado en el ledger financiero real.")}><Banknote />Registrar pago</button></div></div>
    </Modal>}
  </div>;
}
