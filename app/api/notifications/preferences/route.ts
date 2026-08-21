import { ensureDatabase, getD1 } from "@/db";
import { notificationErrorResponse } from "@/lib/notification-api";
import {
  countActivePushSubscriptions,
  getNotificationPreferences,
  publicPushConfiguration,
  updateNotificationPreferences,
} from "@/lib/notifications";

async function responseBody() {
  const db = getD1();
  const [preferences, activeDevices] = await Promise.all([
    getNotificationPreferences(db),
    countActivePushSubscriptions(db),
  ]);
  const push = publicPushConfiguration();
  return { preferences, activeDevices, pushAvailable: push.available, schedulingMode: "ON_OPEN_RECONCILIATION" };
}

export async function GET() {
  try {
    await ensureDatabase();
    return Response.json(await responseBody());
  } catch (error) {
    return notificationErrorResponse(error, "No se pudo cargar la configuración de alertas. Tus preferencias guardadas no cambiaron.");
  }
}

export async function PUT(request: Request) {
  try {
    const payload = await request.json() as Record<string, unknown>;
    await ensureDatabase();
    await updateNotificationPreferences(getD1(), payload);
    return Response.json(await responseBody());
  } catch (error) {
    return notificationErrorResponse(error, "No se pudieron guardar las preferencias. Intentá nuevamente; se mantienen los valores anteriores.");
  }
}
