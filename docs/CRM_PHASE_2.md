# CRM / Chatwoot — Fase 2 (local, no desplegada)

Estado: **implementada y validada localmente; no desplegada**. Esta fase no conecta Chatwoot, no crea webhooks ni modifica su core.

## Fuente de verdad y modelo

NutriPlus conserva la fuente de verdad de clientes, pedidos, pagos, inventario y logística. La migración `0018_friendly_bedlam.sql` agrega:

- `customers`: cliente canónico, datos comerciales/logísticos, teléfono E.164 y versión optimista.
- `customer_external_identities`: una identidad por combinación `provider + external_account + external_id`.
- `chatwoot_contact_links`: un contacto de una cuenta Chatwoot solo puede apuntar a un customer; un customer puede tener varios contactos.
- `chatwoot_conversation_order_links`: vínculo many-to-many, sin alterar `order_external_references`.
- `crm_operations`: recibos de idempotencia para las escrituras CRM.

`orders.customer_id` se mantiene nullable y sin reconstrucción de tabla. Las órdenes previas y sus snapshots siguen válidos; la fachada CRM valida el customer antes de crear una orden nueva.

## API de integración prevista

`/api/crm/*` exige HMAC SHA-256 para cada llamada. Encabezados: `x-nutriplus-service-id`, `x-nutriplus-timestamp` (UTC epoch, máximo cinco minutos), `x-nutriplus-request-id` y `x-nutriplus-signature`. La firma cubre método, pathname, timestamp, request ID y hash del body. Los secretos solo se inyectan como `CRM_SERVICE_ID` y `CRM_SERVICE_SECRET`; no se almacenan ni registran.

Operaciones: lectura/resolución de customers, creación y edición versionada, identidades externas, enlaces Chatwoot, órdenes del cliente, búsqueda limitada de productos, resumen de pedido y creación de orden mediante el motor existente. Todas las escrituras requieren `operationId`; una clave repetida con payload distinto devuelve `409`.

## Reglas operativas

La resolución es determinista: customerId, identidad externa, teléfono E.164 y, si no hay coincidencia, `NOT_FOUND`. Nunca usa el nombre. Señales que resuelven a customers distintos devuelven conflicto. Un número CR de ocho dígitos se normaliza a `+506XXXXXXXX`; internacionales requieren E.164.

La creación CRM de pedido solo genera el flujo de borrador ya existente y llama a la misma lógica de órdenes. La validación final de stock permanece en NutriPlus al confirmar; Chatwoot solo consumirá disponibilidad informativa en una fase posterior.

No se almacenan diagnósticos, síntomas, medicamentos, conversaciones completas ni tokens de Chatwoot. Tampoco se configuró Meta en esta fase.
