export function notificationErrorResponse(error: unknown, fallback = "No se pudo completar la acción de notificaciones.") {
  const code = error instanceof Error && /^[A-Z0-9_]{3,80}$/.test(error.message) ? error.message : "NOTIFICATION_OPERATION_FAILED";
  const invalidSubscription = ["PUSH_ENDPOINT_INVALID", "PUSH_P256DH_INVALID", "PUSH_AUTH_INVALID", "PUSH_SUBSCRIPTION_REQUIRED"].includes(code);
  const status = invalidSubscription ? 400 : code === "NOTIFICATION_NOT_FOUND" ? 404 : 500;
  const message = invalidSubscription
    ? "La suscripción enviada por el navegador no es válida. Volvé a activar las notificaciones desde este dispositivo. No se guardó ninguna suscripción."
    : fallback;
  return Response.json({
    title: invalidSubscription ? "No se pudo registrar este dispositivo" : "No se pudo completar",
    error: message,
    action: invalidSubscription ? "Desactivá y volvé a activar el permiso del sitio." : "Intentá nuevamente. Tus alertas y datos operativos existentes se conservan.",
    dataState: invalidSubscription ? "No se modificaron las suscripciones guardadas." : "No se eliminó ninguna alerta ni se revirtió una operación de negocio.",
    code,
  }, { status });
}
