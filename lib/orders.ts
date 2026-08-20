export const ORDER_STATUSES = ["DRAFT", "CONFIRMED", "PREPARED", "DELIVERED", "CANCELLED", "REOPENED"] as const;
export const ORDER_SOURCES = ["MANUAL", "WHATSAPP", "INSTAGRAM_FACEBOOK", "WEB", "CRM", "OTHER"] as const;
export const PAYMENT_METHODS = ["CASH", "SINPE", "CARD", "OTHER"] as const;

export type OrderStatus = typeof ORDER_STATUSES[number];
export type OrderSource = typeof ORDER_SOURCES[number];
export type PaymentMethod = typeof PAYMENT_METHODS[number];

export class OrderError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "ORDER_INVALID_REQUEST",
    public title = "Revisá el pedido",
    public details?: unknown,
  ) {
    super(message);
  }
}

export function cleanText(value: unknown, max = 500) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

export function optionalText(value: unknown, max = 500) {
  return cleanText(value, max) || null;
}

export function requiredOperationId(payload: Record<string, unknown>) {
  const operationId = cleanText(payload.operationId, 160);
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(operationId)) {
    throw new OrderError(
      "La operación no tiene un identificador seguro. Volvé a intentarlo; no se realizó ningún cambio.",
      400,
      "ORDER_OPERATION_ID_REQUIRED",
      "Operación no identificada",
    );
  }
  return operationId;
}

export function requiredVersion(payload: Record<string, unknown>) {
  const version = Number(payload.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new OrderError(
      "Falta la versión actual del pedido. Actualizalo antes de continuar; no se realizó ningún cambio.",
      400,
      "ORDER_VERSION_REQUIRED",
      "Pedido desactualizado",
    );
  }
  return version;
}

export function integerValue(value: unknown, label: string, minimum = 0, maximum = 100_000_000) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new OrderError(
      `${label} debe ser un número entero entre ${minimum} y ${maximum}. Corregilo antes de continuar; no se realizó ningún cambio.`,
      400,
      "ORDER_INVALID_NUMBER",
      "Valor inválido",
    );
  }
  return parsed;
}

export function optionalInteger(value: unknown, label: string, minimum = 0, maximum = 100_000_000) {
  if (value == null || value === "") return null;
  return integerValue(value, label, minimum, maximum);
}

export function optionalCoordinate(value: unknown, label: string, minimum: number, maximum: number) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new OrderError(
      `${label} no es válida. Corregila o dejala vacía; no se realizó ningún cambio.`,
      400,
      "ORDER_INVALID_COORDINATE",
      "Ubicación inválida",
    );
  }
  return parsed;
}

export function normalizeCostaRicaPhone(value: unknown) {
  const raw = cleanText(value, 80);
  if (!raw) return { raw: null, normalized: null };
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 8) return { raw, normalized: `+506${digits}` };
  if (digits.length === 11 && digits.startsWith("506")) return { raw, normalized: `+${digits}` };
  return { raw, normalized: `+${digits}` };
}

export function costaRicaDate(value: unknown, label = "La fecha") {
  const date = cleanText(value, 10);
  if (!date) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new OrderError(`${label} debe usar el formato AAAA-MM-DD. Corregila; no se realizó ningún cambio.`, 400, "ORDER_INVALID_DATE", "Fecha inválida");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new OrderError(`${label} no existe en el calendario. Corregila; no se realizó ningún cambio.`, 400, "ORDER_INVALID_DATE", "Fecha inválida");
  }
  return date;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "operationId")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]));
  }
  return value;
}

export async function orderRequestHash(operationType: string, payload: Record<string, unknown>) {
  const bytes = new TextEncoder().encode(JSON.stringify({ operationType, payload: stableValue(payload) }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function paymentSummary(total: number, paid: number) {
  const normalizedPaid = Math.max(0, paid);
  const balance = Math.max(0, total - normalizedPaid);
  return {
    paidTotal: normalizedPaid,
    balance,
    paymentStatus: balance === 0 ? "PAID" : normalizedPaid > 0 ? "PARTIAL" : "PENDING",
  };
}

export function newOrderId() {
  return `order-${crypto.randomUUID()}`;
}

export function newOrderChildId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function readOrderPayload(request: Request) {
  try {
    const payload = await request.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid");
    return payload as Record<string, unknown>;
  } catch {
    throw new OrderError("El contenido de la solicitud no es válido. Actualizá el pedido y volvé a intentarlo; no se realizó ningún cambio.", 400, "ORDER_INVALID_JSON", "Solicitud inválida");
  }
}

export function orderErrorResponse(error: unknown) {
  if (error instanceof OrderError) {
    return Response.json({ error: error.message, title: error.title, code: error.code, ...(error.details ? { details: error.details } : {}) }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "";
  if (/ORDER_INVALID_TRANSITION/i.test(message)) {
    return Response.json({
      error: "El estado actual del pedido no permite esa acción. Actualizá el pedido y utilizá la operación correspondiente; no se realizó ningún cambio.",
      title: "Transición no permitida",
      code: "ORDER_INVALID_TRANSITION",
    }, { status: 409 });
  }
  if (/ORDER_INSUFFICIENT_STOCK/i.test(message)) {
    return Response.json({
      error: "El inventario cambió y ya no alcanza para completar el pedido. Actualizá el pedido antes de intentarlo nuevamente; no se realizó ningún cambio.",
      title: "Stock insuficiente",
      code: "ORDER_INSUFFICIENT_STOCK",
    }, { status: 409 });
  }
  if (/ORDER_STALE_STOCK|order_operations_guard_check|CHECK constraint failed:.*guard/i.test(message)) {
    return Response.json({
      error: "Este pedido o su inventario fue modificado mientras lo tenías abierto. Actualizalo antes de guardar; no se realizó ningún cambio.",
      title: "Pedido desactualizado",
      code: "ORDER_CONCURRENT_UPDATE",
    }, { status: 409 });
  }
  if (/ORDER_HARD_DELETE_FORBIDDEN|ORDER_LINE_HARD_DELETE_FORBIDDEN/i.test(message)) {
    return Response.json({
      error: "El pedido ya tiene historial y no puede eliminarse físicamente. Cancelalo o corregilo mediante su flujo trazable; no se realizó ningún cambio.",
      title: "Pedido protegido",
      code: "ORDER_DELETE_FORBIDDEN",
    }, { status: 409 });
  }
  if (/UNIQUE constraint failed/i.test(message)) {
    return Response.json({
      error: "La operación entra en conflicto con un registro existente. Actualizá el pedido antes de continuar; no se realizó ningún cambio.",
      title: "Conflicto de pedido",
      code: "ORDER_CONFLICT",
    }, { status: 409 });
  }
  const reference = crypto.randomUUID().slice(0, 8).toUpperCase();
  console.error("[ORDERS]", { code: "ORDER_DATABASE_WRITE_FAILED", reference, errorName: error instanceof Error ? error.name : typeof error });
  return Response.json({
    error: "No pudimos completar la operación en este momento. El pedido y el inventario conservaron su estado anterior. Intentá nuevamente.",
    title: "Problema temporal de NutriPlus",
    code: "ORDER_DATABASE_WRITE_FAILED",
    reference,
  }, { status: 500 });
}
