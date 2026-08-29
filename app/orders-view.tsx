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
  PackageOpen,
  Pencil,
  Phone,
  Plus,
  Printer,
  Route as RouteIcon,
  Save,
  Search,
  ShoppingBag,
  Trash2,
  Truck,
  Undo2,
  UserRound,
  WalletCards,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  createOperationId: string | null;
  version: number | null;
  status: OrderStatus;
  orderType: OrderType;
  customerName: string;
  phone: string;
  deliveryAddress: string;
  deliveryInstructions: string;
  scheduledDeliveryDate: string;
  estimatedArrivalDate: string;
  receiptResolvedAt: string | null;
  expectedPaymentMethod: "" | PaymentMethod;
  initialPaymentAmount: string;
  initialPaymentMethod: PaymentMethod;
  deliveryFee: string;
  internalNotes: string;
  deliveryNotes: string;
  lines: DraftLine[];
};

type Notice = { tone: "success" | "warning" | "error"; title: string; message: string } | null;
type OrdersSection = "deliveries" | "special" | "history";
type OrderHistoryRecord = {
  statusEvents: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  inventoryMovements: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  returns: Array<Record<string, unknown>>;
  fulfillments: Array<Record<string, unknown>>;
};
type RouteSnapshot = {
  route: { id: string; date: string; label: string | null; status: string; createdAt: string; closedAt: string | null };
  orders: Array<OrderRecord & { routeMembership: { position: number; assignedAt: string; removedAt: string | null; active: boolean } }>;
  summary: {
    delivered: number;
    cancelled: number;
    reprogrammed: number;
    pending: number;
    totalDelivered: number;
    totalCollected: number;
    balancePending: number;
    paymentMethods: Record<PaymentMethod, number>;
    shippingTotal: number;
  };
  pendingOrders: Array<{ id: string; orderNumber: string; customerName: string; status: OrderStatus; total: number; deliveryFee: number; paidTotal: number; balance: number }>;
};
type RouteDecision = "DELIVERED" | "NOT_DELIVERED";
type ReceiptDraftLine = { orderLineId: string; productName: string; productId: number | null; quantityReceived: string; pending: number; barcode: string | null };

function emptyRouteSnapshot(date: string): RouteSnapshot {
  return {
    route: { id: "", date, label: null, status: "NONE", createdAt: "", closedAt: null },
    orders: [],
    summary: { delivered: 0, cancelled: 0, reprogrammed: 0, pending: 0, totalDelivered: 0, totalCollected: 0, balancePending: 0, paymentMethods: { CASH: 0, SINPE: 0, CARD: 0, OTHER: 0 }, shippingTotal: 0 },
    pendingOrders: [],
  };
}

type Props = {
  products: ProductRecord[];
  quotes: NonInventoryRecord[];
  settings: PricingSettings;
  scannedBarcode: OrderScanEvent;
  onConsumeScan: () => void;
  onRequestScan: () => void;
  onInventoryChanged: () => Promise<void> | void;
  onCatalogChanged: () => Promise<void> | void;
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
  return `${label.replace(/[^A-Za-z0-9:_-]+/g, "-")}-${id}`;
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

function eventLabel(type: string, fallback?: string) {
  const labels: Record<string, string> = {
    "order.created": "Pedido creado",
    "order.updated": "Pedido corregido",
    "order.confirmed": "Pedido confirmado",
    "order.prepared": "Pedido preparado",
    "order.delivered": "Pedido entregado",
    "order.partially_delivered": "Entrega parcial registrada",
    "order.cancelled": "Pedido cancelado",
    "order.reprogrammed": "Entrega reprogramada",
    "order.reopened": "Pedido reabierto para corrección",
    "order.returned": "Devolución registrada",
    "payment.recorded": "Movimiento de pago registrado",
    "special_order.status_changed": "Estado de Encargo actualizado",
    "special_order.receipt_resolved": "Recepción de Encargo resuelta",
  };
  return labels[type] || fallback || type;
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
    createOperationId: operationId("order-create"),
    version: null,
    status: "DRAFT",
    orderType,
    customerName: "",
    phone: "",
    deliveryAddress: "",
    deliveryInstructions: "",
    scheduledDeliveryDate: orderType === "STANDARD" ? date : "",
    estimatedArrivalDate: "",
    receiptResolvedAt: null,
    expectedPaymentMethod: "",
    initialPaymentAmount: "",
    initialPaymentMethod: "SINPE",
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
    createOperationId: null,
    version: order.version,
    status: order.status,
    orderType: order.orderType,
    customerName: order.customerName,
    phone: order.phoneRaw || "",
    deliveryAddress: order.deliveryAddress || "",
    deliveryInstructions: order.deliveryInstructions || "",
    scheduledDeliveryDate: order.scheduledDeliveryDate || "",
    estimatedArrivalDate: order.estimatedArrivalDate || "",
    receiptResolvedAt: order.receiptResolvedAt,
    expectedPaymentMethod: order.expectedPaymentMethod || "",
    initialPaymentAmount: "",
    initialPaymentMethod: "SINPE",
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

export function OrdersView({ products, quotes, settings, scannedBarcode, onConsumeScan, onRequestScan, onInventoryChanged, onCatalogChanged }: Props) {
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
  const [historyDate, setHistoryDate] = useState("");
  const [historyType, setHistoryType] = useState("");
  const [routeBusy, setRouteBusy] = useState(false);
  const [routeSnapshot, setRouteSnapshot] = useState<RouteSnapshot | null>(null);
  const [routeDate, setRouteDate] = useState(selectedDate);
  const [routePanelOpen, setRoutePanelOpen] = useState(false);
  const [routePanelLoading, setRoutePanelLoading] = useState(false);
  const [routeCloseConfirm, setRouteCloseConfirm] = useState(false);
  const [routeDecisions, setRouteDecisions] = useState<Record<string, RouteDecision>>({});
  const routeCloseOperationId = useRef<string | null>(null);
  const submitInFlight = useRef(false);
  const [printing, setPrinting] = useState(false);
  const [orderHistory, setOrderHistory] = useState<OrderHistoryRecord | null>(null);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnReason, setReturnReason] = useState("");
  const [returnLines, setReturnLines] = useState<Record<string, { quantity: string; reenterInventory: boolean }>>({});
  const [fulfillmentLines, setFulfillmentLines] = useState<Record<string, string>>({});
  const [pendingDeliveryDate, setPendingDeliveryDate] = useState("");
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [receiptMode, setReceiptMode] = useState<"INVENTORY_NOW" | "ALREADY_INVENTORY">("INVENTORY_NOW");
  const [receiptLines, setReceiptLines] = useState<ReceiptDraftLine[]>([]);
  const [specialRouteOpen, setSpecialRouteOpen] = useState(false);
  const [specialRouteDate, setSpecialRouteDate] = useState(today);
  const [catalogBusy, setCatalogBusy] = useState<string | null>(null);
  const initialDeepLinkHandled = useRef(false);

  useEffect(() => {
    const onBack = (event: Event) => {
      if ((event as CustomEvent<{ section?: string }>).detail?.section !== "orders") return;
      const close = (active: boolean, action: () => void) => {
        if (!active) return false;
        event.preventDefault();
        action();
        return true;
      };
      if (close(routeCloseConfirm, () => setRouteCloseConfirm(false))) return;
      if (close(confirmOpen, () => setConfirmOpen(false))) return;
      if (close(deliverOpen, () => setDeliverOpen(false))) return;
      if (close(cancelOpen, () => setCancelOpen(false))) return;
      if (close(reprogramOpen, () => setReprogramOpen(false))) return;
      if (close(paymentOpen, () => setPaymentOpen(false))) return;
      if (close(reopenOpen, () => setReopenOpen(false))) return;
      if (close(returnOpen, () => setReturnOpen(false))) return;
      if (close(receiptOpen, () => setReceiptOpen(false))) return;
      if (close(specialRouteOpen, () => setSpecialRouteOpen(false))) return;
      if (close(duplicateOrders.length > 0, () => setDuplicateOrders([]))) return;
      if (close(Boolean(editor), () => setEditor(null))) return;
      if (close(Boolean(selected), () => setSelected(null))) return;
      close(routePanelOpen, () => setRoutePanelOpen(false));
    };
    window.addEventListener("nutriplus:navigation-back", onBack);
    return () => window.removeEventListener("nutriplus:navigation-back", onBack);
  }, [cancelOpen, confirmOpen, deliverOpen, duplicateOrders.length, editor, paymentOpen, receiptOpen, reprogramOpen, reopenOpen, returnOpen, routeCloseConfirm, routePanelOpen, selected, specialRouteOpen]);

  useEffect(() => {
    const deepLinkTimer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      const requestedSection = params.get("section");
      if (["deliveries", "special", "history"].includes(requestedSection || "")) setSection(requestedSection as OrdersSection);
      const requestedDate = params.get("date");
      if (requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) setSelectedDate(requestedDate);
    }, 0);
    return () => window.clearTimeout(deepLinkTimer);
  }, []);

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
      } else if (section === "special") {
        params.set("orderType", "SPECIAL_ORDER");
        params.set("active", "1");
      }
      if (section === "history" && historyStatus) params.set("status", historyStatus);
      if (section === "history" && historyPayment) params.set("paymentStatus", historyPayment);
      if (section === "history" && historyQuery.trim()) params.set("search", historyQuery.trim());
      if (section === "history" && historyDate) params.set("date", historyDate);
      if (section === "history" && historyType) params.set("orderType", historyType);
      const result = await api<{ orders: OrderRecord[]; total: number }>(`/api/orders?${params}`);
      setOrders(section === "deliveries"
        ? result.orders.filter((order) => order.orderType === "STANDARD" || Boolean(order.receiptResolvedAt))
        : result.orders);
      setTotal(result.total);
    } catch (error) { showError(error, "No se pudo cargar la lista de pedidos."); }
    finally { setLoading(false); }
  }, [historyDate, historyPayment, historyQuery, historyStatus, historyType, page, section, selectedDate, showError]);

  const loadUpcoming = useCallback(async () => {
    try {
      const params = new URLSearchParams({ from: today, limit: "100", page: "1" });
      const result = await api<{ orders: OrderRecord[] }>(`/api/orders?${params}`);
      setUpcoming(result.orders.filter((order) => !["CANCELLED", "DELIVERED"].includes(order.status)
        && (order.orderType === "STANDARD" || Boolean(order.receiptResolvedAt))));
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
      const [result, history] = await Promise.all([
        api<{ order: OrderRecord }>(`/api/orders/${id}`),
        api<OrderHistoryRecord>(`/api/orders/${id}/history`),
      ]);
      setSelected(result.order);
      setOrderHistory(history);
      setPreparedChecks(new Set());
      return result.order;
    } catch (error) {
      showError(error, "No se pudo abrir el pedido.");
      return null;
    } finally { setDetailLoading(false); }
  }, [showError]);

  useEffect(() => {
    const openFromFinance = (event: Event) => {
      const orderId = (event as CustomEvent<{ orderId?: string }>).detail?.orderId?.trim();
      if (orderId) void loadDetail(orderId);
    };
    window.addEventListener("nutriplus:open-order", openFromFinance);
    return () => window.removeEventListener("nutriplus:open-order", openFromFinance);
  }, [loadDetail]);

  useEffect(() => {
    if (initialDeepLinkHandled.current) return;
    const orderId = new URLSearchParams(window.location.search).get("order")?.trim();
    if (!orderId) return;
    initialDeepLinkHandled.current = true;
    const timer = window.setTimeout(() => void loadDetail(orderId), 0);
    return () => window.clearTimeout(timer);
  }, [loadDetail]);

  const refreshAfterMutation = useCallback(async (order: OrderRecord, inventoryChanged = false) => {
    setSelected(order);
    const [, , , history] = await Promise.all([
      loadOrders(),
      loadUpcoming(),
      inventoryChanged ? Promise.resolve(onInventoryChanged()) : Promise.resolve(),
      api<OrderHistoryRecord>(`/api/orders/${order.id}/history`),
    ]);
    setOrderHistory(history);
  }, [loadOrders, loadUpcoming, onInventoryChanged]);

  const visibleOrders = useMemo(() => {
    return orders;
  }, [orders]);

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
    if (!editor || saving || submitInFlight.current) return;
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
    const editorTotals = draftTotals(editor.lines, editor.deliveryFee);
    if (!editor.id && editor.initialPaymentAmount && (Number(editor.initialPaymentAmount) < 1 || Number(editor.initialPaymentAmount) > editorTotals.total)) {
      setNotice({ tone: "warning", title: "Abono inicial inválido", message: `El abono debe ser mayor a cero y no superar el total de ${crc(editorTotals.total)}. El pedido todavía no fue creado y no se registró ningún pago.` });
      return;
    }
    submitInFlight.current = true;
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
        operationId: editor.id ? operationId("order-update") : editor.createOperationId || operationId("order-create"),
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
        ...(!editor.id && Number(editor.initialPaymentAmount) > 0 ? {
          initialPayment: { amount: Math.round(Number(editor.initialPaymentAmount)), method: editor.initialPaymentMethod },
        } : {}),
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
    finally { submitInFlight.current = false; setSaving(false); }
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
      setReopenOpen(false);
      setReturnOpen(false);
      setReceiptOpen(false);
      setCancelReason("");
      setReprogramReason("");
      setPaymentAmount("");
      setPaymentReference("");
      setReopenReason("");
      setReturnReason("");
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

  const createOrFindRoute = useCallback(async (date: string) => {
    const existing = await api<{ routes: Array<{ id: string }> }>(`/api/delivery-routes?date=${date}&status=OPEN`);
    if (existing.routes[0]) return existing.routes[0].id;
    const created = await api<{ route: { id: string } }>("/api/delivery-routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, label: `Entregas ${dateLabel(date)}` }),
    });
    return created.route.id;
  }, []);

  const loadRouteDate = useCallback(async (date: string) => {
    setRouteDecisions({});
    routeCloseOperationId.current = null;
    setRoutePanelLoading(true);
    try {
      const listed = await api<{ routes: Array<{ id: string }> }>(`/api/delivery-routes?date=${encodeURIComponent(date)}`);
      setRouteSnapshot(listed.routes[0] ? await api<RouteSnapshot>(`/api/delivery-routes/${listed.routes[0].id}`) : emptyRouteSnapshot(date));
    } catch (error) { showError(error, "No se pudo abrir la ruta del día."); }
    finally { setRoutePanelLoading(false); }
  }, [showError]);

  const openRoutePanel = useCallback(async () => {
    setRouteDate(selectedDate);
    setRoutePanelOpen(true);
    await loadRouteDate(selectedDate);
  }, [loadRouteDate, selectedDate]);

  const closeRoute = useCallback(async () => {
    if (!routeSnapshot || busyAction) return;
    setBusyAction("close-route");
    try {
      const closeOperation = routeCloseOperationId.current || operationId("route-close");
      routeCloseOperationId.current = closeOperation;
      const result = await api<RouteSnapshot>(`/api/delivery-routes/${routeSnapshot.route.id}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId: closeOperation, decisions: routeDecisions }),
      });
      setRouteSnapshot(result);
      setRouteCloseConfirm(false);
      setRouteDecisions({});
      routeCloseOperationId.current = null;
      setNotice({ tone: "success", title: "Ruta cerrada", message: "Las entregas elegidas quedaron registradas exactamente una vez. Los no entregados siguen pendientes y reprogramables; no se crearon pagos ni movimientos extra de inventario." });
    } catch (error) { showError(error, "No se pudo cerrar la ruta."); }
    finally { setBusyAction(null); }
  }, [busyAction, routeDecisions, routeSnapshot, showError]);

  const downloadPrint = useCallback(async (date = selectedDate) => {
    if (printing) return;
    setPrinting(true);
    try {
      const response = await fetch(`/api/orders/print?date=${encodeURIComponent(date)}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string; title?: string };
        const error = new Error(payload.error || "No se pudo generar la hoja de pedidos.") as Error & { title?: string };
        error.title = payload.title;
        throw error;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `pedidos-${date}.pdf`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice({ tone: "success", title: "Hoja preparada", message: "El PDF conserva el orden de ruta e incluye el consolidado de productos para cargar." });
    } catch (error) { showError(error, "No se pudo generar la hoja de pedidos."); }
    finally { setPrinting(false); }
  }, [printing, selectedDate, showError]);

  const openReceipt = useCallback(() => {
    if (!selected?.lines) return;
    setReceiptLines(selected.lines.filter((line) => line.pendingReceiptQuantity > 0).map((line) => {
      const exact = products.find((product) => product.id === line.productId
        || (line.barcode && product.code?.trim().toLowerCase() === line.barcode.trim().toLowerCase())
        || normalizeName(product.name) === normalizeName(line.productName));
      return {
        orderLineId: line.id,
        productName: line.productName,
        productId: line.productId || exact?.id || null,
        quantityReceived: String(line.pendingReceiptQuantity),
        pending: line.pendingReceiptQuantity,
        barcode: line.barcode,
      };
    }));
    setReceiptMode("INVENTORY_NOW");
    setReceiptOpen(true);
  }, [products, selected]);

  const createReceiptProduct = useCallback(async (line: ReceiptDraftLine) => {
    if (catalogBusy) return;
    const quote = quotes.find((candidate) => (line.barcode && candidate.code?.trim().toLowerCase() === line.barcode.trim().toLowerCase())
      || normalizeName(candidate.name) === normalizeName(line.productName));
    if (!quote) {
      setNotice({ tone: "warning", title: "Producto no encontrado en No inventario", message: "Crealo primero con el flujo seguro de Productos y luego volvé a seleccionar la vinculación. No se inventó ningún código ni se movió stock." });
      return;
    }
    setCatalogBusy(line.orderLineId);
    try {
      const mutationId = operationId("special-product-link");
      const result = await api<{ product: ProductRecord }>(`/api/quotes/${quote.id}/move-to-inventory`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mutation-Id": mutationId },
        body: JSON.stringify({
          mutationId,
          name: quote.name,
          code: quote.code || "",
          purchasePriceUsd: quote.purchasePriceUsd,
          weightLb: quote.weightLb,
          quantityAvailable: 0,
          minimumStock: 0,
          minimumStockEnabled: false,
        }),
      });
      if (!result.product?.id) throw new Error("El producto se creó sin una referencia válida.");
      setReceiptLines((current) => current.map((entry) => entry.orderLineId === line.orderLineId ? { ...entry, productId: result.product.id } : entry));
      await Promise.resolve(onCatalogChanged());
      setNotice({ tone: "success", title: "Producto vinculado de forma segura", message: `${result.product.name} se creó con stock 0. La existencia física solo cambiará al confirmar el Camino A.` });
    } catch (error) { showError(error, "No se pudo crear el producto para la recepción."); }
    finally { setCatalogBusy(null); }
  }, [catalogBusy, onCatalogChanged, quotes, showError]);

  const addSpecialToRoute = useCallback(async () => {
    if (!selected || busyAction || !specialRouteDate) return;
    setBusyAction("special-route");
    try {
      let current = selected;
      if (current.scheduledDeliveryDate !== specialRouteDate) {
        const reprogrammed = await api<{ order: OrderRecord }>(`/api/orders/${current.id}/reprogram`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operationId: operationId("special-route-date"), version: current.version, scheduledDeliveryDate: specialRouteDate, reason: "Encargo recibido y programado para entrega" }),
        });
        current = reprogrammed.order;
      }
      const routeId = await createOrFindRoute(specialRouteDate);
      const route = await api<RouteSnapshot>(`/api/delivery-routes/${routeId}`);
      const position = Math.max(0, ...route.orders.filter((order) => order.routeMembership.active).map((order) => order.routeMembership.position)) + 1;
      const assigned = await api<{ order: OrderRecord }>(`/api/delivery-routes/${routeId}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: current.id, position }),
      });
      setSpecialRouteOpen(false);
      setNotice({ tone: "success", title: "Encargo agregado a entrega", message: `${assigned.order.orderNumber} conserva el mismo pedido y NP; no se creó ningún duplicado.` });
      await refreshAfterMutation(assigned.order);
    } catch (error) { showError(error, "No se pudo agregar el Encargo a la ruta."); }
    finally { setBusyAction(null); }
  }, [busyAction, createOrFindRoute, refreshAfterMutation, selected, showError, specialRouteDate]);

  const moveOrder = useCallback(async (index: number, direction: -1 | 1) => {
    if (routeBusy) return;
    const target = index + direction;
    if (target < 0 || target >= orders.length) return;
    const next = [...orders];
    [next[index], next[target]] = [next[target], next[index]];
    setOrders(next);
    setRouteBusy(true);
    try {
      const routeId = await createOrFindRoute(selectedDate);
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
  }, [createOrFindRoute, loadOrders, orders, routeBusy, selectedDate, showError]);

  const totals = editor ? draftTotals(editor.lines, editor.deliveryFee) : null;
  const routeCloseSummary = useMemo(() => {
    const pending = routeSnapshot?.pendingOrders || [];
    const delivered = pending.filter((order) => routeDecisions[order.id] === "DELIVERED");
    const notDelivered = pending.filter((order) => routeDecisions[order.id] === "NOT_DELIVERED");
    return {
      total: pending.length,
      delivered: delivered.length,
      notDelivered: notDelivered.length,
      amount: delivered.reduce((sum, order) => sum + order.total, 0),
      shipping: delivered.reduce((sum, order) => sum + order.deliveryFee, 0),
      paid: delivered.reduce((sum, order) => sum + order.paidTotal, 0),
      balance: delivered.reduce((sum, order) => sum + order.balance, 0),
      complete: pending.length > 0 && delivered.length + notDelivered.length === pending.length,
    };
  }, [routeDecisions, routeSnapshot]);
  const allPrepared = Boolean(selected?.lines?.length) && selected!.lines!.every((line) => preparedChecks.has(line.id));
  const selectedSpecialStatus = selected?.specialOrder?.status || selected?.specialOrderStatus || null;
  const canConfirmSelected = Boolean(selected && (selected.status === "REOPENED"
    || (selected.status === "DRAFT" && (selected.orderType === "STANDARD"
      || (Boolean(selected.receiptResolvedAt) && ["RECEIVED_READY", "ADDED_TO_ROUTE"].includes(selectedSpecialStatus || ""))))));
  const fulfillmentUnits = selected?.lines?.reduce((sum, line) => sum + Math.max(0, Math.min(line.pendingDeliveryQuantity, Number(fulfillmentLines[line.id]) || 0)), 0) || 0;
  const pendingAfterFulfillment = selected?.lines?.reduce((sum, line) => sum + Math.max(0, line.pendingDeliveryQuantity - (Number(fulfillmentLines[line.id]) || 0)), 0) || 0;

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
      <div className="orders-day-summary"><span><b>{orders.length}</b> pedido{orders.length === 1 ? "" : "s"}</span><span><b>{orders.reduce((sum, order) => sum + order.unitTotal, 0)}</b> unidades</span>{routeBusy && <span><Loader2 className="spin" />Guardando ruta…</span>}<div className="orders-day-actions"><button className="btn secondary small" onClick={() => void downloadPrint()} disabled={printing}>{printing ? <Loader2 className="spin" /> : <Printer />}Imprimir hoja</button><button className="btn secondary small" onClick={() => void openRoutePanel()}><RouteIcon />Ruta del día</button></div></div>
    </>}

    {section === "special" && <section className="surface special-intro"><ShoppingBag /><div><b>Encargos separados del flujo diario</b><p>Crear el Encargo no mueve inventario. Su recepción y vinculación se resuelven de forma explícita antes de confirmar.</p></div></section>}

    {section === "history" && <section className="surface orders-history-filters">
      <div className="input-icon grow"><Search /><input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="Pedido, cliente, teléfono o producto" /></div>
      <select value={historyStatus} onChange={(event) => { setHistoryStatus(event.target.value); setPage(1); }} aria-label="Filtrar por estado"><option value="">Todos los estados</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
      <select value={historyPayment} onChange={(event) => { setHistoryPayment(event.target.value); setPage(1); }} aria-label="Filtrar por pago"><option value="">Todos los pagos</option><option value="PENDING">Pendiente</option><option value="PARTIAL">Abonado</option><option value="PAID">Pagado</option></select>
      <select value={historyType} onChange={(event) => { setHistoryType(event.target.value); setPage(1); }} aria-label="Filtrar por tipo"><option value="">Entregas y Encargos</option><option value="STANDARD">Entrega normal</option><option value="SPECIAL_ORDER">Encargo</option></select>
      <label className="orders-history-date"><span>Fecha</span><input type="date" value={historyDate} onChange={(event) => { setHistoryDate(event.target.value); setPage(1); }} /></label>
    </section>}

    {loading ? <section className="surface orders-loading"><Loader2 className="spin" />Cargando pedidos…</section> : visibleOrders.length === 0 ? <section className="surface orders-empty"><Package /><h2>{section === "history" ? "No hay coincidencias" : section === "special" ? "Todavía no hay Encargos" : "No hay pedidos para esta fecha"}</h2><p>{section === "history" ? "Cambiá los filtros o avanzá de página." : "Creá el primero desde el botón superior."}</p></section> : <section className="orders-list">
      {visibleOrders.map((order, index) => <article className={`orders-card status-${order.status.toLowerCase()}`} key={order.id}>
        {section === "deliveries" && !["DELIVERED", "CANCELLED"].includes(order.status) && <div className="orders-route-controls"><button onClick={() => void moveOrder(index, -1)} disabled={index === 0 || routeBusy} aria-label={`Subir ${order.orderNumber}`}><ArrowUp /></button><span>{order.routePosition || index + 1}</span><button onClick={() => void moveOrder(index, 1)} disabled={index === orders.length - 1 || routeBusy} aria-label={`Bajar ${order.orderNumber}`}><ArrowDown /></button></div>}
        <div className="orders-card-main">
          <header><div><span className="orders-number">Número: {order.orderNumber}</span><h2>{order.customerName}</h2></div><span className={`orders-status ${order.status.toLowerCase()}`}>{STATUS_LABELS[order.status]}</span></header>
          <p className="orders-products">{order.productSummary || `${order.lineCount} productos`} </p>
          <div className="orders-meta"><span><CalendarDays />{dateLabel(order.scheduledDeliveryDate)}</span>{order.phoneRaw && <span><Phone />{order.phoneRaw}</span>}{order.deliveryAddress && <span><MapPin />{order.deliveryAddress}</span>}</div>
          {order.orderType === "SPECIAL_ORDER" && <div className="orders-special-state"><ShoppingBag />{SPECIAL_LABELS[order.specialOrderStatus || ""] || order.specialOrderStatus}{order.estimatedArrivalDate && <small>{elapsedLabel(order.estimatedArrivalDate)}</small>}</div>}
          <footer><div><b>{crc(order.total)}</b>{order.discountTotal > 0 && <small>Descuento: -{crc(order.discountTotal)}</small>}{order.paidTotal > 0 && <small>Abonado: -{crc(order.paidTotal)}</small>}<small>Saldo pendiente: {crc(order.balance)}</small><PaymentBadge order={order} />{order.expectedPaymentMethod && <small>Esperado: {PAYMENT_LABELS[order.expectedPaymentMethod]}</small>}</div><button className="btn secondary small" onClick={() => void loadDetail(order.id)}><Eye />Abrir</button></footer>
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
          {(editor.orderType === "STANDARD" || Boolean(editor.receiptResolvedAt)) && <label className="field"><span>Fecha de entrega al cliente</span><input type="date" value={editor.scheduledDeliveryDate} onChange={(event) => setEditor({ ...editor, scheduledDeliveryDate: event.target.value })} /></label>}
          {editor.orderType === "SPECIAL_ORDER" && <label className="field"><span>Fecha estimada / límite de espera del Encargo</span><input type="date" value={editor.estimatedArrivalDate} onChange={(event) => setEditor({ ...editor, estimatedArrivalDate: event.target.value })} /><small className="hint">No crea una entrega ni una ruta. La entrega al cliente se programa después de recibir.</small></label>}
          {!editor.id && <><label className="field"><span>Abono inicial opcional</span><input type="number" min="1" step="1" value={editor.initialPaymentAmount} onChange={(event) => setEditor({ ...editor, initialPaymentAmount: event.target.value })} placeholder="Escribí el monto" /><small className="hint">Se registrará como pago real, no como venta.</small></label><label className="field"><span>Método del abono</span><select value={editor.initialPaymentMethod} disabled={!editor.initialPaymentAmount} onChange={(event) => setEditor({ ...editor, initialPaymentMethod: event.target.value as PaymentMethod })}>{Object.entries(PAYMENT_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></>}
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

        {totals && <section className="orders-totals"><span>Subtotal <b>{crc(totals.subtotal)}</b></span>{totals.discounts > 0 && <span>Descuento <b>-{crc(totals.discounts)}</b></span>}<span>Envío <b>+{crc(totals.delivery)}</b></span><strong>Total <b>{crc(totals.total)}</b></strong></section>}
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
        <div className="orders-detail-summary"><span><b>{crc(selected.subtotal)}</b><small>Subtotal productos</small></span>{selected.discountTotal > 0 && <span><b>-{crc(selected.discountTotal)}</b><small>Descuento</small></span>}<span><b>+{crc(selected.deliveryFee)}</b><small>Envío</small></span><span><b>{crc(selected.total)}</b><small>Total del pedido</small></span>{selected.paidTotal > 0 && <span><b>-{crc(selected.paidTotal)}</b><small>Abonado</small></span>}<span><b>{crc(selected.balance)}</b><small>Saldo pendiente</small></span><span><b>{selected.expectedPaymentMethod ? PAYMENT_LABELS[selected.expectedPaymentMethod] : "Sin definir"}</b><small>Método esperado</small></span></div>
        <section className="orders-detail-info"><div><UserRound /><span><b>{selected.customerName}</b><small>{selected.phoneRaw || "Sin teléfono"}</small></span></div><div><MapPin /><span><b>{selected.deliveryAddress || "Sin dirección"}</b><small>{selected.deliveryInstructions || "Sin indicaciones"}</small></span></div>{(selected.orderType === "STANDARD" || selected.receiptResolvedAt) && <div><CalendarDays /><span><b>{dateLabel(selected.scheduledDeliveryDate)}</b><small>Fecha de entrega al cliente</small></span></div>}</section>
        {selected.orderType === "SPECIAL_ORDER" && <section className="orders-special-detail"><ShoppingBag /><div><b>{SPECIAL_LABELS[selected.specialOrder?.status || selected.specialOrderStatus || ""] || selected.specialOrder?.status}</b><span>Solicitud: {dateTimeLabel(selected.specialOrder?.requestedAt || selected.createdAt)}</span>{selected.estimatedArrivalDate && <span>Estimada: {dateLabel(selected.estimatedArrivalDate)} · {elapsedLabel(selected.estimatedArrivalDate)}</span>}<small>{selected.receiptResolvedAt ? "Recepción resuelta" : "La recepción todavía no autoriza inventario ni confirmación."}</small></div></section>}
        <section className="orders-detail-lines"><header><b>Productos</b><span>{selected.lines?.reduce((sum, line) => sum + line.quantity, 0) || 0} unidades</span></header>{selected.lines?.map((line) => <article key={line.id}><div><b>{line.productName}</b><small>{line.productId ? `Vinculado a inventario #${line.productId}` : "Producto manual · no afecta inventario"}{line.discountAmount > 0 ? ` · Descuento: -${crc(line.discountAmount)}` : ""}</small></div><span>{line.quantity} × {crc(line.unitPriceSold)}</span><strong>{crc(line.lineTotal)}</strong></article>)}</section>
        <section className="orders-payment-ledger"><header><div><WalletCards /><span><b>Pagos reales</b><small>Ledger separado del método esperado</small></span></div>{selected.status !== "CANCELLED" && selected.balance > 0 && <button className="btn secondary small" onClick={() => { setPaymentAmount(""); setPaymentOpen(true); }}><Plus />Registrar abono</button>}</header>{selected.payments?.length ? selected.payments.map((payment) => <article key={payment.id}><span><b>{payment.type === "PAYMENT" ? PAYMENT_LABELS[payment.method] : "Reversión"}</b><small>{dateTimeLabel(payment.createdAt)}{payment.reference ? ` · ${payment.reference}` : ""}</small></span><strong className={payment.type === "PAYMENT" ? "" : "reversal"}>{payment.type === "PAYMENT" ? "+" : "-"}{crc(payment.amount)}</strong></article>) : <p>Todavía no hay pagos registrados.</p>}</section>
        {orderHistory && <section className="orders-timeline"><header><History /><div><b>Historial del pedido</b><small>Estados y operaciones conservados en orden cronológico</small></div></header><div>{[
          ...orderHistory.statusEvents.map((event) => ({ createdAt: String(event.created_at), label: eventLabel("", STATUS_LABELS[String(event.to_status) as OrderStatus] || String(event.to_status)), detail: event.reason ? String(event.reason) : "Cambio de estado" })),
          ...orderHistory.events.map((event) => ({ createdAt: String(event.created_at), label: eventLabel(String(event.event_type)), detail: String(event.event_type).includes("reprogrammed") ? "La fecha anterior permanece en el evento" : "Operación trazable" })),
        ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((event, index) => <article key={`${event.createdAt}-${index}`}><span></span><div><b>{event.label}</b><small>{dateTimeLabel(event.createdAt)} · {event.detail}</small></div></article>)}</div></section>}
        {selected.status === "CONFIRMED" && <section className="orders-prepared-checklist"><header><ClipboardCheck /><div><b>Lista de preparación</b><small>Esta lista es operativa local; el estado se guarda al marcar Preparado.</small></div></header>{selected.lines?.map((line) => <label key={line.id}><input type="checkbox" checked={preparedChecks.has(line.id)} onChange={() => setPreparedChecks((current) => { const next = new Set(current); if (next.has(line.id)) next.delete(line.id); else next.add(line.id); return next; })} /><span>{line.productName} × {line.quantity}</span></label>)}</section>}
        {(selected.internalNotes || selected.deliveryNotes) && <section className="orders-notes">{selected.internalNotes && <div><b>Nota interna</b><p>{selected.internalNotes}</p></div>}{selected.deliveryNotes && <div><b>Nota de entrega</b><p>{selected.deliveryNotes}</p></div>}</section>}
        <footer className="orders-detail-actions">
          {["DRAFT", "CONFIRMED", "REOPENED"].includes(selected.status) && <button className="btn secondary" onClick={() => void openEdit(selected)}><Pencil />Editar</button>}
          {selected.orderType === "SPECIAL_ORDER" && selected.status === "DRAFT" && selectedSpecialStatus === "REQUESTED" && <button className="btn primary" onClick={() => void mutate("special-order/transition", { targetStatus: "ORDERED_FROM_SUPPLIER", estimatedArrivalDate: selected.estimatedArrivalDate }, "Encargo marcado como Pedido al proveedor; no se movió inventario.")}><ShoppingBag />Pedido al proveedor</button>}
          {selected.orderType === "SPECIAL_ORDER" && selected.status === "DRAFT" && selectedSpecialStatus === "ORDERED_FROM_SUPPLIER" && <button className="btn primary" onClick={() => void mutate("special-order/transition", { targetStatus: "IN_TRANSIT" }, "Encargo en tránsito; no se movió inventario.")}><Truck />Marcar en tránsito</button>}
          {selected.orderType === "SPECIAL_ORDER" && selected.status === "DRAFT" && selectedSpecialStatus === "IN_TRANSIT" && <button className="btn primary" onClick={() => void mutate("special-order/transition", { targetStatus: "RECEIVED_PENDING_RESOLUTION" }, "Mercadería recibida. La recepción quedó pendiente de resolver y no se incrementó inventario.")}><PackageOpen />Marcar recibido</button>}
          {selected.orderType === "SPECIAL_ORDER" && selected.status === "DRAFT" && ["RECEIVED_PENDING_RESOLUTION", "PARTIALLY_RECEIVED"].includes(selectedSpecialStatus || "") && <button className="btn primary" onClick={openReceipt}><PackageCheck />Resolver recepción</button>}
          {selected.orderType === "SPECIAL_ORDER" && selected.status === "DRAFT" && selectedSpecialStatus === "RECEIVED_READY" && <button className="btn primary" onClick={() => { setSpecialRouteDate(selected.scheduledDeliveryDate || today); setSpecialRouteOpen(true); }}><RouteIcon />Agregar a lista de entrega</button>}
          {canConfirmSelected && <button className="btn primary" onClick={() => setConfirmOpen(true)}><Check />Confirmar</button>}
          {selected.status === "CONFIRMED" && <button className="btn primary" disabled={!allPrepared} onClick={() => void mutate("prepare", {}, "El pedido quedó preparado. Preparar no movió inventario.")}><PackageCheck />Marcar preparado</button>}
          {selected.status === "PREPARED" && (selected.lines || []).some((line) => line.pendingDeliveryQuantity > 0) && <button className="btn primary" onClick={() => { setFulfillmentLines(Object.fromEntries((selected.lines || []).filter((line) => line.pendingDeliveryQuantity > 0).map((line) => [line.id, String(line.pendingDeliveryQuantity)]))); setPendingDeliveryDate(addDays(selected.scheduledDeliveryDate || today, 1)); setDeliverOpen(true); }}><Truck />Registrar entrega</button>}
          {selected.status === "PREPARED" && (selected.lines || []).every((line) => line.pendingDeliveryQuantity === 0) && <button className="btn primary" onClick={() => void mutate("deliver", {}, "Corrección cerrada sin movimientos adicionales de inventario.")}><Check />Cerrar corrección</button>}
          {["DRAFT", "CONFIRMED", "PREPARED", "REOPENED"].includes(selected.status) && <button className="btn secondary" onClick={() => { setReprogramDate(selected.scheduledDeliveryDate || today); setReprogramOpen(true); }}><CalendarDays />Reprogramar</button>}
          {selected.status === "DELIVERED" && <button className="btn secondary" onClick={() => setReopenOpen(true)}><Undo2 />Reabrir/Corregir</button>}
          {["DELIVERED", "REOPENED"].includes(selected.status) && <button className="btn secondary" onClick={() => { setReturnLines(Object.fromEntries((selected.lines || []).filter((line) => line.deliveredQuantity - line.returnedQuantity > 0).map((line) => [line.id, { quantity: "0", reenterInventory: Boolean(line.productId) }]))); setReturnOpen(true); }}><PackageOpen />Registrar devolución</button>}
          {["DRAFT", "CONFIRMED", "PREPARED"].includes(selected.status) && <button className="btn danger-outline" onClick={() => setCancelOpen(true)}><X />Cancelar pedido</button>}
          {selected.status === "DRAFT" && !selected.payments?.length && <button className="btn danger-outline" onClick={() => void deleteDraft()} disabled={Boolean(busyAction)}><Trash2 />Eliminar borrador</button>}
        </footer>
      </div>
    </Modal>}

    {confirmOpen && selected && <Modal label="Confirmar pedido" onClose={() => setConfirmOpen(false)}>
      <div className="orders-confirm-card"><header className="orders-modal-head"><div><span className="eyebrow">Revisión final</span><h2>Confirmar {selected.orderNumber}</h2><p>Confirmar descuenta inventario vinculado exactamente una vez.</p></div><button className="icon-btn" onClick={() => setConfirmOpen(false)}><X /></button></header>
        <div className="orders-stock-review">{confirmationRows.length ? confirmationRows.map((row) => <article className={row.available < row.required ? "shortage" : ""} key={row.productId}><span><b>{row.name}</b><small>Necesario: {row.required} · Disponible: {row.available}</small></span>{row.available >= row.required ? <Check /> : <AlertCircle />}</article>) : <p>Todos los productos son manuales; no se descontará inventario.</p>}</div>
        {confirmationRows.some((row) => row.available < row.required) && <p className="orders-blocking-warning"><AlertCircle />{selected.orderType === "SPECIAL_ORDER" && selected.receiptResolvedAt ? "La recepción quedó vinculada como stock previamente ingresado, pero Inventario no contiene las unidades necesarias. Registrá la entrada física en Facturas/Inventario; no se descontó ni modificó nada." : "Hay faltantes. El servidor volverá a validar y conservará todo sin cambios si el stock no alcanza."}</p>}
        <div className="orders-confirm-actions"><button className="btn secondary" onClick={() => setConfirmOpen(false)}>Volver</button><button className="btn primary" disabled={Boolean(busyAction) || confirmationRows.some((row) => row.available < row.required)} onClick={() => void mutate("confirm", {}, "Pedido confirmado; el inventario vinculado se descontó exactamente una vez.", true)}>{busyAction ? <Loader2 className="spin" /> : <Check />}Confirmar pedido</button></div>
      </div>
    </Modal>}

    {deliverOpen && selected && <Modal label="Registrar entrega" onClose={() => setDeliverOpen(false)}>
      <div className="orders-confirm-card"><header className="orders-modal-head"><div><span className="eyebrow">Entrega total o parcial</span><h2>Registrar lo que recibió el cliente</h2><p>{selected.customerName} · {selected.orderNumber}. Esta operación no vuelve a descontar inventario.</p></div><button className="icon-btn" onClick={() => setDeliverOpen(false)}><X /></button></header>
        <div className="fulfillment-editor">{selected.lines?.filter((line) => line.pendingDeliveryQuantity > 0).map((line) => <article key={line.id}><div><b>{line.productName}</b><small>Pedido: {line.quantity} · ya entregado: {line.deliveredQuantity} · pendiente: {line.pendingDeliveryQuantity}</small></div><label><span>Entregar ahora</span><input type="number" min="0" max={line.pendingDeliveryQuantity} step="1" value={fulfillmentLines[line.id] || "0"} onChange={(event) => setFulfillmentLines((current) => ({ ...current, [line.id]: event.target.value }))} /></label></article>)}</div>
        <div className="delivery-review"><Truck /><div><b>{fulfillmentUnits} unidades se registrarán ahora</b><span>{pendingAfterFulfillment > 0 ? `${pendingAfterFulfillment} unidades quedarán pendientes; el pedido seguirá Preparado.` : "No quedarán unidades pendientes; el pedido pasará a Entregado."}</span></div></div>
        {pendingAfterFulfillment > 0 && <label className="field pending-date-field"><span>Fecha para lo pendiente</span><input type="date" value={pendingDeliveryDate} onChange={(event) => setPendingDeliveryDate(event.target.value)} /><small className="hint">No se borra ninguna línea: la parte pendiente se conserva para la próxima entrega.</small></label>}
        <div className="orders-confirm-actions"><button className="btn secondary" onClick={() => setDeliverOpen(false)}>Volver</button><button className="btn primary" disabled={Boolean(busyAction) || fulfillmentUnits < 1 || (pendingAfterFulfillment > 0 && !pendingDeliveryDate)} onClick={() => void mutate("fulfillments", { lines: (selected.lines || []).flatMap((line) => Number(fulfillmentLines[line.id]) > 0 ? [{ orderLineId: line.id, quantity: Math.round(Number(fulfillmentLines[line.id])) }] : []), pendingDeliveryDate: pendingAfterFulfillment > 0 ? pendingDeliveryDate : null }, pendingAfterFulfillment > 0 ? "Entrega parcial registrada. Las cantidades pendientes se conservaron y reprogramaron." : "Pedido entregado sin movimientos adicionales de inventario.")}>{busyAction ? <Loader2 className="spin" /> : <Truck />}{pendingAfterFulfillment > 0 ? "Registrar entrega parcial" : "Confirmar entrega"}</button></div></div>
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

    {reopenOpen && selected && <Modal label="Reabrir pedido" onClose={() => setReopenOpen(false)}>
      <div className="orders-confirm-card"><header className="orders-modal-head"><div><span className="eyebrow">Corrección trazable</span><h2>Reabrir/Corregir pedido</h2><p>El histórico entregado no se reescribe. El pedido pasará a Reabierto y cualquier cambio posterior aplicará únicamente el delta de inventario.</p></div><button className="icon-btn" onClick={() => setReopenOpen(false)}><X /></button></header><div className="reopen-consequences"><span><b>Inventario</b><small>Reabrir por sí solo no mueve stock; editar cantidades aplica solo diferencias.</small></span><span><b>Total y pagos</b><small>Los pagos reales permanecen en el ledger y el saldo se vuelve a derivar del total corregido.</small></span></div><label className="field"><span>Motivo obligatorio</span><textarea value={reopenReason} onChange={(event) => setReopenReason(event.target.value)} placeholder="Qué se necesita corregir" /></label><div className="orders-confirm-actions"><button className="btn secondary" onClick={() => setReopenOpen(false)}>Volver</button><button className="btn primary" disabled={reopenReason.trim().length < 3 || Boolean(busyAction)} onClick={() => void mutate("reopen", { reason: reopenReason }, "Pedido reabierto. El motivo quedó en el historial y todavía no se movió inventario.")}><Undo2 />Reabrir para corregir</button></div></div>
    </Modal>}

    {returnOpen && selected && <Modal label="Registrar devolución" onClose={() => setReturnOpen(false)}>
      <div className="orders-confirm-card"><header className="orders-modal-head"><div><span className="eyebrow">Pedido original intacto</span><h2>Registrar devolución</h2><p>Elegí cantidades y decidí explícitamente si cada producto apto vuelve al inventario.</p></div><button className="icon-btn" onClick={() => setReturnOpen(false)}><X /></button></header><div className="return-editor">{selected.lines?.filter((line) => line.deliveredQuantity - line.returnedQuantity > 0).map((line) => { const available = line.deliveredQuantity - line.returnedQuantity; const draft = returnLines[line.id] || { quantity: "0", reenterInventory: false }; return <article key={line.id}><div><b>{line.productName}</b><small>Entregado: {line.deliveredQuantity} · ya devuelto: {line.returnedQuantity} · disponible: {available}</small></div><label><span>Cantidad</span><input type="number" min="0" max={available} step="1" value={draft.quantity} onChange={(event) => setReturnLines((current) => ({ ...current, [line.id]: { ...draft, quantity: event.target.value } }))} /></label><label className={`return-stock-choice ${!line.productId ? "disabled" : ""}`}><input type="checkbox" checked={draft.reenterInventory && Boolean(line.productId)} disabled={!line.productId} onChange={(event) => setReturnLines((current) => ({ ...current, [line.id]: { ...draft, reenterInventory: event.target.checked } }))} /><span>¿Reingresar al inventario?<small>{line.productId ? "Sí crea movimiento positivo trazable." : "Producto manual: no puede incrementarse automáticamente."}</small></span></label></article>; })}</div><label className="field"><span>Motivo obligatorio</span><textarea value={returnReason} onChange={(event) => setReturnReason(event.target.value)} /></label><div className="orders-confirm-actions"><button className="btn secondary" onClick={() => setReturnOpen(false)}>Volver</button><button className="btn primary" disabled={returnReason.trim().length < 3 || !Object.values(returnLines).some((line) => Number(line.quantity) > 0) || Boolean(busyAction)} onClick={() => { const lines = Object.entries(returnLines).flatMap(([orderLineId, line]) => Number(line.quantity) > 0 ? [{ orderLineId, quantity: Math.round(Number(line.quantity)), reenterInventory: line.reenterInventory }] : []); void mutate("returns", { reason: returnReason, lines }, "Devolución registrada sin alterar el pedido original.", lines.some((line) => line.reenterInventory)); }}><PackageOpen />Registrar devolución</button></div></div>
    </Modal>}

    {receiptOpen && selected && <Modal label="Resolver recepción de Encargo" onClose={() => setReceiptOpen(false)} wide>
      <div className="orders-confirm-card"><header className="orders-modal-head"><div><span className="eyebrow">Decisión obligatoria de inventario</span><h2>Resolver recepción del Encargo</h2><p>Marcar Recibido no sumó existencias. Elegí exactamente uno de los dos caminos para estas unidades físicas.</p></div><button className="icon-btn" onClick={() => setReceiptOpen(false)}><X /></button></header><div className="receipt-mode-picker"><button className={receiptMode === "INVENTORY_NOW" ? "active" : ""} onClick={() => setReceiptMode("INVENTORY_NOW")}><PackageCheck /><span><b>Ingresar estas unidades al inventario ahora</b><small>Crea movimiento SPECIAL_ORDER_RECEIPT por la cantidad real recibida.</small></span></button><button className={receiptMode === "ALREADY_INVENTORY" ? "active" : ""} onClick={() => setReceiptMode("ALREADY_INVENTORY")}><Check /><span><b>Ya fue ingresado mediante Facturas/Inventario</b><small>Vincula el producto sin sumar inventario nuevamente.</small></span></button></div><p className="receipt-critical"><AlertCircle />Nunca elijás el primer camino si la misma unidad física ya fue ingresada por Facturas/Inventario.</p><div className="receipt-lines">{receiptLines.map((line) => <article key={line.orderLineId}><div className="receipt-line-title"><b>{line.productName}</b><small>Pendiente de recibir: {line.pending}</small></div><label><span>Producto existente</span><select value={line.productId || ""} onChange={(event) => setReceiptLines((current) => current.map((entry) => entry.orderLineId === line.orderLineId ? { ...entry, productId: event.target.value ? Number(event.target.value) : null } : entry))}><option value="">Seleccionar producto</option>{products.slice().sort((left, right) => left.name.localeCompare(right.name, "es")).map((product) => <option value={product.id} key={product.id}>{product.name} · stock {product.quantityAvailable}</option>)}</select></label><label><span>Cantidad recibida real</span><input type="number" min="1" max={line.pending} step="1" value={line.quantityReceived} onChange={(event) => setReceiptLines((current) => current.map((entry) => entry.orderLineId === line.orderLineId ? { ...entry, quantityReceived: event.target.value } : entry))} /></label>{!line.productId && receiptMode === "INVENTORY_NOW" && <button className="btn secondary small" disabled={catalogBusy === line.orderLineId} onClick={() => void createReceiptProduct(line)}>{catalogBusy === line.orderLineId ? <Loader2 className="spin" /> : <Plus />}Crear desde No inventario con stock 0</button>}</article>)}</div><div className="orders-confirm-actions"><button className="btn secondary" onClick={() => setReceiptOpen(false)}>Volver</button><button className="btn primary" disabled={Boolean(busyAction) || !receiptLines.length || receiptLines.some((line) => !line.productId || Number(line.quantityReceived) < 1 || Number(line.quantityReceived) > line.pending)} onClick={() => void mutate("special-order/receipts", { mode: receiptMode, lines: receiptLines.map((line) => ({ orderLineId: line.orderLineId, productId: line.productId, quantityReceived: Math.round(Number(line.quantityReceived)) })) }, receiptMode === "INVENTORY_NOW" ? "Recepción resuelta: se incrementó exactamente la cantidad recibida mediante movimientos trazables." : "Recepción resuelta usando stock previamente ingresado; no se creó ningún movimiento de entrada.", receiptMode === "INVENTORY_NOW")}><PackageCheck />Confirmar camino elegido</button></div></div>
    </Modal>}

    {specialRouteOpen && selected && <Modal label="Agregar Encargo a entrega" onClose={() => setSpecialRouteOpen(false)}>
      <div className="orders-confirm-card"><header className="orders-modal-head"><div><span className="eyebrow">Mismo pedido · mismo NP</span><h2>Agregar a lista de entrega</h2><p>No se creará un segundo pedido. La recepción ya resuelta se asociará a la ruta de la fecha elegida.</p></div><button className="icon-btn" onClick={() => setSpecialRouteOpen(false)}><X /></button></header><label className="field"><span>Fecha programada de entrega</span><input type="date" value={specialRouteDate} onChange={(event) => setSpecialRouteDate(event.target.value)} /></label><div className="orders-confirm-actions"><button className="btn secondary" onClick={() => setSpecialRouteOpen(false)}>Volver</button><button className="btn primary" disabled={!specialRouteDate || Boolean(busyAction)} onClick={() => void addSpecialToRoute()}><RouteIcon />Agregar a ruta</button></div></div>
    </Modal>}

    {routePanelOpen && <Modal label="Ruta del día" onClose={() => setRoutePanelOpen(false)} wide>
      <div className="route-dashboard"><header className="orders-modal-head"><div><span className="eyebrow">Consulta de ruta</span><h2>Ruta · {dateLabel(routeSnapshot?.route.date || routeDate)}</h2><label className="route-date-picker"><span>Fecha de ruta</span><input type="date" value={routeDate} onChange={(event) => { const next = event.target.value || today; setRouteDate(next); void loadRouteDate(next); }} /></label><p>{routeSnapshot?.route.label || "No existe una ruta asignada para esta fecha."}</p></div><button className="icon-btn" onClick={() => setRoutePanelOpen(false)}><X /></button></header>{routePanelLoading || !routeSnapshot ? <div className="orders-loading"><Loader2 className="spin" />Cargando la ruta…</div> : <><div className="route-status-line"><span className={`orders-status ${routeSnapshot.route.status === "CLOSED" ? "delivered" : "confirmed"}`}>{routeSnapshot.route.status === "CLOSED" ? "Ruta cerrada" : routeSnapshot.route.status === "OPEN" ? "Ruta abierta" : "Sin ruta"}</span>{routeSnapshot.route.closedAt && <small>Cerrada {dateTimeLabel(routeSnapshot.route.closedAt)}</small>}<div><button className="btn secondary small" onClick={() => void downloadPrint(routeDate)} disabled={printing}><Printer />Imprimir</button>{routeSnapshot.route.status === "OPEN" && <button className="btn primary small" onClick={() => routeSnapshot.pendingOrders.length ? setRouteCloseConfirm(true) : void closeRoute()}><Check />Cerrar ruta</button>}</div></div><section className="route-summary-grid"><span><b>{routeSnapshot.summary.delivered}</b><small>Entregados</small></span><span><b>{routeSnapshot.summary.cancelled}</b><small>Cancelados</small></span><span><b>{routeSnapshot.summary.reprogrammed}</b><small>Reprogramados</small></span><span><b>{routeSnapshot.summary.pending}</b><small>Pendientes</small></span><span><b>{crc(routeSnapshot.summary.totalDelivered)}</b><small>Total entregado</small></span><span><b>{crc(routeSnapshot.summary.totalCollected)}</b><small>Total cobrado</small></span><span><b>{crc(routeSnapshot.summary.balancePending)}</b><small>Saldo pendiente</small></span><span><b>{crc(routeSnapshot.summary.shippingTotal)}</b><small>Total envíos</small></span></section><section className="route-payment-grid">{Object.entries(routeSnapshot.summary.paymentMethods).map(([method, amount]) => <span key={method}><b>{crc(amount)}</b><small>{PAYMENT_LABELS[method as PaymentMethod]}</small></span>)}</section><section className="route-orders-list"><header><b>Pedidos de la ruta</b><span>{routeSnapshot.orders.length}</span></header>{routeSnapshot.orders.map((order) => <article className={order.routeMembership.active ? "" : "removed"} key={order.id}><span className="route-position">{order.routeMembership.position}</span><div><b>{order.orderNumber} · {order.customerName}</b><small>{order.routeMembership.active ? STATUS_LABELS[order.status] : `Reprogramado a ${dateLabel(order.scheduledDeliveryDate)}`} · saldo {crc(order.balance)}</small></div><button className="btn secondary small" onClick={() => { setRoutePanelOpen(false); void loadDetail(order.id); }}><Eye />Abrir</button></article>)}</section></>}</div>
    </Modal>}

    {routeCloseConfirm && routeSnapshot && <Modal label="Revisar cierre de ruta" onClose={() => setRouteCloseConfirm(false)} wide>
      <div className="orders-confirm-card"><header className="orders-modal-head"><div><span className="eyebrow">Decisión por pedido</span><h2>Revisar cierre de ruta</h2><p>Indicá expresamente qué se entregó. No se registrarán pagos ni se volverá a descontar inventario.</p></div><button className="icon-btn" onClick={() => setRouteCloseConfirm(false)}><X /></button></header><div className="pending-route-orders">{routeSnapshot.pendingOrders.map((order) => <article key={order.id}><div><b>{order.orderNumber} · {order.customerName}</b><small>{STATUS_LABELS[order.status]} · total {crc(order.total)} · abonado {crc(order.paidTotal)} · saldo {crc(order.balance)}</small></div><div className="route-decision"><button className={routeDecisions[order.id] === "DELIVERED" ? "active delivered" : ""} onClick={() => setRouteDecisions((current) => ({ ...current, [order.id]: "DELIVERED" }))}>Entregado</button><button className={routeDecisions[order.id] === "NOT_DELIVERED" ? "active pending" : ""} onClick={() => setRouteDecisions((current) => ({ ...current, [order.id]: "NOT_DELIVERED" }))}>No entregado</button></div></article>)}</div><section className="route-summary-grid"><span><b>{routeCloseSummary.total}</b><small>Total pedidos</small></span><span><b>{routeCloseSummary.delivered}</b><small>Entregados</small></span><span><b>{routeCloseSummary.notDelivered}</b><small>No entregados</small></span><span><b>{crc(routeCloseSummary.amount)}</b><small>Monto entregado</small></span><span><b>{crc(routeCloseSummary.shipping)}</b><small>Envíos entregados</small></span><span><b>{crc(routeCloseSummary.paid)}</b><small>Abonos registrados</small></span><span><b>{crc(routeCloseSummary.balance)}</b><small>Saldos pendientes</small></span></section><div className="orders-confirm-actions"><button className="btn secondary" onClick={() => setRouteCloseConfirm(false)}>Volver a revisar</button><button className="btn primary" disabled={Boolean(busyAction) || !routeCloseSummary.complete} onClick={() => void closeRoute()}>{busyAction ? <Loader2 className="spin" /> : <Check />}Confirmar cierre</button></div></div>
    </Modal>}
  </div>;
}
