# Historial de versiones de NutriPlus

NutriPlus mantiene dos identificadores independientes:

- **Versión pública:** se muestra a las personas usuarias y avanza como `2.3`, `2.4`, `2.5`, etc.
- **Checkpoint / commit / deployment:** identifica técnicamente un estado del código. Nunca es el número público de NutriPlus.

`package.json` usa SemVer, por lo que representa la versión pública `2.23` como `2.23.0`. El valor que controla la versión mostrada por la aplicación está en `lib/public-version.ts`.

## 2.25 — 2026-08-29

- Crear producto desde una factura exige y conserva precio de compra y peso, muestra los precios derivados con la calculadora y parámetros existentes, admite código manual o el escáner actual y autoselecciona sin mover inventario antes de confirmar.
- El guard de ingreso pendiente se limita a su factura. Un `404` confirmado por el servidor limpia el bloqueo huérfano sin tocar inventario; una operación existente continúa protegida contra reintentos.
- Las compras de inventario pagadas aparecen en Finanzas → Caja con proveedor, factura, moneda, método y últimos cuatro dígitos. Se contabilizan el día de confirmación en Costa Rica y conservan aparte la fecha original del documento.
- Store Credit permanece trazable como componente no monetario, sin afectar Caja, gasto operativo ni COGS; los componentes financieros conservan idempotencia por factura y pago.
- El PDF de Ruta elimina Cliente y redistribuye el espacio a Productos y Dirección, conservando teléfono/NP, numeración, totales, blanco y negro, ajuste dinámico y multipágina.

## 2.24 — 2026-08-29

- Las facturas importadas desde ChatGPT conservan estado pagado, pagos divididos, método, moneda, fecha, procedencia y solo los últimos cuatro dígitos; al confirmar Inventario crean una única salida idempotente por medio en el ledger financiero existente.
- Los costos netos por línea respetan descuentos explícitos y distribuyen descuentos globales por proporción y mayor resto, con suma exacta en centavos. Las líneas personales siguen conciliables, pero no afectan las finanzas del negocio; Store Credit se registra sin reducir caja.
- Finanzas admite montos CRC enteros o con dos decimales sin pérdida, y volver desde el detalle de una venta restaura Finanzas/Ventas y su estado mediante el historial real.
- Facturas permite crear un producto faltante en línea con la API y validación existentes, lo selecciona automáticamente y conserva el borrador sin crear existencias.
- El PDF de Ruta es monocromático, recupera la numeración consecutiva, integra NP bajo el teléfono, formatea teléfonos de Costa Rica y amplía Productos con ajuste dinámico y paginación.

## 2.23 — 2026-08-29

- Nuevo módulo móvil **Finanzas / Ventas y gastos**: ventas solo al estado `DELIVERED`, COGS desde snapshots históricos, descuentos y envío separados, caja derivada del ledger de pagos, cuentas por cobrar, rentabilidad por producto/pedido/ruta y cifras trazables.
- Gastos confirmados e idempotentes con reversas append-only, moneda y tipo de cambio histórico, vínculos opcionales a ruta/pedido/factura pagada, exclusión personal, plantillas recurrentes de generación explícita y presupuestos mensuales.
- Exportaciones Excel/PDF por período y migración aditiva `0017_equal_microchip.sql`; los pagos existentes no se copian ni se convierten en un ledger paralelo.
- La barra principal ahora muestra Calcular, Pedidos, Productos, Finanzas y Ajustes. Importar conserva su módulo y estado bajo Ajustes → Datos; los parámetros y la exportación actuales permanecen intactos.
- El PDF real de Entregas/Ruta muestra claramente el NP de cada pedido. La salida sustituye los guards artificiales por detección de `CloseWatcher` y Navigation API, sin crecimiento de historial; la comprobación física Android/PWA queda pendiente.

## 2.22 — 2026-08-28

- La carga fría sincroniza React con la sección persistida en `history.state`, por lo que las cinco secciones responden al primer toque sin alterar Atrás ni la salida Android/PWA.
- Encargos con recepción registrada conservan sus líneas referenciadas al editar; precio, envío, cliente y notas se actualizan sin duplicar inventario, pagos o recepciones.
- Los importes de abono inician vacíos y el abono inicial atómico se admite también al crear un pedido normal, con un único NP y movimiento append-only incluso ante retry.
- Entregas y Rutas incluyen Encargos recibidos/programados, reprograman una única asignación activa y muestran el NP. La Ruta del día permite cambiar fecha en modo consulta sin crear ni modificar asignaciones.
- La fecha inicial del Encargo queda exclusivamente como llegada estimada/límite de espera; la entrega al cliente solo se programa tras resolver la recepción. El Historial vuelve a usar una consulta compatible con D1.
- El camino “Ya fue ingresado” valida que las existencias realmente estén disponibles; si están en cero bloquea con una explicación accionable y conserva Encargo, pagos e inventario sin cambios.
- Los recordatorios 08:00/14:00/20:00 con la app cerrada permanecen bloqueados porque Sites no ofrece un scheduler/background trigger para este proyecto; no se implementó una simulación dependiente de abrir la app.

## 2.21 — 2026-08-28

- “Pedido al proveedor” vuelve a ejecutar y persistir la transición del Encargo; los identificadores de operación generados por la UI cumplen el contrato seguro del servidor.
- La Ruta del día sincroniza los pedidos Confirmados/Preparados con las asignaciones canónicas existentes y deriva contadores, montos, envíos, abonos y saldos desde esos pedidos.
- Cerrar ruta exige decidir Entregado/No entregado por pedido. Solo Entregado registra la entrega existente; No entregado permanece pendiente y reprogramable. Los reintentos no duplican inventario, fulfillments ni pagos.
- Listas, detalle y PDF separan Subtotal, Descuento, Envío, Total, Abonado y Saldo; Envío dejó de presentarse como producto.
- Crear Encargo admite un abono inicial opcional, insertado atómicamente en el ledger append-only sin reconocer una venta.
- Cancelar la confirmación de salida rearma el mismo guard con el historial existente, sin aumentar `history.length`; Salir conserva un único retroceso normal.

## 2.20 — 2026-08-22

- La barra móvil inferior permanece en el App Shell con Calcular, Pedidos, Productos, Importar y Ajustes, respeta el área segura de Android/PWA y deja espacio al final del contenido.
- Los cinco módulos conservan su estado en memoria al cambiar de sección: Pedidos, Importar y Ajustes permanecen montados; Calcular y Productos mantienen formularios independientes, búsquedas, ediciones y scroll.
- Atrás usa historial SPA real entre módulos y cierra primero escáneres, diálogos, paneles y subpantallas. Solo en el límite de salida conserva la confirmación de NutriPlus, sin crear un ciclo de historial.
- Se retiró únicamente el launcher flotante de Notificaciones que se superponía al escáner. El Centro, sus preferencias, Service Worker, subscriptions y entrega Web Push permanecen intactos.

## 2.19 — 2026-08-22

- Al usar Atrás en el límite real de salida, NutriPlus pregunta “¿Quieres salir de NutriPlus?” con las acciones Cancelar y Salir.
- Cancelar conserva la pantalla y todo su estado. Salir delega al comportamiento normal de Atrás del navegador o PWA.
- La protección utiliza una sola entrada de límite, no se muestra en navegaciones internas y no crea un ciclo creciente de historial.

## 2.18 — 2026-08-22

- Se corrigió el transporte Web Push en el runtime de Sites: el request completo hacia FCM conserva el cuerpo `Uint8Array`, VAPID y `aes128gcm`, pero usa redirección manual. Así evita el `TypeError` que producía `redirect: "error"` sin seguir ni reenviar credenciales a redirecciones.
- La matriz productiva controlada aisló el defecto sin crear alertas, pedidos, movimientos de inventario ni suscripciones: A/B respondieron HTTP 400, C/D/E HTTP 401, F y el request completo con redirección manual HTTP 201; el request idéntico con redirección de error fue el único que falló antes de respuesta HTTP.
- La aceptación por el servicio push y el delivery se verifican técnicamente; la recepción física en Android y `notificationclick` requieren confirmación del usuario.

## 2.17 — 2026-08-21

- Centro centralizado de notificaciones con alertas de Inventario, Pedidos y Encargos, preferencias, deduplicación persistente y base Web Push/PWA.
- La migración aditiva `0016_round_scarlet_witch.sql` conserva el esquema existente y agrega eventos, alertas, preferencias, suscripciones y deliveries.
- Web Push requiere VAPID server-side; no existe scheduler autónomo en Sites y la validación física de Android con la aplicación cerrada queda pendiente del usuario.

## 2.16 — 2026-08-20

- Se incorporó Pedidos con números NP, borradores, confirmación transaccional, preparación, entrega total/parcial, reprogramación, cancelación, reapertura/corrección por delta, devoluciones e historial paginado.
- El método esperado `Efectivo/SINPE/Tarjeta/Otro` queda separado del ledger real `order_payments`; se admiten cero, uno o varios abonos y métodos mixtos sin fabricar ni sobrescribir pagos.
- La confirmación descuenta inventario exactamente una vez, una corrección aplica solo la diferencia, la cancelación restaura el compromiso vigente y una devolución solo reingresa las unidades marcadas como aptas. Versión optimista, `operationId` y guards D1 protegen reintentos y carreras por la última unidad.
- Entregas incorpora vistas diarias, búsqueda/escáner, orden persistente de ruta, resumen/cierre con advertencia de pendientes y hoja PDF multipágina con total, envío, E/S/T y productos pendientes para cargar.
- Encargos mantiene estado de proveedor separado, fechas históricas, pagos, recepción parcial y dos resoluciones explícitas: ingreso trazable `SPECIAL_ORDER_RECEIPT` o vínculo con stock ya registrado. Marcar recibido por sí solo nunca incrementa inventario.
- La migración aditiva `0015_quiet_anthem.sql` agrega el dominio normalizado sin destruir las 17 tablas heredadas. Se probó desde el esquema completo v2.15 y conserva filas/definiciones históricas; Facturas e Inventario continúan usando el mismo ledger de movimientos.
- La puerta final pasó instalación limpia, ESLint, TypeScript, 36 pruebas unitarias, Fases 1–4 de Pedidos, migraciones, concurrencia, Facturas, Inventario, CHATGPT_IMPORT, Excel/SheetJS, exportaciones Excel/PDF, build y validador Sites. CHATGPT_IMPORT mantuvo cero llamadas/costo y no se usó OpenAI pagado.
- `npm audit --omit=dev` mantiene 0 críticos, 0 altos y los 2 moderados ya conocidos de ExcelJS/uuid. El Site debe continuar restringido owner/admin-only; las APIs de Pedidos requieren autorización por rol antes de abrir acceso multiusuario. El backup integral D1+R2 sigue formalmente bloqueado por las capacidades actuales de Sites.

## 2.15 — 2026-08-20

- SheetJS CE pasó de la versión vulnerable 0.18.5 a la versión oficial 0.20.3, fijada como tarball local inmutable desde el CDN oficial. Se registraron fuente, SHA-256, integridad npm, licencia Apache 2.0 y atribución en `THIRD_PARTY_NOTICES.md`.
- Los avisos `GHSA-4r6h-8v6p-xvw6` (prototype pollution) y `GHSA-5pgg-2g8v-p4x9` (ReDoS) desaparecieron de `npm audit`; producción quedó con los dos nodos moderados ya conocidos de ExcelJS/uuid.
- Importar Excel conserva `.xlsx`, `.xlsm`, `.xls` y `.csv`, las hojas `Compu` y `Solo Compu`, selección explícita para libros ambiguos, mapeo, filas incompletas, deduplicación que conserva la última aparición, jobs, respaldos y confirmación antes de escribir datos.
- Antes de parsear se validan tamaño, extensión, MIME, firma real y estructura OOXML; se bloquean ZIP dañados, traversal, rutas absolutas, symlinks, ejecutables, cifrado, exceso de entradas, tamaño descomprimido y compresión anómala. El parseo continúa dentro del Web Worker con límites de hojas, filas, columnas y 15 segundos.
- Fórmulas y macros no se ejecutan; se preservan códigos de texto, ceros iniciales, caracteres españoles y códigos alfanuméricos. Los números de más de 15 dígitos requieren una revisión explícita porque Excel puede haber perdido precisión.
- Se añadieron fixtures sintéticos y pruebas de formatos, límites, archivos dañados, Worker productivo y cerca de 5.000 productos. También pasaron las integraciones existentes y la reapertura de la exportación ExcelJS 4.4.0 con tres hojas, encabezados, textos, monedas, fechas, filtros y formato condicional.
- No se modificaron ExcelJS, uuid, D1, R2, bindings, migraciones, infraestructura, autenticación, Facturas, Inventario, Pedidos, CRM, Ventas/Gastos, Poket ni OpenAI. `CHATGPT_IMPORT` mantiene cero llamadas y costo cero; el backup integral D1 + R2 continúa bloqueado por Sites.

## 2.14 — 2026-08-20

- Se corrigió exclusivamente `brace-expansion` mediante la resolución normal y dirigida del lockfile: la rama 1.x pasó de 1.1.14 a 1.1.18, la rama de desarrollo 5.x pasó de 5.0.6 a 5.0.9 y la rama 2.x se mantuvo en 2.1.4.
- No se añadieron dependencias ni `overrides`, y permanecieron sin cambios ExcelJS 4.4.0, xlsx 0.18.5, uuid 8.3.2, minimatch y glob.
- Los tres avisos de `brace-expansion` desaparecieron. La auditoría de producción pasó de 12 nodos afectados (11 altos y 1 moderado) a 3 (1 alto y 2 moderados); la auditoría completa pasó de 57 a 47 nodos por la eliminación y reclasificación de cadenas propagadas por npm.
- Pasaron instalación limpia, lint, TypeScript, suite completa, build, artefacto Sites, regresión de exportación Excel y smoke test no destructivo de Calculadora, Productos, Inventario, No inventario, Facturas, Historial, Importar Excel y Exportar Excel.
- No se modificaron SheetJS, ExcelJS, uuid, código funcional, APIs, D1, R2, bindings, migraciones, infraestructura, autenticación ni OpenAI. El backup integral D1 + R2 continúa bloqueado por las capacidades actuales de Sites.

## 2.13 — 2026-08-20

- Se actualizó únicamente el lote framework/runtime: Next y `eslint-config-next` pasaron de 16.2.6 a 16.3.1, sin cambiar Vinext, React ni React DOM.
- La cadena de producción quedó en PostCSS 8.5.23, Nanoid 3.3.18 y Sharp 0.35.3, eliminando del audit los avisos asociados a Next y esas transitivas.
- `npm audit --omit=dev` bajó de 16 hallazgos (15 altos, 1 moderado) a 4 (2 altos, 2 moderados). Los restantes pertenecen a SheetJS/xlsx y ExcelJS y quedan expresamente reservados para otro lote.
- Pasaron instalación limpia, lint, TypeScript, suite completa, build verificado, navegación visual y la regresión del ZIP real `CHATGPT_IMPORT` con cero llamadas y costo cero de OpenAI.
- No se modificaron funciones de negocio, APIs, D1, R2, bindings, infraestructura, autenticación ni datos. El backup integral D1 + R2 continúa documentado como bloqueado por las capacidades actuales de Sites.

## 2.12 — 2026-08-19

- La X de Facturas ahora cierra únicamente la factura activa y limpia su estado de interfaz; no borra el borrador, no revierte inventario y solo advierte cuando existen ediciones locales sin guardar.
- “Cambiar paquete” se normalizó como “Cambiar factura”. Cargar otra factura no elimina la anterior.
- Las líneas originales ya no se eliminan: pueden marcarse como Omitidas y reactivarse, conservando cantidad, identificadores y trazabilidad. Solo las líneas manuales sin movimientos mantienen eliminación explícita.
- La disponibilidad se calcula por cantidad neta: suma de ingresos menos reversas. Una reversa vuelve a habilitar únicamente el saldo disponible y permite `ingreso → reversa → reingreso` sin borrar movimientos.
- La migración `0014` elimina el índice único por línea de v2.11 y recalcula estados existentes. Antes de cualquier mutación, `ensureDatabase()` instala con sentencias preparadas de D1 los límites transaccionales de capacidad y saldo no negativo, manteniendo idempotencia por operación y protección frente a confirmaciones concurrentes.
- El estado de la factura se recalcula como borrador, revisión, parcial o procesada según cantidades activas, pendientes y omitidas, incluso para datos creados antes de esta versión.
- El historial principal ahora se agrupa factura por factura y muestra todas las líneas originales, cantidades de factura/activas/disponibles, omisiones, reversas y movimientos auditables.
- Las pruebas cubren cierre no destructivo, texto visible, omitir/reactivar, bloqueo de eliminación original, reingreso después de reversa, carrera concurrente, historial agrupado y recuperación `CHATGPT_IMPORT` con cero llamadas y costo cero.

## 2.11 — 2026-08-19

- La reimportación del mismo paquete `CHATGPT_IMPORT` recupera ahora el borrador existente en estado inicial, parcial o completado, sin crear otra factura ni llamar a OpenAI.
- Las líneas ya ingresadas permanecen visibles y bloqueadas; las pendientes pueden continuarse desde la revisión existente.
- Se reforzó la idempotencia por línea de factura mediante un índice único para movimientos de ingreso, sin afectar movimientos rápidos ni reversas.
- La recuperación puede restaurar la fila visual de una línea procesada a partir de su movimiento histórico cuando esa relación faltaba, sin alterar cantidades de inventario.
- Los errores de ZIP, estructura, JSON, esquema, versión, hash, totales, cantidades, códigos y persistencia muestran mensajes específicos, accionables y sin detalles sensibles.
- Se añadieron códigos internos estables, títulos en notificaciones y la regla permanente de mensajes de error y recuperación en `AGENTS.md`.
- Las pruebas cubren el ciclo de dos líneas `DRAFT → PARTIAL → COMPLETED`, reintentos, historial, archivos inválidos, cero movimientos duplicados, `api_calls = 0` y `api_cost = 0`.

## 2.10 — 2026-08-19

- Se auditó la arquitectura real, el modelo de datos, los ambientes, las pruebas, el deployment, los respaldos, la seguridad y las dependencias.
- Se reemplazó el README genérico por documentación específica de NutriPlus y se creó el manual permanente `AGENTS.md`.
- Se documentaron controles existentes, riesgos y prioridades futuras sin implementar cambios funcionales.
- Se confirmó en el código la existencia de Automático con IA, Manual e Importar análisis de ChatGPT.
- No se modificaron APIs, lógica de Facturas/Inventario/Productos, autenticación, OpenAI, esquema ni migraciones.

## 2.9 — 2026-08-19

- Se separó la versión pública de los checkpoints técnicos de Sites.
- Se normalizó el historial iniciado en `2.0`, `2.0.1` y `2.0.2` como `2.0`, `2.1` y `2.2`.
- Se añadió la versión pública visible y metadata verificable.
- No hubo cambios funcionales en Facturas, Inventario, Productos, Pedidos, CRM, pagos, autenticación, OpenAI ni base de datos.

## Correspondencia histórica comprobada

Un checkpoint guardado no prueba por sí solo que ese estado haya sido desplegado. La tabla conserva el identificador técnico sin presentarlo como versión pública.

| Checkpoint | Commit | Fecha | Identificación anterior | Cambio principal | Versión pública normalizada |
|---:|---|---|---|---|---:|
| 1 | `6ca0935` | 2026-08-07 | `0.1.0`, prueba privada | Preparación de prueba privada | Sin versión pública |
| 2 | `3bc2bc9` | 2026-08-07 | `1.0.0` | Primera versión de la calculadora | 1.0 |
| 3 | `3059683` | 2026-08-07 | `1.1.0` | Búsqueda rápida, teclado y gestión de productos | 1.1 |
| 4 | `2a56ad4` | 2026-08-07 | `1.2.0` | Teclado, escaneo, guardado y códigos | 1.2 |
| 5 | `efb7bcf` | 2026-08-08 | `1.3.0` | Inventario y exportaciones | 1.3 |
| 6 | `ec4c09b` | 2026-08-08 | `1.4.0` | Importaciones resilientes, alertas y escaneo seguro | 1.4 |
| 7 | `f21d40b` | 2026-08-09 | `1.5.0` | Catálogo, abastecimiento, códigos y procesos en segundo plano | 1.5 |
| 8 | `160cee5` | 2026-08-09 | `1.6.0` | Inventario seguro, uso sin conexión y exportaciones | 1.6 |
| 9 | `f8ef9a6` | 2026-08-11 | `1.7.0` | Códigos, No inventario y ajustes | 1.7 |
| 10 | `3cbf23d` | 2026-08-11 | `1.8.0` | Traslado de cotizaciones y recientes instantáneos | 1.8 |
| 11 | `949a78b` | 2026-08-11 | `1.8.0`, parche intermedio | Validaciones del traslado a inventario | Sin versión pública independiente |
| 12 | `83cc932` | 2026-08-11 | `1.9.0` | Concurrencia, operaciones masivas y auditoría | 1.9 |
| 13 | `b11198b` | 2026-08-11 | `2.0.0` / 2.0 | Ingreso por facturas e historial reversible | 2.0 |
| 14 | `92c87a9` | 2026-08-11 | `2.0.1` | Códigos por línea y validación transaccional | 2.1 |
| 15 | `53dfda8` | 2026-08-11 | `2.0.2` | Carga de facturas PDF y avisos de error | 2.2 |
| 16 | `44c596d` | 2026-08-12 | Seguía declarando `2.0.2` | Facturas con IA y modo Manual | 2.3 |
| 17 | `af6ed08` | 2026-08-12 | Seguía declarando `2.0.2` | Compatibilidad de migraciones D1 | 2.4 |
| 18 | `fff7f3f` | 2026-08-12 | Seguía declarando `2.0.2` | Estimaciones de consumo de OpenAI | 2.5 |
| 19 | `e2bf73c` | 2026-08-17 | Seguía declarando `2.0.2` | Recuperación de archivos en cargas duplicadas | 2.6 |
| 20 | `ec30d7a` | 2026-08-17 | Seguía declarando `2.0.2` | Terra por servidor, revisión segura e historial | 2.7 |
| 21 | `9045024` | 2026-08-19 | Seguía declarando `2.0.2` | Importación segura de análisis de ChatGPT | 2.8 |
| 22 | `2d91cc9` | 2026-08-19 | Primera versión visible normalizada | Separación de versión pública y checkpoint | 2.9 |

La evidencia disponible permite afirmar que el checkpoint 20 tuvo un deployment exitoso y que el 21 era la versión desplegada inmediatamente antes de esta normalización. Sites expone el historial completo de checkpoints guardados, pero no un listado histórico equivalente de todos los deployments; por eso no se atribuye un despliegue independiente a los demás checkpoints cuando no puede probarse. Los checkpoints 1 y 11 están identificados expresamente como prueba privada y parche intermedio, respectivamente, y no como publicaciones públicas independientes.

La publicación actual de este documento corresponde a NutriPlus **v2.23**. Su checkpoint y commit técnicos quedan registrados por Sites y Git al guardar la publicación; no se incrustan en el propio commit porque un commit no puede contener su propio hash.

## Regla futura

La próxima implementación publicada después de `2.23` será `2.24`, y así sucesivamente. No se usarán números de checkpoint o deployment como versiones públicas.
