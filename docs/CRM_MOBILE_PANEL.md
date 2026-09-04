# CRM mobile panel (Fase 4A)

La consulta operativa se implementa como una vista móvil segura de NutriPlus, no como Dashboard App de Chatwoot. Las Dashboard Apps no se consideran una superficie móvil fiable para la operación hasta realizar una prueba física en Fase 4C.

La vista recibe únicamente `account_id`, `contact_id` y, opcionalmente, `conversation_id`. Esos valores son contexto, no autorización: el backend exige sesión de aplicación y resuelve el cliente exclusivamente mediante `chatwoot_contact_links`. El `customer_id` no se acepta desde el navegador. Un pedido se devuelve solo si pertenece al cliente resuelto.

Rutas de solo lectura:

- `/operations/crm-panel`: interfaz móvil para un agente autenticado.
- `/api/operations/crm-panel`: resumen de cliente y pedidos.
- `/api/operations/crm-panel/orders/:id`: detalle de pedido del mismo cliente.

La fuente de verdad es NutriPlus. Chatwoot conserva mensajería y el contexto resumido. No se escribe en Chatwoot, D1 ni en pedidos desde Fase 4A; el panel no consume `/api/crm/*`, que sigue reservado para HMAC de servicio.
