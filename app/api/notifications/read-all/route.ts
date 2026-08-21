import { ensureDatabase, getD1 } from "@/db";
import { notificationErrorResponse } from "@/lib/notification-api";
import { markAllNotificationsRead } from "@/lib/notifications";

export async function POST() {
  try {
    await ensureDatabase();
    return Response.json({ updated: await markAllNotificationsRead(getD1()) });
  } catch (error) {
    return notificationErrorResponse(error, "No se pudieron marcar las alertas como leídas. Intentá nuevamente; ninguna alerta fue eliminada.");
  }
}
