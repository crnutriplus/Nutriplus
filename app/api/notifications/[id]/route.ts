import { ensureDatabase, getD1 } from "@/db";
import { notificationErrorResponse } from "@/lib/notification-api";
import { updateNotificationState } from "@/lib/notifications";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = (await context.params).id.trim();
    const payload = await request.json() as { action?: unknown };
    const action = typeof payload.action === "string" ? payload.action.toUpperCase() : "";
    if (!id || !["READ", "DISMISS"].includes(action)) {
      return Response.json({
        title: "Acción inválida",
        error: "La alerta o la acción indicada no es válida.",
        action: "Cerrá el Centro de alertas y volvé a abrirlo.",
        dataState: "Ninguna alerta fue modificada.",
        code: "NOTIFICATION_ACTION_INVALID",
      }, { status: 400 });
    }
    await ensureDatabase();
    const notification = await updateNotificationState(getD1(), id, action as "READ" | "DISMISS");
    if (!notification) return Response.json({
      title: "Alerta no encontrada",
      error: "La alerta ya no está disponible.",
      action: "Actualizá el Centro de alertas.",
      dataState: "No se modificó ninguna otra alerta.",
      code: "NOTIFICATION_NOT_FOUND",
    }, { status: 404 });
    return Response.json({ notification });
  } catch (error) {
    return notificationErrorResponse(error, "No se pudo actualizar la alerta. Intentá nuevamente; la alerta original se conserva.");
  }
}
