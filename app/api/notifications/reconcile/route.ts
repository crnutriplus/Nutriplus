import { ensureDatabase, getD1 } from "@/db";
import { notificationErrorResponse } from "@/lib/notification-api";
import { reconcileNotifications } from "@/lib/notifications";

export async function POST() {
  try {
    await ensureDatabase();
    return Response.json(await reconcileNotifications(getD1(), { evaluateScheduled: true, deliverPush: true }));
  } catch (error) {
    return notificationErrorResponse(error, "No se pudo reconciliar el Centro de alertas. Las operaciones de Inventario y Pedidos no se revirtieron; volvé a intentarlo.");
  }
}
