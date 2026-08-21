import { ensureDatabase, getD1 } from "@/db";
import { notificationErrorResponse } from "@/lib/notification-api";
import {
  countActivePushSubscriptions,
  disablePushSubscription,
  registerPushSubscription,
  updateNotificationPreferences,
} from "@/lib/notifications";

export async function POST(request: Request) {
  try {
    const payload = await request.json() as Record<string, unknown>;
    await ensureDatabase();
    const db = getD1();
    const subscription = await registerPushSubscription(db, payload);
    const preferences = await updateNotificationPreferences(db, { pushEnabled: true });
    return Response.json({ subscription, preferences, activeDevices: await countActivePushSubscriptions(db) }, { status: 201 });
  } catch (error) {
    return notificationErrorResponse(error, "No se pudo registrar este dispositivo. Las alertas internas continúan disponibles y no se modificó el inventario.");
  }
}

export async function DELETE(request: Request) {
  try {
    const payload = await request.json() as Record<string, unknown>;
    await ensureDatabase();
    const db = getD1();
    const disabled = await disablePushSubscription(db, payload);
    return Response.json({ disabled, activeDevices: await countActivePushSubscriptions(db) });
  } catch (error) {
    return notificationErrorResponse(error, "No se pudo desactivar este dispositivo. Volvé a intentarlo; las alertas internas no cambiaron.");
  }
}
