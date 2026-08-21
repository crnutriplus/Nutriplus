"use client";

import {
  AlertCircle,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  Loader2,
  PackageSearch,
  Settings2,
  Trash2,
  Truck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type NotificationItem = {
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

type Preferences = {
  pushEnabled: boolean;
  lowStockEnabled: boolean;
  outOfStockEnabled: boolean;
  ordersEnabled: boolean;
  specialOrdersEnabled: boolean;
  updatedAt: string;
};

type PreferencesResponse = {
  preferences: Preferences;
  activeDevices: number;
  pushAvailable: boolean;
  schedulingMode: "ON_OPEN_RECONCILIATION";
};

type Problem = {
  title: string;
  cause: string;
  action: string;
  dataState: string;
};

const DEFAULT_PREFERENCES: Preferences = {
  pushEnabled: false,
  lowStockEnabled: true,
  outOfStockEnabled: true,
  ordersEnabled: true,
  specialOrdersEnabled: true,
  updatedAt: "",
};

const DATE_FORMATTER = new Intl.DateTimeFormat("es-CR", {
  timeZone: "America/Costa_Rica",
  dateStyle: "medium",
  timeStyle: "short",
});

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers || {}) },
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error(typeof body.error === "string" ? body.error : "No se pudo completar la acción.") as Error & { problem?: Problem };
    error.problem = {
      title: typeof body.title === "string" ? body.title : "No se pudo completar",
      cause: typeof body.error === "string" ? body.error : "El servidor no pudo completar la solicitud.",
      action: typeof body.action === "string" ? body.action : "Intentá nuevamente.",
      dataState: typeof body.dataState === "string" ? body.dataState : "Tus alertas existentes se conservan.",
    };
    throw error;
  }
  return body as T;
}

function publicKeyBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function deviceLabel() {
  if (/Android/i.test(navigator.userAgent)) return "Android · este dispositivo";
  if (/iPad|iPhone|iPod/i.test(navigator.userAgent)) return "iPhone/iPad · este dispositivo";
  return "Navegador · este dispositivo";
}

async function readyServiceWorker() {
  await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  let timeout = 0;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error("El Service Worker no pudo activarse dentro del tiempo esperado.")), 10_000);
      }),
    ]);
  } finally {
    window.clearTimeout(timeout);
  }
}

function eventLabel(eventType: string) {
  if (eventType.startsWith("inventory.")) return "Inventario";
  if (eventType.startsWith("special_order.")) return "Encargo";
  if (eventType.startsWith("order.")) return "Pedidos";
  return "NutriPlus";
}

function EventIcon({ eventType }: { eventType: string }) {
  if (eventType.startsWith("inventory.")) return <PackageSearch />;
  if (eventType.startsWith("order.") || eventType.startsWith("special_order.")) return <Truck />;
  return <Bell />;
}

function ProblemCard({ problem }: { problem: Problem }) {
  return <div className="notification-problem" role="alert">
    <AlertCircle />
    <div><b>{problem.title}</b><p>{problem.cause}</p><small><strong>Qué hacer:</strong> {problem.action}</small><small><strong>Estado de los datos:</strong> {problem.dataState}</small></div>
  </div>;
}

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
  const [activeDevices, setActiveDevices] = useState(0);
  const [pushAvailable, setPushAvailable] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [installHelp, setInstallHelp] = useState(false);

  const browserPushSupported = useMemo(() => typeof window !== "undefined"
    && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window, []);

  const loadPreferences = useCallback(async () => {
    const result = await api<PreferencesResponse>("/api/notifications/preferences");
    setPreferences(result.preferences);
    setActiveDevices(result.activeDevices);
    setPushAvailable(result.pushAvailable);
  }, []);

  const loadItems = useCallback(async () => {
    const result = await api<{ notifications: NotificationItem[]; unreadCount: number }>("/api/notifications?limit=100");
    setItems(result.notifications);
    setUnreadCount(result.unreadCount);
  }, []);

  const refresh = useCallback(async (reconcile = false) => {
    try {
      if (reconcile) await api("/api/notifications/reconcile", { method: "POST" });
      await Promise.all([loadItems(), loadPreferences()]);
    } catch (error) {
      const typed = error as Error & { problem?: Problem };
      setProblem(typed.problem || {
        title: "No se pudo actualizar el Centro de alertas",
        cause: typed.message,
        action: "Verificá la conexión e intentá nuevamente.",
        dataState: "Tus alertas guardadas y datos operativos no fueron eliminados.",
      });
    }
  }, [loadItems, loadPreferences]);

  useEffect(() => {
    const permissionTimer = window.setTimeout(() => {
      setPermission(browserPushSupported ? Notification.permission : "unsupported");
      if (new URLSearchParams(window.location.search).get("notifications") === "1") setOpen(true);
      void refresh(true);
    }, 0);
    if (browserPushSupported) void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => undefined);
    const openCenter = () => setOpen(true);
    window.addEventListener("nutriplus:open-notifications", openCenter);
    const listTimer = window.setInterval(() => void loadItems().catch(() => undefined), 60_000);
    const reconcileTimer = window.setInterval(() => void refresh(true), 15 * 60_000);
    return () => {
      window.clearTimeout(permissionTimer);
      window.removeEventListener("nutriplus:open-notifications", openCenter);
      window.clearInterval(listTimer);
      window.clearInterval(reconcileTimer);
    };
  }, [browserPushSupported, loadItems, refresh]);

  const savePreferences = useCallback(async (change: Partial<Preferences>) => {
    setBusy("preferences");
    setProblem(null);
    try {
      const result = await api<PreferencesResponse>("/api/notifications/preferences", { method: "PUT", body: JSON.stringify(change) });
      setPreferences(result.preferences);
      setActiveDevices(result.activeDevices);
      setPushAvailable(result.pushAvailable);
    } catch (error) {
      const typed = error as Error & { problem?: Problem };
      setProblem(typed.problem || { title: "No se guardó la configuración", cause: typed.message, action: "Intentá nuevamente.", dataState: "Se conservan tus preferencias anteriores." });
    } finally { setBusy(null); }
  }, []);

  const activatePush = useCallback(async () => {
    setBusy("activate");
    setProblem(null);
    try {
      if (!browserPushSupported) throw Object.assign(new Error("Este navegador no implementa Service Worker, PushManager y Notification API."), { problem: {
        title: "Push no disponible en este navegador",
        cause: "Falta una o más APIs necesarias para recibir Web Push real.",
        action: "Usá Chrome moderno en Android o mantené las alertas internas.",
        dataState: "Tus alertas siguen disponibles dentro de NutriPlus.",
      } satisfies Problem });
      const ios = /iPad|iPhone|iPod/i.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
      if (ios && !standalone) {
        setInstallHelp(true);
        return;
      }
      const key = await api<{ publicKey: string }>("/api/notifications/push/public-key");
      const nextPermission = await Notification.requestPermission();
      setPermission(nextPermission);
      if (nextPermission !== "granted") {
        window.localStorage.setItem("nutriplus-notification-permission-denied", new Date().toISOString());
        setProblem({
          title: "Las notificaciones están bloqueadas por el navegador",
          cause: "El permiso fue rechazado anteriormente o acaba de ser rechazado.",
          action: "Podés activarlas desde los permisos del sitio y volver a tocar Activar notificaciones.",
          dataState: "Tus alertas siguen disponibles dentro de NutriPlus.",
        });
        return;
      }
      const registration = await readyServiceWorker();
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKeyBytes(key.publicKey) });
      const serialized = subscription.toJSON();
      const result = await api<{ preferences: Preferences; activeDevices: number }>("/api/notifications/push/subscriptions", {
        method: "POST",
        body: JSON.stringify({ ...serialized, deviceLabel: deviceLabel() }),
      });
      setPreferences(result.preferences);
      setActiveDevices(result.activeDevices);
      window.localStorage.removeItem("nutriplus-notification-permission-denied");
    } catch (error) {
      const typed = error as Error & { problem?: Problem };
      setProblem(typed.problem || {
        title: "No se pudieron activar las notificaciones push",
        cause: typed.message || "El navegador no pudo crear la suscripción.",
        action: "Verificá los permisos del sitio e intentá nuevamente.",
        dataState: "Tus alertas internas siguen disponibles y no cambió ningún dato operativo.",
      });
    } finally { setBusy(null); }
  }, [browserPushSupported]);

  const disablePush = useCallback(async () => {
    setBusy("disable");
    setProblem(null);
    try {
      let endpoint = "";
      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.getRegistration("/");
        const subscription = await registration?.pushManager.getSubscription();
        endpoint = subscription?.endpoint || "";
        if (endpoint) await api("/api/notifications/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint }) });
        await subscription?.unsubscribe();
      }
      await savePreferences({ pushEnabled: false });
      setPermission("Notification" in window ? Notification.permission : "unsupported");
    } catch (error) {
      const typed = error as Error & { problem?: Problem };
      setProblem(typed.problem || { title: "No se pudo desactivar push", cause: typed.message, action: "Intentá nuevamente.", dataState: "Las alertas internas no cambiaron." });
    } finally { setBusy(null); }
  }, [savePreferences]);

  const markAllRead = useCallback(async () => {
    setBusy("read-all");
    try { await api("/api/notifications/read-all", { method: "POST" }); await loadItems(); }
    catch (error) { const typed = error as Error & { problem?: Problem }; setProblem(typed.problem || { title: "No se actualizaron las alertas", cause: typed.message, action: "Intentá nuevamente.", dataState: "Ninguna alerta fue eliminada." }); }
    finally { setBusy(null); }
  }, [loadItems]);

  const actOnItem = useCallback(async (item: NotificationItem, action: "READ" | "DISMISS", navigate = false) => {
    setBusy(item.id);
    try {
      await api(`/api/notifications/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ action }) });
      await loadItems();
      if (navigate && item.targetUrl) window.location.assign(item.targetUrl);
    } catch (error) {
      const typed = error as Error & { problem?: Problem };
      setProblem(typed.problem || { title: "No se actualizó la alerta", cause: typed.message, action: "Intentá nuevamente.", dataState: "La alerta original se conserva." });
    } finally { setBusy(null); }
  }, [loadItems]);

  return <>
    <button className="notification-bell-button" onClick={() => setOpen(true)} aria-label={`Centro de alertas: ${unreadCount} sin leer`}>
      <Bell />{unreadCount > 0 && <b>{unreadCount > 99 ? "99+" : unreadCount}</b>}
    </button>
    {open && <div className="modal notification-center-modal" role="dialog" aria-modal="true" aria-label="Centro de notificaciones" onPointerDown={() => setOpen(false)}>
      <div className="notification-center" onPointerDown={(event) => event.stopPropagation()}>
        <header className="notification-center-head"><div><span className="eyebrow">Centro de notificaciones</span><h2>Alertas de NutriPlus</h2><p>{unreadCount ? `${unreadCount} alerta${unreadCount === 1 ? "" : "s"} sin leer` : "No tenés alertas nuevas"}</p></div><button className="icon-btn" onClick={() => setOpen(false)} aria-label="Cerrar Centro de alertas"><X /></button></header>
        {problem && <ProblemCard problem={problem} />}

        <section className="notification-permission-card">
          <div><Bell /><span><b>Notificaciones push</b><small>NutriPlus puede avisarte sobre inventario bajo, pedidos y encargos aunque no estés usando la aplicación.</small></span></div>
          {!preferences.pushEnabled
            ? permission === "denied"
              ? <button className="btn secondary" onClick={() => setProblem({ title: "Las notificaciones están bloqueadas por el navegador", cause: "El permiso fue rechazado anteriormente.", action: "Abrí los permisos de este sitio en el navegador, habilitá Notificaciones y luego recargá NutriPlus.", dataState: "Tus alertas siguen disponibles dentro de NutriPlus." })}><Settings2 />Cómo activarlas</button>
              : <button className="btn primary" disabled={busy === "activate"} onClick={() => void activatePush()}>{busy === "activate" ? <Loader2 className="spin" /> : <Bell />}Activar notificaciones</button>
            : <button className="btn secondary" disabled={busy === "disable"} onClick={() => void disablePush()}>{busy === "disable" ? <Loader2 className="spin" /> : <BellOff />}Desactivar push</button>}
          <small className="notification-capability-note">
            {permission === "denied" ? "Permiso bloqueado en este navegador. " : ""}
            {pushAvailable ? `${activeDevices} dispositivo${activeDevices === 1 ? "" : "s"} registrado${activeDevices === 1 ? "" : "s"}.` : "La clave VAPID todavía no está configurada en el servidor."}
          </small>
        </section>

        <div className="notification-toolbar"><button className="btn ghost small" onClick={() => void refresh(true)} disabled={Boolean(busy)}><Clock3 />Actualizar</button><button className="btn ghost small" onClick={() => void markAllRead()} disabled={!unreadCount || Boolean(busy)}><CheckCheck />Marcar todas como leídas</button></div>
        <section className="notification-list" aria-live="polite">
          {items.length ? items.map((item) => <article key={item.id} className={`notification-item ${item.readAt ? "read" : "unread"} ${item.severity.toLowerCase()}`}>
            <span className="notification-item-icon"><EventIcon eventType={item.eventType} /></span>
            <button className="notification-item-main" onClick={() => void actOnItem(item, "READ", true)} disabled={busy === item.id}>
              <span><b>{eventLabel(item.eventType)} · {item.readAt ? "Leída" : "Sin leer"}</b><time>{DATE_FORMATTER.format(new Date(item.createdAt))}</time></span>
              <strong>{item.title}</strong><p>{item.message}</p>
              {item.targetUrl && <small>Abrir en NutriPlus <ChevronRight /></small>}
            </button>
            <button className="notification-dismiss" onClick={() => void actOnItem(item, "DISMISS")} disabled={busy === item.id} aria-label={`Descartar ${item.title}`}><Trash2 /></button>
          </article>) : <div className="notification-empty"><Check /><h3>Todo al día</h3><p>Las nuevas alertas de Inventario, Pedidos y Encargos aparecerán aquí.</p></div>}
        </section>

        <section className="notification-settings">
          <div className="notification-settings-title"><Settings2 /><div><h3>Preferencias</h3><p>Elegí qué categorías pueden crear alertas internas y push.</p></div></div>
          {([
            ["lowStockEnabled", "Inventario bajo"],
            ["outOfStockEnabled", "Producto agotado"],
            ["ordersEnabled", "Pedidos"],
            ["specialOrdersEnabled", "Encargos"],
          ] as Array<[keyof Preferences, string]>).map(([key, label]) => <label className="notification-toggle" key={key}><span>{label}</span><input type="checkbox" checked={Boolean(preferences[key])} disabled={busy === "preferences"} onChange={(event) => void savePreferences({ [key]: event.target.checked })} /></label>)}
          <div className="notification-scheduler-limit"><Clock3 /><p><b>Alertas por fecha:</b> Sites no ofrece un scheduler del Site. Pedidos de mañana y Encargos se evalúan al abrir o actualizar NutriPlus; no se promete una hora automática con la app cerrada.</p></div>
        </section>
      </div>
    </div>}
    {installHelp && <div className="modal" role="dialog" aria-modal="true" aria-label="Instalar NutriPlus en iPhone"><div className="confirm-card install-help"><h2>Instalá NutriPlus primero</h2><p>En iPhone o iPad, agregá NutriPlus a la pantalla de inicio, abrila desde el ícono y volvé a tocar “Activar notificaciones”.</p><button className="btn primary full" onClick={() => setInstallHelp(false)}>Entendido</button></div></div>}
  </>;
}
