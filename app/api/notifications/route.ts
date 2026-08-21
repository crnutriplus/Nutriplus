import { ensureDatabase, getD1 } from "@/db";
import { notificationErrorResponse } from "@/lib/notification-api";
import { listNotifications, reconcileNotifications } from "@/lib/notifications";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const db = getD1();
    await reconcileNotifications(db, { evaluateScheduled: true, deliverPush: false });
    const url = new URL(request.url);
    return Response.json(await listNotifications(db, {
      limit: Number(url.searchParams.get("limit")) || 80,
      includeDismissed: url.searchParams.get("includeDismissed") === "1",
    }));
  } catch (error) {
    return notificationErrorResponse(error, "No se pudo abrir el Centro de alertas. Intentá nuevamente; las alertas guardadas no se eliminaron.");
  }
}
