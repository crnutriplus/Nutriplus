# Notificaciones y Centro de alertas

## Estado y clasificación de factibilidad

La base se publicó como NutriPlus v2.17 (checkpoint 31) con la migración `0016` y VAPID configurado en secretos server-side de Sites. La prueba física Android con la aplicación cerrada sigue pendiente del propietario.

La clasificación de entrega real es **C. Push bloqueado por plataforma**: la alerta, la subscription y VAPID llegan correctamente hasta el dispatcher, pero el runtime de Sites rechaza el transporte HTTPS hacia el endpoint FCM antes de obtener una respuesta HTTP. No se presenta una notificación local como si fuera push.

| Capacidad | Resultado comprobado | Consecuencia |
|---|---|---|
| A. Service Worker | El artefacto sirve `public/sw.js` en la raíz y lo registra con `scope: /`. | Puede manejar eventos del navegador fuera de la página. |
| B. Registro persistente | Se usa el registro estándar persistente del navegador. | Persiste mientras el navegador no borre datos/permisos del sitio; falta prueba real post-deployment. |
| C. Web Push / `PushManager` | El cliente exige `PushManager`, `Notification` y Service Worker antes de suscribirse. | No se presenta una notificación local como si fuera push. |
| D. Notification API | Se solicita permiso únicamente después de tocar **Activar notificaciones**. | No aparece el prompt durante la carga. |
| E. Persistencia de `PushSubscription` | D1 guarda endpoint y claves públicas de cada dispositivo, con endpoint único y desactivación. | Admite varios dispositivos y reintentos sin duplicar registros. |
| F. VAPID seguro | Sites aloja el par VAPID y el Worker lee tres variables; solo expone la pública. | La clave privada no está en Git, frontend, manifest ni respuestas. La validación productiva está activa. |
| G. Entrega backend | El Worker intenta el `fetch` HTTPS al endpoint FCM después de persistir el evento y la alerta interna, pero el runtime lo rechaza antes de una respuesta HTTP. | No hay entrega Web Push real mientras esta capacidad no exista o no se autorice un gateway externo seguro. |
| H. `push` / `notificationclick` | Ambos handlers existen y tienen pruebas locales. | La notificación muestra texto seguro y abre/focaliza una ruta interna validada. |
| I. Instalación Android | Manifest, HTTPS, `start_url`, `scope`, iconos exactos 192/512 y modo standalone están preparados. | Compatible de forma prevista con Chrome moderno; no se afirma prueba real todavía. |
| J. Manifest | `name` y `short_name` son NutriPlus, `id/start_url/scope` son `/`. | La página normal continúa funcionando sin instalar la PWA. |
| K. Hosting/caché/SPA | El Service Worker está en raíz, navegación es network-first y `/api/*` queda fuera de caché. | No se sirven inventario, pedidos o facturas viejos desde caché. |

El Site privado devuelve la puerta de acceso antes de entregar recursos a una sesión no autenticada. Por eso la prueba final debe hacerse con la sesión owner/admin autorizada. Una suscripción ya registrada se entrega mediante el push service del navegador; tocar la notificación puede volver a requerir acceso válido al Site.

## Límite de programación temporal

ChatGPT Sites no expone para este proyecto `cron`, Scheduled Worker, alarmas, colas ni un background job del Site. ChatGPT Scheduled Tasks es una función del producto ChatGPT y no un scheduler del Worker de NutriPlus.

Por tanto:

- Inventario bajo, agotado y recuperación son **event-driven** y se conocen al modificar stock.
- `order.tomorrow`, `order.pending_today`, `special_order.arrival_soon` y `special_order.overdue` son **time-evaluated** al abrir NutriPlus, abrir el Centro, tocar Actualizar o durante la reconciliación periódica mientras la página está activa.
- No se promete una notificación automática a una hora fija con la aplicación cerrada.
- Si en el futuro se necesita esa garantía, hará falta un scheduler externo o una capacidad programada oficialmente soportada por Sites, con autenticación, idempotencia y monitoreo propios.

## Arquitectura

### Entidades persistentes

| Tabla | Responsabilidad |
|---|---|
| `notification_events` | Hecho durable antes de cualquier intento de entrega; contiene tipo, entidad, operación opcional, payload mínimo y `dedupe_key`. |
| `notifications` | Alerta interna legible/descartable, presentación, ruta segura y estado agregado de entrega. |
| `notification_preferences` | Preferencias owner/admin singleton actuales; deja `principal_id` nullable para migración futura. |
| `push_subscriptions` | Suscripciones por dispositivo, endpoint único, claves públicas, última actividad y desactivación. |
| `notification_deliveries` | Intento por alerta/dispositivo/canal, respuesta, error y límite de reintentos. |
| `notification_resource_states` | Estado por recurso y ciclo para rearmar umbrales sin notificar cada cambio. |

La migración `0016_round_scarlet_witch.sql` es nueva, numerada después de la `0015` ya productiva, aditiva y sin cambios a datos/tablas anteriores. `ensureDatabase()` instala los triggers con cuerpos SQL como sentencias D1 separadas, igual que los guards existentes de Inventario y Pedidos.

### Flujo de entrega

1. La operación de negocio confirma su mutación en D1.
2. Un trigger o reconciliador registra `notification_events` con una clave única.
3. El reconciliador materializa `notifications` si la preferencia de la categoría está activa.
4. La alerta interna permanece aunque VAPID falte o la entrega externa falle.
5. Cada subscription obtiene una fila idempotente en `notification_deliveries`.
6. Respuestas `404/410` desactivan la subscription; fallos temporales quedan registrados para reintento limitado.

El Worker ejecuta la reconciliación como efecto posterior mediante `waitUntil`. Un error externo nunca revierte confirmar un pedido, un movimiento de inventario ni otra operación crítica.

## Eventos actuales

| Evento | Origen / política | Push inicial |
|---|---|---:|
| `inventory.low_stock` | Cruce `NORMAL → LOW_STOCK`; no se repite al seguir bajando dentro del umbral. | Sí |
| `inventory.out_of_stock` | Cruce a cero desde cualquier estado no agotado. | Sí |
| `inventory.back_in_stock` | Salida de agotado; registra recuperación y rearma el ciclo. | No |
| `order.tomorrow` | Un resumen por fecha de entrega y día de evaluación. | Sí |
| `order.pending_today` | Un resumen por fecha, no una alerta por pedido. | Sí |
| `special_order.arrival_soon` | Hitos D-3, D-1 y D0 respecto a la estimación. | Sí |
| `special_order.overdue` | Una vez por Encargo y fecha estimada, no diariamente. | Sí |
| `special_order.received` | Transición a recibido pendiente de resolución. | Sí |

Quedan reservados, sin lógica compleja acoplada, `order.payment_pending`, `route.pending_orders` e `invoice.pending_review`. CRM, Poket, WhatsApp y mensajes no se iniciaron.

## Deduplicación y rearmado

- `notification_events.dedupe_key` y `notifications.dedupe_key` son únicos.
- Cada transición de stock usa producto y versión persistente; un retry con el mismo mutation id no crea una segunda versión ni alerta.
- `notification_resource_states` conserva `NORMAL`, `LOW_STOCK` u `OUT_OF_STOCK` y un contador de ciclo.
- Reabastecer desde cero crea `back_in_stock`; volver a cruzar el mínimo genera un nuevo evento legítimo.
- La entrega es única por `(notification_id, subscription_id, channel)`.
- Un reproceso puede materializar eventos pendientes/fallidos sin repetir los ya materializados.

## Preferencias e identidad

Defaults:

- push desactivado hasta consentimiento;
- inventario bajo, agotado, Pedidos y Encargos activados para alertas internas.

La identidad interna multiusuario todavía no es confiable. Mientras el Site permanezca owner/admin-only se usa una fila singleton y `principal_id = NULL`. Esto no equivale a un `user_id`. Antes de ampliar acceso habrá que asociar preferencias/subscriptions a un principal autenticado y aplicar autorización server-side.

## Service Worker, caché y clic

- `install` precarga solo shell/logo/manifest; un fallo de precarga no bloquea la app.
- `activate` elimina exclusivamente versiones antiguas del caché NutriPlus y reclama clientes.
- navegación: network-first con shell como respaldo técnico;
- estáticos: cache-on-demand;
- `/api/*`, mutaciones y datos críticos: nunca interceptados ni cacheados;
- `push`: muestra una notificación con límite de título/cuerpo y tag de deduplicación;
- `notificationclick`: acepta solo rutas relativas same-origin, enfoca una ventana existente o abre NutriPlus.

NutriPlus no se convierte en offline-first. El caché no es autoridad para inventario, Pedidos, Facturas ni pagos.

## Seguridad VAPID

Variables server-side requeridas para activar push real:

- `VAPID_PUBLIC_KEY`;
- `VAPID_PRIVATE_KEY`;
- `VAPID_SUBJECT` (`mailto:` administrativo o URL HTTPS válida).

La privada debe configurarse como valor alojado/secreto en Sites. El frontend recibe solo `VAPID_PUBLIC_KEY`. Endpoint, `p256dh` y `auth` pertenecen a la subscription del navegador y se guardan en D1; no se escriben en logs ni se devuelven en listados administrativos.

## Reconciliación

El mecanismo liviano actual:

- si una operación terminó y el efecto posterior falló, el evento durable continúa `PENDING`/`FAILED`;
- GET del Centro y POST de reconciliación vuelven a materializar pendientes;
- fallos push no eliminan la alerta interna;
- reintentos externos se limitan y registran;
- no existe una cola/cron ficticio.

Para mayor escala se podrá mover la entrega a una cola real sin cambiar los eventos, alertas, preferencias ni claves de deduplicación.

## Compatibilidad y validación pendiente

Previsto, no demostrado todavía:

- Android moderno + Chrome + PWA instalada: objetivo principal.
- Chrome sin instalar: Push API puede funcionar según política del navegador, pero se debe comprobar en el Site privado.
- iOS/iPadOS: Web Push requiere instalación en pantalla de inicio en versiones compatibles; la UI muestra esa condición, pero no es prioridad ni está probado.

Antes de publicar se requiere autorización y una prueba en un deployment no productivo o ventana controlada:

1. configurar VAPID server-side sin revelar valores;
2. aplicar `0016` en el flujo de publicación autorizado;
3. abrir con owner/admin en Android Chrome;
4. instalar PWA, conceder permiso y verificar una sola subscription;
5. provocar un cruce de inventario controlado;
6. cerrar/ocultar NutriPlus y demostrar recepción;
7. tocar la notificación y validar la ruta;
8. verificar 404/410, revocación, actualización de Service Worker y ausencia de caché API;
9. confirmar que v2.16 sigue intacta hasta esa autorización.
