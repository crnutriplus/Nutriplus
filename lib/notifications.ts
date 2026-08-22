import {
  diagnoseWebPushTransport,
  hasValidVapidConfiguration,
  prepareWebPushRequest,
  runWebPushRequestMatrix,
  validatePushSubscription,
  type VapidConfiguration,
} from "./web-push";

type Row = Record<string, unknown>;

export const NOTIFICATION_EVENT_TYPES = [
  "inventory.low_stock",
  "inventory.out_of_stock",
  "inventory.back_in_stock",
  "order.tomorrow",
  "order.pending_today",
  "order.payment_pending",
  "special_order.arrival_soon",
  "special_order.overdue",
  "special_order.received",
  "route.pending_orders",
  "invoice.pending_review",
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];
export type NotificationPreferenceKey = "lowStockEnabled" | "outOfStockEnabled" | "ordersEnabled" | "specialOrdersEnabled";

export type NotificationPreferences = {
  pushEnabled: boolean;
  lowStockEnabled: boolean;
  outOfStockEnabled: boolean;
  ordersEnabled: boolean;
  specialOrdersEnabled: boolean;
  updatedAt: string;
};

export type NotificationItem = {
  id: string;
  eventType: string;
  title: string;
  message: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  entityType: string;
  entityId: string | null;
  targetUrl: string | null;
  deliveryState: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
  dismissedAt: string | null;
};

type EventPresentation = {
  title: string;
  message: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  targetUrl: string;
  category: NotificationPreferenceKey;
  pushEligible: boolean;
  metadata: Record<string, unknown>;
};

type ReconcileOptions = {
  now?: Date;
  evaluateScheduled?: boolean;
  deliverPush?: boolean;
  fetchImplementation?: typeof fetch;
};

const COSTA_RICA_TIME_ZONE = "America/Costa_Rica";
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: COSTA_RICA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function rowText(row: Row, key: string) {
  return row[key] == null ? null : String(row[key]);
}

function rowBoolean(row: Row, key: string) {
  return Number(row[key] ?? 0) === 1;
}

function safeJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function safeText(value: unknown, fallback: string, limit = 180) {
  if (typeof value !== "string") return fallback;
  const clean = value.trim().replace(/\s+/g, " ");
  return clean ? clean.slice(0, limit) : fallback;
}

function safeInteger(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function costaRicaDateKey(date = new Date()) {
  const parts = dateFormatter.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return date.toISOString().slice(0, 10);
}

function dateDifference(left: string, right: string) {
  const leftTime = Date.parse(`${left}T12:00:00.000Z`);
  const rightTime = Date.parse(`${right}T12:00:00.000Z`);
  return Math.round((leftTime - rightTime) / 86_400_000);
}

function validDateKey(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function notificationId(prefix: "nevt" | "notif" | "ndel" | "psub") {
  return `${prefix}-${crypto.randomUUID()}`;
}

function preferencesFromRow(row: Row): NotificationPreferences {
  return {
    pushEnabled: rowBoolean(row, "push_enabled"),
    lowStockEnabled: rowBoolean(row, "low_stock_enabled"),
    outOfStockEnabled: rowBoolean(row, "out_of_stock_enabled"),
    ordersEnabled: rowBoolean(row, "orders_enabled"),
    specialOrdersEnabled: rowBoolean(row, "special_orders_enabled"),
    updatedAt: rowText(row, "updated_at") || new Date(0).toISOString(),
  };
}

export async function getNotificationPreferences(db: D1Database) {
  await db.prepare(`INSERT OR IGNORE INTO notification_preferences (
    id,principal_id,push_enabled,low_stock_enabled,out_of_stock_enabled,orders_enabled,special_orders_enabled
  ) VALUES (1,NULL,0,1,1,1,1)`).run();
  const row = await db.prepare("SELECT * FROM notification_preferences WHERE id=1").first<Row>();
  if (!row) throw new Error("NOTIFICATION_PREFERENCES_UNAVAILABLE");
  return preferencesFromRow(row);
}

export async function updateNotificationPreferences(db: D1Database, payload: Record<string, unknown>) {
  const current = await getNotificationPreferences(db);
  const boolean = (key: keyof Omit<NotificationPreferences, "updatedAt">) => typeof payload[key] === "boolean" ? payload[key] as boolean : current[key];
  const next = {
    pushEnabled: boolean("pushEnabled"),
    lowStockEnabled: boolean("lowStockEnabled"),
    outOfStockEnabled: boolean("outOfStockEnabled"),
    ordersEnabled: boolean("ordersEnabled"),
    specialOrdersEnabled: boolean("specialOrdersEnabled"),
  };
  const row = await db.prepare(`UPDATE notification_preferences SET
    push_enabled=?,low_stock_enabled=?,out_of_stock_enabled=?,orders_enabled=?,special_orders_enabled=?,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1 RETURNING *`)
    .bind(next.pushEnabled ? 1 : 0, next.lowStockEnabled ? 1 : 0, next.outOfStockEnabled ? 1 : 0,
      next.ordersEnabled ? 1 : 0, next.specialOrdersEnabled ? 1 : 0).first<Row>();
  if (!row) throw new Error("NOTIFICATION_PREFERENCES_UNAVAILABLE");
  if (!next.pushEnabled) {
    await db.prepare("UPDATE notifications SET delivery_state='IN_APP_ONLY' WHERE delivery_state IN ('PUSH_PENDING','PUSH_FAILED')").run();
  }
  return preferencesFromRow(row);
}

function notificationFromRow(row: Row): NotificationItem {
  return {
    id: String(row.id),
    eventType: String(row.event_type),
    title: String(row.title),
    message: String(row.message),
    severity: String(row.severity) as NotificationItem["severity"],
    entityType: String(row.entity_type),
    entityId: rowText(row, "entity_id"),
    targetUrl: rowText(row, "target_url"),
    deliveryState: String(row.delivery_state),
    metadata: safeJson(row.metadata_json),
    createdAt: String(row.created_at),
    readAt: rowText(row, "read_at"),
    dismissedAt: rowText(row, "dismissed_at"),
  };
}

export async function listNotifications(db: D1Database, options: { limit?: number; includeDismissed?: boolean } = {}) {
  const limit = Math.min(200, Math.max(1, Number(options.limit) || 80));
  const result = await db.prepare(`SELECT * FROM notifications
    ${options.includeDismissed ? "" : "WHERE dismissed_at IS NULL"}
    ORDER BY created_at DESC,id DESC LIMIT ?`).bind(limit).all<Row>();
  const unread = await db.prepare("SELECT COUNT(*) AS total FROM notifications WHERE read_at IS NULL AND dismissed_at IS NULL").first<{ total: number }>();
  return { notifications: result.results.map(notificationFromRow), unreadCount: Number(unread?.total ?? 0) };
}

export async function updateNotificationState(db: D1Database, id: string, action: "READ" | "DISMISS") {
  const row = action === "READ"
    ? await db.prepare(`UPDATE notifications SET read_at=COALESCE(read_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        WHERE id=? RETURNING *`).bind(id).first<Row>()
    : await db.prepare(`UPDATE notifications SET
        read_at=COALESCE(read_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        dismissed_at=COALESCE(dismissed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        WHERE id=? RETURNING *`).bind(id).first<Row>();
  return row ? notificationFromRow(row) : null;
}

export async function markAllNotificationsRead(db: D1Database) {
  const result = await db.prepare(`UPDATE notifications SET read_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE read_at IS NULL AND dismissed_at IS NULL`).run();
  return Number(result.meta?.changes ?? 0);
}

export async function registerPushSubscription(db: D1Database, payload: Record<string, unknown>) {
  const keys = payload.keys && typeof payload.keys === "object" ? payload.keys as Record<string, unknown> : {};
  const validated = validatePushSubscription({
    endpoint: typeof payload.endpoint === "string" ? payload.endpoint : "",
    p256dh: typeof keys.p256dh === "string" ? keys.p256dh : "",
    auth: typeof keys.auth === "string" ? keys.auth : "",
  });
  const label = typeof payload.deviceLabel === "string" ? payload.deviceLabel.trim().replace(/\s+/g, " ").slice(0, 80) || null : null;
  const id = notificationId("psub");
  const row = await db.prepare(`INSERT INTO push_subscriptions (
      id,principal_id,endpoint,p256dh,auth,content_encoding,device_label,created_at,last_seen_at,disabled_at,disabled_reason
    ) VALUES (?,NULL,?,?,?,'aes128gcm',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,NULL)
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh=excluded.p256dh,auth=excluded.auth,content_encoding='aes128gcm',
      device_label=COALESCE(excluded.device_label,push_subscriptions.device_label),
      last_seen_at=excluded.last_seen_at,disabled_at=NULL,disabled_reason=NULL
    RETURNING id,device_label,created_at,last_seen_at,disabled_at`)
    .bind(id, validated.endpoint, validated.p256dh, validated.auth, label).first<Row>();
  if (!row) throw new Error("PUSH_SUBSCRIPTION_NOT_SAVED");
  return {
    id: String(row.id),
    deviceLabel: rowText(row, "device_label"),
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
    disabled: Boolean(row.disabled_at),
  };
}

export async function disablePushSubscription(db: D1Database, payload: Record<string, unknown>) {
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  const endpoint = typeof payload.endpoint === "string" ? payload.endpoint.trim() : "";
  if (!id && !endpoint) throw new Error("PUSH_SUBSCRIPTION_REQUIRED");
  const result = await db.prepare(`UPDATE push_subscriptions SET
    disabled_at=COALESCE(disabled_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    disabled_reason=COALESCE(disabled_reason,'USER_DISABLED'),
    last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE (?<>'' AND id=?) OR (?<>'' AND endpoint=?)`)
    .bind(id, id, endpoint, endpoint).run();
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function countActivePushSubscriptions(db: D1Database) {
  const row = await db.prepare("SELECT COUNT(*) AS total FROM push_subscriptions WHERE disabled_at IS NULL").first<{ total: number }>();
  return Number(row?.total ?? 0);
}

export function serverVapidConfiguration(): VapidConfiguration | null {
  const configuration = {
    publicKey: globalThis.__NUTRIPLUS_VAPID_PUBLIC_KEY__?.trim() || "",
    privateKey: globalThis.__NUTRIPLUS_VAPID_PRIVATE_KEY__?.trim() || "",
    subject: globalThis.__NUTRIPLUS_VAPID_SUBJECT__?.trim() || "",
  };
  return hasValidVapidConfiguration(configuration) ? configuration : null;
}

export function publicPushConfiguration() {
  const configuration = serverVapidConfiguration();
  return configuration ? { available: true, publicKey: configuration.publicKey } : { available: false, publicKey: null };
}

export async function recordNotificationEvent(
  db: D1Database,
  event: {
    eventType: NotificationEventType;
    entityType: string;
    entityId?: string | null;
    sourceOperationId?: string | null;
    dedupeKey: string;
    payload?: Record<string, unknown>;
    occurredAt?: string;
    refreshExisting?: boolean;
  },
) {
  const id = notificationId("nevt");
  const occurredAt = event.occurredAt || new Date().toISOString();
  const result = await db.prepare(`INSERT OR IGNORE INTO notification_events (
    id,event_type,entity_type,entity_id,source_operation_id,dedupe_key,payload_json,
    processing_state,occurred_at,created_at
  ) VALUES (?,?,?,?,?,?,?,'PENDING',?,?)`)
    .bind(id, event.eventType, event.entityType, event.entityId ?? null, event.sourceOperationId ?? null,
      event.dedupeKey.slice(0, 320), JSON.stringify(event.payload || {}), occurredAt, occurredAt).run();
  if (Number(result.meta?.changes ?? 0) > 0) return { created: true, id };
  const existing = await db.prepare("SELECT id,payload_json FROM notification_events WHERE dedupe_key=? LIMIT 1")
    .bind(event.dedupeKey.slice(0, 320)).first<{ id: string; payload_json: string }>();
  if (existing?.id && event.refreshExisting) {
    const payload = event.payload || {};
    const payloadJson = JSON.stringify(payload);
    if (existing.payload_json !== payloadJson) {
      await db.prepare("UPDATE notification_events SET payload_json=? WHERE id=?")
        .bind(payloadJson, existing.id).run();
      const presentation = presentationFor(event.eventType, payload, event.entityId ?? null);
      if (presentation) {
        await db.prepare(`UPDATE notifications SET
          title=?,message=?,severity=?,target_url=?,metadata_json=? WHERE event_id=?`)
          .bind(presentation.title, presentation.message, presentation.severity, presentation.targetUrl,
            JSON.stringify(presentation.metadata), existing.id).run();
      }
    }
  }
  return { created: false, id: existing?.id || null };
}

async function seedInventoryStates(db: D1Database) {
  await db.prepare(`INSERT OR IGNORE INTO notification_resource_states (
    id,entity_type,entity_id,state_key,state_value,cycle,updated_at
  ) SELECT
    'nstate-product-stock-'||id,'product',CAST(id AS TEXT),'stock',
    CASE
      WHEN quantity_available<=0 THEN 'OUT_OF_STOCK'
      WHEN minimum_stock_enabled=1 AND quantity_available<=minimum_stock THEN 'LOW_STOCK'
      ELSE 'NORMAL'
    END,0,COALESCE(updated_at,CURRENT_TIMESTAMP)
  FROM products`).run();
}

async function recordScheduledEvents(db: D1Database, now: Date) {
  const today = costaRicaDateKey(now);
  const tomorrow = addDays(today, 1);
  const pendingToday = await db.prepare(`SELECT COUNT(*) AS total FROM orders
    WHERE scheduled_delivery_date=? AND status NOT IN ('DELIVERED','CANCELLED')`).bind(today).first<{ total: number }>();
  const tomorrowOrders = await db.prepare(`SELECT COUNT(*) AS total FROM orders
    WHERE scheduled_delivery_date=? AND status NOT IN ('DELIVERED','CANCELLED')`).bind(tomorrow).first<{ total: number }>();
  if (Number(pendingToday?.total ?? 0) > 0) {
    await recordNotificationEvent(db, {
      eventType: "order.pending_today",
      entityType: "order_summary",
      entityId: today,
      dedupeKey: `order.pending_today:${today}`,
      payload: { count: Number(pendingToday?.total ?? 0), date: today },
      occurredAt: now.toISOString(),
      refreshExisting: true,
    });
  }
  if (Number(tomorrowOrders?.total ?? 0) > 0) {
    await recordNotificationEvent(db, {
      eventType: "order.tomorrow",
      entityType: "order_summary",
      entityId: tomorrow,
      dedupeKey: `order.tomorrow:${tomorrow}`,
      payload: { count: Number(tomorrowOrders?.total ?? 0), date: tomorrow },
      occurredAt: now.toISOString(),
      refreshExisting: true,
    });
  }

  const specialOrders = await db.prepare(`SELECT
      o.id,o.order_number,s.estimated_arrival_date,s.special_order_status
    FROM special_order_details s
    JOIN orders o ON o.id=s.order_id
    WHERE s.estimated_arrival_date IS NOT NULL
      AND s.special_order_status NOT IN ('RECEIVED_PENDING_RESOLUTION','PARTIALLY_RECEIVED','RECEIVED_READY','ADDED_TO_ROUTE','DELIVERED','CANCELLED')
      AND o.status<>'CANCELLED'
    ORDER BY s.estimated_arrival_date,o.id`).all<Row>();
  for (const row of specialOrders.results) {
    const estimatedDate = validDateKey(row.estimated_arrival_date);
    if (!estimatedDate) continue;
    const remaining = dateDifference(estimatedDate, today);
    const orderId = String(row.id);
    const orderNumber = safeText(row.order_number, orderId, 40);
    if ([3, 1, 0].includes(remaining)) {
      await recordNotificationEvent(db, {
        eventType: "special_order.arrival_soon",
        entityType: "order",
        entityId: orderId,
        dedupeKey: `special_order.arrival_soon:${orderId}:${estimatedDate}:d${remaining}`,
        payload: { orderId, orderNumber, estimatedArrivalDate: estimatedDate, daysRemaining: remaining },
        occurredAt: now.toISOString(),
      });
    } else if (remaining < 0) {
      await recordNotificationEvent(db, {
        eventType: "special_order.overdue",
        entityType: "order",
        entityId: orderId,
        dedupeKey: `special_order.overdue:${orderId}:${estimatedDate}`,
        payload: { orderId, orderNumber, estimatedArrivalDate: estimatedDate, daysOverdue: Math.abs(remaining) },
        occurredAt: now.toISOString(),
        refreshExisting: true,
      });
    }
  }
}

function presentationFor(eventType: string, payload: Record<string, unknown>, entityId: string | null): EventPresentation | null {
  const productName = safeText(payload.productName, "Producto");
  const productId = Math.max(0, safeInteger(payload.productId));
  const quantity = Math.max(0, safeInteger(payload.quantity));
  const orderNumber = safeText(payload.orderNumber, entityId || "Encargo", 60);
  if (eventType === "inventory.low_stock") return {
    title: "Inventario bajo",
    message: `Inventario bajo: ${productName}. Quedan ${quantity} ${quantity === 1 ? "unidad" : "unidades"}.`,
    severity: "WARNING",
    targetUrl: productId ? `/?tab=products&product=${productId}` : "/?tab=products&stock=low",
    category: "lowStockEnabled",
    pushEligible: true,
    metadata: { productId, quantity, minimumStock: Math.max(0, safeInteger(payload.minimumStock)) },
  };
  if (eventType === "inventory.out_of_stock") return {
    title: "Producto agotado",
    message: `Producto agotado: ${productName}.`,
    severity: "CRITICAL",
    targetUrl: productId ? `/?tab=products&product=${productId}` : "/?tab=products&stock=low",
    category: "outOfStockEnabled",
    pushEligible: true,
    metadata: { productId, quantity: 0 },
  };
  if (eventType === "inventory.back_in_stock") return {
    title: "Producto disponible",
    message: `${productName} volvió a tener inventario. Quedan ${quantity} ${quantity === 1 ? "unidad" : "unidades"}.`,
    severity: "INFO",
    targetUrl: productId ? `/?tab=products&product=${productId}` : "/?tab=products",
    category: "lowStockEnabled",
    pushEligible: false,
    metadata: { productId, quantity },
  };
  if (eventType === "order.tomorrow") {
    const count = Math.max(1, safeInteger(payload.count, 1));
    const date = validDateKey(payload.date) || "";
    return {
      title: "Pedidos para mañana",
      message: `Tienes ${count} ${count === 1 ? "pedido programado" : "pedidos programados"} para mañana.`,
      severity: "WARNING",
      targetUrl: `/?tab=orders&section=deliveries&date=${encodeURIComponent(date)}`,
      category: "ordersEnabled",
      pushEligible: true,
      metadata: { count, date },
    };
  }
  if (eventType === "order.pending_today") {
    const count = Math.max(1, safeInteger(payload.count, 1));
    const date = validDateKey(payload.date) || "";
    return {
      title: "Pedidos pendientes hoy",
      message: `Quedan ${count} ${count === 1 ? "pedido pendiente" : "pedidos pendientes"} de completar hoy.`,
      severity: "WARNING",
      targetUrl: `/?tab=orders&section=deliveries&date=${encodeURIComponent(date)}`,
      category: "ordersEnabled",
      pushEligible: true,
      metadata: { count, date },
    };
  }
  if (eventType === "special_order.arrival_soon") {
    const remaining = Math.max(0, safeInteger(payload.daysRemaining));
    const timing = remaining === 0 ? "la fecha estimada es hoy" : `faltan ${remaining} ${remaining === 1 ? "día" : "días"} para la fecha estimada`;
    return {
      title: "Encargo próximo",
      message: `Encargo ${orderNumber}: ${timing}.`,
      severity: "WARNING",
      targetUrl: `/?tab=orders&section=special&order=${encodeURIComponent(entityId || "")}`,
      category: "specialOrdersEnabled",
      pushEligible: true,
      metadata: { orderId: entityId, orderNumber, estimatedArrivalDate: validDateKey(payload.estimatedArrivalDate), daysRemaining: remaining },
    };
  }
  if (eventType === "special_order.overdue") {
    const overdue = Math.max(1, safeInteger(payload.daysOverdue, 1));
    return {
      title: "Encargo atrasado",
      message: `Encargo ${orderNumber} lleva ${overdue} ${overdue === 1 ? "día" : "días"} de atraso respecto a la fecha estimada.`,
      severity: "CRITICAL",
      targetUrl: `/?tab=orders&section=special&order=${encodeURIComponent(entityId || "")}`,
      category: "specialOrdersEnabled",
      pushEligible: true,
      metadata: { orderId: entityId, orderNumber, estimatedArrivalDate: validDateKey(payload.estimatedArrivalDate), daysOverdue: overdue },
    };
  }
  if (eventType === "special_order.received") return {
    title: "Encargo recibido",
    message: `Encargo ${orderNumber}: recibido y pendiente de resolver antes de agregarlo a una ruta.`,
    severity: "INFO",
    targetUrl: `/?tab=orders&section=special&order=${encodeURIComponent(entityId || "")}`,
    category: "specialOrdersEnabled",
    pushEligible: true,
    metadata: { orderId: entityId, orderNumber },
  };
  return null;
}

async function materializePendingEvents(db: D1Database, preferences: NotificationPreferences) {
  const result = await db.prepare(`SELECT * FROM notification_events
    WHERE processing_state IN ('PENDING','FAILED') AND attempt_count<5
    ORDER BY occurred_at,id LIMIT 100`).all<Row>();
  let materialized = 0;
  let skipped = 0;
  for (const event of result.results) {
    const presentation = presentationFor(String(event.event_type), safeJson(event.payload_json), rowText(event, "entity_id"));
    if (!presentation || !preferences[presentation.category]) {
      await db.prepare(`UPDATE notification_events SET
        processing_state='SKIPPED',processed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_error_code=NULL
        WHERE id=? AND processing_state IN ('PENDING','FAILED')`).bind(event.id).run();
      skipped += 1;
      continue;
    }
    const id = notificationId("notif");
    const deliveryState = preferences.pushEnabled && presentation.pushEligible ? "PUSH_PENDING" : "IN_APP_ONLY";
    try {
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO notifications (
          id,event_id,event_type,title,message,severity,entity_type,entity_id,target_url,delivery_state,
          dedupe_key,metadata_json,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          id, event.id, event.event_type, presentation.title, presentation.message, presentation.severity,
          event.entity_type, event.entity_id ?? null, presentation.targetUrl, deliveryState,
          event.dedupe_key, JSON.stringify(presentation.metadata), event.occurred_at,
        ),
        db.prepare(`UPDATE notification_events SET
          processing_state='MATERIALIZED',attempt_count=attempt_count+1,last_error_code=NULL,
          processed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).bind(event.id),
      ]);
      materialized += 1;
    } catch {
      await db.prepare(`UPDATE notification_events SET
        processing_state='FAILED',attempt_count=attempt_count+1,last_error_code='MATERIALIZATION_FAILED'
        WHERE id=?`).bind(event.id).run().catch(() => undefined);
    }
  }
  return { materialized, skipped };
}

function deliveryErrorCode(error: unknown) {
  const message = error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : "PUSH_DELIVERY_FAILED";
  if (/^[A-Z0-9_]{3,80}$/.test(message)) return message;
  const name = error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "";
  if (name === "TypeError") return "PUSH_TRANSPORT_FAILED";
  if (["DataError", "OperationError", "InvalidAccessError", "NotSupportedError"].includes(name)) return "PUSH_CRYPTO_FAILED";
  return "PUSH_DELIVERY_FAILED";
}

async function deliverNotification(
  db: D1Database,
  notification: Row,
  configuration: VapidConfiguration,
  fetchImplementation: typeof fetch,
) {
  const subscriptions = await db.prepare(`SELECT * FROM push_subscriptions
    WHERE disabled_at IS NULL ORDER BY created_at,id`).all<Row>();
  if (!subscriptions.results.length) {
    await db.prepare("UPDATE notifications SET delivery_state='IN_APP_ONLY' WHERE id=?").bind(notification.id).run();
    return { sent: 0, failed: 0, disabled: 0 };
  }
  for (const subscription of subscriptions.results) {
    const deliveryId = notificationId("ndel");
    await db.prepare(`INSERT OR IGNORE INTO notification_deliveries (
      id,notification_id,subscription_id,channel,state,attempt_count,created_at
    ) VALUES (?,?,?,'PUSH','PENDING',0,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .bind(deliveryId, notification.id, subscription.id).run();
    const delivery = await db.prepare(`SELECT * FROM notification_deliveries
      WHERE notification_id=? AND subscription_id=? AND channel='PUSH' LIMIT 1`)
      .bind(notification.id, subscription.id).first<Row>();
    if (!delivery || ["SENT", "DISABLED"].includes(String(delivery.state))) continue;
    if (Number(delivery.attempt_count ?? 0) >= 3) continue;
    let prepared: Awaited<ReturnType<typeof prepareWebPushRequest>>;
    try {
      prepared = await prepareWebPushRequest({
        endpoint: String(subscription.endpoint),
        p256dh: String(subscription.p256dh),
        auth: String(subscription.auth),
      }, {
        notificationId: notification.id,
        eventType: notification.event_type,
        title: notification.title,
        body: notification.message,
        severity: notification.severity,
        url: notification.target_url || "/?notifications=1",
        tag: notification.dedupe_key,
        createdAt: notification.created_at,
      }, configuration);
    } catch (error) {
      await db.prepare(`UPDATE notification_deliveries SET
        state='FAILED',attempt_count=attempt_count+1,response_status=NULL,error_code=?,
        last_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .bind(`PUSH_DIAG_D_${deliveryErrorCode(error)}`, delivery.id).run().catch(() => undefined);
      continue;
    }
    try {
      const response = await fetchImplementation(prepared.endpoint, prepared.init);
      if (response.ok) {
        await db.prepare(`UPDATE notification_deliveries SET
          state='SENT',attempt_count=attempt_count+1,response_status=?,error_code=NULL,
          last_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),delivered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=?`).bind(response.status, delivery.id).run();
      } else if ([404, 410].includes(response.status)) {
        await db.batch([
          db.prepare(`UPDATE notification_deliveries SET
            state='DISABLED',attempt_count=attempt_count+1,response_status=?,error_code='PUSH_SUBSCRIPTION_GONE',
            last_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).bind(response.status, delivery.id),
          db.prepare(`UPDATE push_subscriptions SET
            disabled_at=COALESCE(disabled_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            disabled_reason='PUSH_SUBSCRIPTION_GONE' WHERE id=?`).bind(subscription.id),
        ]);
      } else {
        await db.prepare(`UPDATE notification_deliveries SET
          state='FAILED',attempt_count=attempt_count+1,response_status=?,error_code=?,
          last_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
          .bind(response.status, `PUSH_HTTP_${response.status}`, delivery.id).run();
      }
    } catch (error) {
      const priorDiagnostic = await db.prepare(
        "SELECT 1 AS found FROM notification_deliveries WHERE error_code LIKE 'PUSH_DIAG_%' LIMIT 1",
      ).first<{ found: number }>().catch(() => null);
      const diagnostic = priorDiagnostic
        ? { errorCode: deliveryErrorCode(error) }
        : await diagnoseWebPushTransport(prepared.endpoint, error, fetchImplementation)
          .catch(() => ({ errorCode: "PUSH_DIAG_E_PROBE_FAILED" }));
      await db.prepare(`UPDATE notification_deliveries SET
        state='FAILED',attempt_count=attempt_count+1,response_status=NULL,error_code=?,
        last_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .bind(diagnostic.errorCode, delivery.id).run().catch(() => undefined);
    }
  }
  const activeSubscriptions = await countActivePushSubscriptions(db);
  if (activeSubscriptions === 0) {
    await db.prepare(`UPDATE notification_preferences SET
      push_enabled=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1`).run();
  }
  const totals = await db.prepare(`SELECT
      SUM(CASE WHEN state='SENT' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN state='FAILED' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN state='DISABLED' THEN 1 ELSE 0 END) AS disabled,
      COUNT(*) AS total
    FROM notification_deliveries WHERE notification_id=?`).bind(notification.id).first<Row>();
  const sent = Number(totals?.sent ?? 0);
  const failed = Number(totals?.failed ?? 0);
  const disabled = Number(totals?.disabled ?? 0);
  const total = Number(totals?.total ?? 0);
  const state = sent === total && total > 0 ? "PUSH_SENT" : sent > 0 ? "PUSH_PARTIAL" : failed + disabled > 0 ? "PUSH_FAILED" : "PUSH_PENDING";
  await db.prepare("UPDATE notifications SET delivery_state=? WHERE id=?").bind(state, notification.id).run();
  return { sent, failed, disabled };
}

async function deliverPendingNotifications(db: D1Database, preferences: NotificationPreferences, fetchImplementation: typeof fetch) {
  if (!preferences.pushEnabled) return { sent: 0, failed: 0, disabled: 0 };
  const configuration = serverVapidConfiguration();
  if (!configuration) {
    await db.prepare("UPDATE notifications SET delivery_state='PUSH_FAILED' WHERE delivery_state='PUSH_PENDING'").run();
    return { sent: 0, failed: 0, disabled: 0 };
  }
  const result = await db.prepare(`SELECT * FROM notifications n
    WHERE n.delivery_state='PUSH_PENDING'
      OR (n.delivery_state='PUSH_FAILED' AND (
        NOT EXISTS (SELECT 1 FROM notification_deliveries d0 WHERE d0.notification_id=n.id)
        OR EXISTS (
          SELECT 1 FROM notification_deliveries d
          WHERE d.notification_id=n.id AND d.state='FAILED' AND d.attempt_count<3
            AND (d.last_attempt_at IS NULL OR julianday(replace(replace(d.last_attempt_at,'T',' '),'Z',''))<=julianday('now','-15 minutes'))
        )
      ))
    ORDER BY n.created_at,n.id LIMIT 50`).all<Row>();
  const totals = { sent: 0, failed: 0, disabled: 0 };
  for (const notification of result.results) {
    const outcome = await deliverNotification(db, notification, configuration, fetchImplementation);
    totals.sent += outcome.sent;
    totals.failed += outcome.failed;
    totals.disabled += outcome.disabled;
  }
  return totals;
}

async function runOneExhaustedDeliveryDiagnostic(
  db: D1Database,
  preferences: NotificationPreferences,
  fetchImplementation: typeof fetch,
) {
  if (!preferences.pushEnabled) return null;
  const existing = await db.prepare(
    "SELECT 1 AS found FROM notification_deliveries WHERE error_code LIKE 'PUSH_DIAG_%' LIMIT 1",
  ).first<{ found: number }>();
  if (existing) return null;
  const configuration = serverVapidConfiguration();
  if (!configuration) return null;
  const candidate = await db.prepare(`SELECT
      d.id AS delivery_id,s.endpoint,s.p256dh,s.auth,
      n.id AS notification_id,n.event_type,n.title,n.message,n.severity,n.target_url,n.dedupe_key,n.created_at
    FROM notification_deliveries d
    JOIN push_subscriptions s ON s.id=d.subscription_id AND s.disabled_at IS NULL
    JOIN notifications n ON n.id=d.notification_id
    WHERE d.state='FAILED' AND d.error_code='PUSH_TRANSPORT_FAILED'
    ORDER BY d.last_attempt_at DESC,d.id LIMIT 1`).first<Row>();
  if (!candidate) return null;

  let prepared: Awaited<ReturnType<typeof prepareWebPushRequest>>;
  try {
    prepared = await prepareWebPushRequest({
      endpoint: String(candidate.endpoint),
      p256dh: String(candidate.p256dh),
      auth: String(candidate.auth),
    }, {
      notificationId: candidate.notification_id,
      eventType: candidate.event_type,
      title: candidate.title,
      body: candidate.message,
      severity: candidate.severity,
      url: candidate.target_url || "/?notifications=1",
      tag: candidate.dedupe_key,
      createdAt: candidate.created_at,
    }, configuration);
  } catch (error) {
    const errorCode = `PUSH_DIAG_D_${deliveryErrorCode(error)}`;
    await db.prepare(`UPDATE notification_deliveries SET error_code=?,attempt_count=attempt_count+1,
      response_status=NULL,last_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .bind(errorCode, candidate.delivery_id).run();
    return { classification: "D", webPush: "NOT_ATTEMPTED", errorCode } as const;
  }

  const transport = await diagnoseWebPushTransport(prepared.endpoint, new TypeError("REDACTED"), fetchImplementation)
    .catch(() => ({ classification: "E", errorCode: "PUSH_DIAG_E_PROBE_FAILED" } as const));
  try {
    const response = await fetchImplementation(prepared.endpoint, prepared.init);
    const errorCode = `PUSH_DIAG_${transport.classification}_HTTP_${response.status}`;
    await db.prepare(`UPDATE notification_deliveries SET state=?,error_code=?,attempt_count=attempt_count+1,
      response_status=?,last_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      delivered_at=CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE delivered_at END WHERE id=?`)
      .bind(response.ok ? "SENT" : "FAILED", errorCode, response.status, response.ok ? 1 : 0, candidate.delivery_id).run();
    return { classification: transport.classification, webPush: response.ok ? "PASS" : "HTTP_FAILED", errorCode } as const;
  } catch {
    await db.prepare(`UPDATE notification_deliveries SET error_code=?,attempt_count=attempt_count+1,
      response_status=NULL,last_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .bind(transport.errorCode, candidate.delivery_id).run();
    return { classification: transport.classification, webPush: "TRANSPORT_FAILED", errorCode: transport.errorCode } as const;
  }
}

function compactMatrixResult(results: Awaited<ReturnType<typeof runWebPushRequestMatrix>>) {
  const value = results.map((result) => {
    const variant = result.variant === "G_MANUAL" ? "GM" : result.variant;
    return `${variant}${result.ok ? `H${result.status}` : `X${result.failure || "ERROR"}`}`;
  }).join("_");
  return `PUSH_MX_${value}`;
}

async function runOneRequestMatrix(
  db: D1Database,
  preferences: NotificationPreferences,
  fetchImplementation: typeof fetch,
) {
  if (!preferences.pushEnabled) return null;
  const existing = await db.prepare(
    "SELECT 1 AS found FROM notification_deliveries WHERE error_code LIKE 'PUSH_MX_%' LIMIT 1",
  ).first<{ found: number }>();
  if (existing) return null;
  const configuration = serverVapidConfiguration();
  if (!configuration) return null;
  const candidate = await db.prepare(`SELECT
      d.id AS delivery_id,s.endpoint,s.p256dh,s.auth,
      n.id AS notification_id,n.event_type,n.title,n.message,n.severity,n.target_url,n.dedupe_key,n.created_at
    FROM notification_deliveries d
    JOIN push_subscriptions s ON s.id=d.subscription_id AND s.disabled_at IS NULL
    JOIN notifications n ON n.id=d.notification_id
    WHERE d.state='FAILED' AND d.error_code='PUSH_DIAG_B_TYPEERROR'
    ORDER BY d.last_attempt_at DESC,d.id LIMIT 1`).first<Row>();
  if (!candidate) return null;
  let prepared: Awaited<ReturnType<typeof prepareWebPushRequest>>;
  try {
    prepared = await prepareWebPushRequest({
      endpoint: String(candidate.endpoint), p256dh: String(candidate.p256dh), auth: String(candidate.auth),
    }, {
      notificationId: candidate.notification_id, eventType: candidate.event_type, title: candidate.title,
      body: candidate.message, severity: candidate.severity, url: candidate.target_url || "/?notifications=1",
      tag: candidate.dedupe_key, createdAt: candidate.created_at,
    }, configuration);
  } catch (error) {
    const errorCode = `PUSH_MX_DX${deliveryErrorCode(error)}`;
    await db.prepare("UPDATE notification_deliveries SET error_code=?,last_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
      .bind(errorCode, candidate.delivery_id).run();
    return { errorCode };
  }
  const results = await runWebPushRequestMatrix(prepared, fetchImplementation);
  const errorCode = compactMatrixResult(results);
  const complete = results.find((result) => result.variant === "G");
  await db.prepare(`UPDATE notification_deliveries SET state=?,error_code=?,attempt_count=attempt_count+1,
    response_status=?,last_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    delivered_at=CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE delivered_at END WHERE id=?`)
    .bind(complete?.ok && complete.status && complete.status >= 200 && complete.status < 300 ? "SENT" : "FAILED",
      errorCode, complete?.status ?? null, complete?.ok && complete.status && complete.status >= 200 && complete.status < 300 ? 1 : 0,
      candidate.delivery_id).run();
  return { errorCode, results };
}

export async function reconcileNotifications(db: D1Database, options: ReconcileOptions = {}) {
  await seedInventoryStates(db);
  if (options.evaluateScheduled !== false) await recordScheduledEvents(db, options.now || new Date());
  const preferences = await getNotificationPreferences(db);
  const materialization = await materializePendingEvents(db, preferences);
  const requestMatrix = options.deliverPush === false
    ? null
    : await runOneRequestMatrix(db, preferences, options.fetchImplementation || globalThis.__NUTRIPLUS_PUSH_TEST_FETCH__ || fetch);
  const pushDiagnostic = options.deliverPush === false
    ? null
    : await runOneExhaustedDeliveryDiagnostic(db, preferences, options.fetchImplementation || globalThis.__NUTRIPLUS_PUSH_TEST_FETCH__ || fetch);
  const delivery = options.deliverPush === false
    ? { sent: 0, failed: 0, disabled: 0 }
    : await deliverPendingNotifications(db, preferences, options.fetchImplementation || globalThis.__NUTRIPLUS_PUSH_TEST_FETCH__ || fetch);
  const pending = await db.prepare("SELECT COUNT(*) AS total FROM notification_events WHERE processing_state IN ('PENDING','FAILED')").first<{ total: number }>();
  return {
    ...materialization,
    requestMatrix,
    pushDiagnostic,
    delivery,
    pendingEvents: Number(pending?.total ?? 0),
    evaluatedAt: (options.now || new Date()).toISOString(),
    timeZone: COSTA_RICA_TIME_ZONE,
    schedulingMode: "ON_OPEN_RECONCILIATION" as const,
  };
}

export const notificationTime = {
  timeZone: COSTA_RICA_TIME_ZONE,
  costaRicaDateKey,
  addDays,
  dateDifference,
};
