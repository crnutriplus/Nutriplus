# Outbox durable de Chatwoot

El receptor valida el request firmado, asegura únicamente el esquema aislado de
la outbox e inserta metadata técnica mínima antes de devolver `202`.

## Recuperación en ChatGPT Sites

ChatGPT Sites no expone un Cron Trigger para este proyecto. Por ello cada
webhook aceptado inicia un drain en `waitUntil()` y el tráfico normal inicia un
drain oportunista como máximo una vez por minuto por isolate. Cada ejecución
procesa como máximo tres jobs, prioriza los más antiguos y usa reclamación
atómica con lease de 120 segundos.

Sin Cron Trigger, un job fallido permanece durable en D1 y será reintentado en
el siguiente drenado provocado por tráfico posterior cuando `next_attempt_at`
ya haya vencido. Si no llega tráfico, permanece pendiente de forma visible y
no se pierde ni se procesa silenciosamente.

La tabla no conserva payloads raw, mensajes, contenido de conversaciones,
nombres, teléfonos, correos, direcciones, tokens ni secretos. Solo almacena
identificadores técnicos necesarios para volver a consultar la fuente canónica.
