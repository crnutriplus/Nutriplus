# Pedidos — base técnica e interfaz operativa

## Estado y alcance

La implementación local de Pedidos incluye modelo D1, migración, reglas de dominio, inventario transaccional, pagos, devoluciones, entregas parciales, rutas, impresión, API, interfaz operativa e historial. Antes de iniciar la interfaz se amplió de forma aditiva la misma migración `0015`, todavía inédita, para persistir el método esperado de pago y el flujo seguro de Encargos. Está en la rama `feature/orders-phase-1`, creada desde el `main` productivo de NutriPlus v2.15.

La migración `0015_quiet_anthem.sql` se desarrolló sin aplicarla anticipadamente a producción y se publica únicamente mediante el flujo normal de Sites para v2.16, después de la regresión completa. No existe una migración correctiva adicional: toda la ampliación inédita quedó en `0015` de forma aditiva.

## Entidades

| Área | Tablas | Decisión |
|---|---|---|
| Identidad | `order_number_allocations`, `orders` | ID técnico con Web Crypto y número operativo NP mediante secuencia autoincremental. |
| Detalle | `order_lines` | Producto opcional y snapshots inmutables de nombre, presentación, código, precio y costo. |
| Control | `order_operations`, `order_status_events`, `order_events` | Idempotencia, versión optimista e historial append-only. |
| Dinero | `order_payments` | Ledger de pagos/reversiones; saldo y estado derivados. |
| Entrega | `delivery_routes`, `route_orders`, `order_fulfillments`, `order_fulfillment_lines` | Ruta estable y entrega separada del pedido. |
| Correcciones | `order_returns`, `order_return_lines` | Devolución auditable con reingreso de stock explícito. |
| Encargos | `special_order_details`, `special_order_receipts`, `special_order_receipt_lines` | Estado de proveedor separado, recepción normalizada y decisión trazable sobre el ingreso de inventario. |
| Integraciones | `order_external_references` | IDs externos desacoplados, sin conectar servicios en esta fase. |

`customer_id` es nullable. El pedido conserva nombre, teléfono y dirección como snapshots aunque en el futuro se vincule a un CRM. `product_id` también es nullable: una línea manual queda en el historial, pero nunca mueve inventario.

`orders.expected_payment_method` es nullable y admite `CASH`, `SINPE`, `CARD` u `OTHER`. Es una expectativa operativa editable mientras el pedido admite edición normal. No representa dinero recibido, no crea filas en `order_payments` y nunca sustituye el ledger financiero real.

## Encargos y recepción

`orders.status` mantiene el flujo logístico general. `special_order_details.special_order_status` mantiene, de forma separada, el flujo de adquisición:

`REQUESTED → ORDERED_FROM_SUPPLIER → IN_TRANSIT → RECEIVED_PENDING_RESOLUTION → PARTIALLY_RECEIVED/RECEIVED_READY → ADDED_TO_ROUTE → DELIVERED`.

La cancelación usa `CANCELLED` y solo se permite desde estados todavía abiertos. Las transiciones se validan en el servicio y mediante trigger D1. Marcar recibido solo establece `RECEIVED_PENDING_RESOLUTION`: no incrementa existencias.

Cada resolución crea una cabecera y líneas append-only. `INVENTORY_NOW` vincula la línea a un producto existente y crea movimientos `SPECIAL_ORDER_RECEIPT`; `ALREADY_INVENTORY` vincula sin crear entrada porque la unidad ya fue registrada por Facturas/Inventario. Ambas opciones requieren producto válido e `operationId`. La suma por línea permite recepciones parciales sin afirmar que llegó la cantidad completa.

Un Encargo solo puede confirmarse cuando la recepción completa está resuelta, todas las líneas están vinculadas y el stock real vuelve a pasar la comprobación concurrente. Confirmar usa el movimiento normal `ORDER_CONFIRM`; cancelar antes de confirmar no restaura stock y cancelar después de confirmar restaura exactamente lo reservado.

## Estados

| Desde | Hacia | Inventario | Regla |
|---|---|---:|---|
| `DRAFT` | `CONFIRMED` | Descuenta | Recalcula totales y valida todo el stock antes del batch. |
| `DRAFT` | `CANCELLED` | Sin cambio | Exige motivo. |
| `CONFIRMED` | `PREPARED` | Sin cambio | Guarda `prepared_at`. |
| `CONFIRMED` / `PREPARED` | `CANCELLED` | Restaura | Devuelve exactamente el compromiso activo. |
| `PREPARED` | `DELIVERED` | Sin cambio | Registra la entrega de cantidades pendientes. |
| `DELIVERED` | `REOPENED` | Sin cambio | Exige motivo y habilita corrección explícita. |
| `REOPENED` | `CONFIRMED` | Sin movimiento adicional | Cierra la corrección; las ediciones realizadas en `REOPENED` ya aplicaron sus deltas. |

No se permiten saltos arbitrarios. Un pedido entregado no admite edición normal y un pedido confirmado o posterior no se elimina físicamente. Un borrador sin movimientos puede eliminarse mediante una operación idempotente.

## Inventario y transacciones

Pedidos reutiliza `inventory_movements`; no existe un segundo saldo. Cada movimiento de pedido registra `order_id`, `order_line_id`, `operation_id` y `movement_type` (`ORDER_CONFIRM`, cambios por delta, cancelación, corrección o devolución).

La confirmación reúne validación de versión/estado, recálculo, comprobación completa de existencias, movimientos, actualización de productos, evento y respuesta idempotente en un batch D1. Un trigger instalado por `ensureDatabase()` como sentencia D1 individual valida referencias, cantidad previa, delta, cantidad resultante y saldo no negativo. Esto evita cuerpos de trigger incompatibles con el ejecutor de migraciones de Sites. Si falta una unidad en cualquier línea, todo el batch falla y el pedido sigue como borrador.

Al editar un pedido comprometido se mueve solo la diferencia: aumentar una cantidad descuenta el incremento; reducirla o retirar una línea restaura el saldo correspondiente. Preparar, entregar o reprogramar no modifica stock.

## Idempotencia y concurrencia

Las mutaciones sensibles requieren `operationId`. `order_operations` conserva tipo, hash de la solicitud, estado y respuesta. Un reintento idéntico devuelve el resultado original; reutilizar el ID con otro contenido se rechaza.

Cada pedido tiene `version`. El cliente debe enviar la versión observada y el batch incluye un guard de concurrencia. Una versión obsoleta produce conflicto sin cambios. La restricción de inventario impide que dos pedidos concurrentes consuman la misma última unidad.

El número NP se asigna insertando una fila en `order_number_allocations` y formateando su secuencia dentro del mismo flujo de creación. No se usa `MAX()+1` ni una dependencia UUID adicional.

## Pagos y devoluciones

Los pagos son movimientos append-only con monto, moneda, método, referencia, tipo y `operationId`. Se admiten `CASH`, `SINPE`, `CARD` y `OTHER`, incluso combinados. `PENDING`, `PARTIAL` y `PAID` se calculan desde el total del pedido y la suma neta de movimientos válidos; el campo guardado es solo una proyección operativa.

Una reversa conserva el pago original, referencia el movimiento corregido y exige motivo. Una devolución conserva cabecera y líneas propias. Solo `reenter_inventory=true` crea el movimiento positivo correspondiente; un artículo dañado o abierto puede registrarse sin aumentar stock.

## Entregas parciales y rutas

El pedido, la entrega y una venta futura son entidades diferentes. `order_fulfillments` agrupa cada entrega y `order_fulfillment_lines` registra la cantidad de cada línea. La API permite entregar una parte, conserva el pedido en `PREPARED` y mantiene el resto pendiente en la misma fecha o lo reprograma sin borrar líneas. Solo la entrega de todas las cantidades pendientes cambia el pedido a `DELIVERED`.

Una ruta tiene fecha operativa, etiqueta y estado. `route_orders` conserva una posición positiva y única por ruta; cada pedido admite como máximo una asignación activa. Su detalle deriva en tiempo real conteos, total bruto, envío y cobros netos por método. El cierre advierte pedidos pendientes y requiere confirmación explícita para cerrarlos sin esconderlos.

La hoja PDF usa el orden persistido de ruta, repite encabezados al cambiar de página y muestra `FECHA`, `TOTAL`, `ENVIO`, teléfono, dirección, productos y el monto pendiente de cobro. La columna `E/S/T` se deriva únicamente de `expected_payment_method`. Al final consolida unidades de inventario por cargar e identifica aparte las líneas manuales; no expone el nombre del cliente ni el número NP.

## API local

| Método y ruta | Función |
|---|---|
| `GET/POST /api/orders` | Listar con filtros/paginación o crear borrador. |
| `GET/PATCH/DELETE /api/orders/:id` | Consultar, editar o eliminar únicamente un borrador. |
| `POST /api/orders/:id/confirm` | Confirmar y descontar inventario. |
| `POST /api/orders/:id/prepare` | Marcar preparado. |
| `POST /api/orders/:id/deliver` | Registrar entrega sin nuevo descuento. |
| `POST /api/orders/:id/fulfillments` | Registrar una entrega parcial o completa y reprogramar únicamente el saldo pendiente. |
| `POST /api/orders/:id/cancel` | Cancelar y restaurar cuando corresponde. |
| `POST /api/orders/:id/reprogram` | Cambiar fecha sin cancelar ni mover stock. |
| `POST /api/orders/:id/reopen` | Reabrir una entrega con motivo. |
| `GET/POST /api/orders/:id/payments` | Consultar o registrar ledger de pagos. |
| `POST /api/orders/:id/returns` | Registrar devolución y reingreso opcional. |
| `GET /api/orders/:id/history` | Obtener eventos, estados, pagos, devoluciones y entregas. |
| `POST /api/orders/:id/special-order/transition` | Avanzar el estado de proveedor sin mover inventario. |
| `POST /api/orders/:id/special-order/receipts` | Resolver total o parcialmente una recepción mediante uno de los dos caminos autorizados. |
| `GET /api/orders/print` | Generar la hoja PDF diaria o su modelo JSON verificable. |
| `GET/POST /api/delivery-routes` | Listar o crear rutas. |
| `GET /api/delivery-routes/:id` | Consultar asignaciones y resumen derivado. |
| `POST /api/delivery-routes/:id/close` | Cerrar la ruta; exige reconocimiento explícito si quedan pendientes. |
| `POST /api/delivery-routes/:id/orders` | Asignar posición estable. |

El listado admite fecha, rango, estado, estado de pago derivado, teléfono normalizado, número, producto, tipo, búsqueda general de servidor, modo activo y paginación limitada.

## Interfaz operativa

`app/orders-view.tsx` implementa las vistas **Entregas**, **Encargos** e **Historial** dentro de la navegación principal. Entregas ofrece Hoy, Mañana, fecha libre y resumen de próximos días en `America/Costa_Rica`; las tarjetas muestran productos, unidades, total, pago real, método esperado y posición de ruta.

El editor permite buscar por nombre/código, usar el escáner existente, seleccionar Inventario o No inventario y agregar una línea manual. El precio sugerido es editable y nunca modifica el precio maestro. Guardar un borrador no mueve stock. Antes de crear, la UI consulta coincidencias por teléfono y fecha y permite abrir el pedido existente o continuar conscientemente.

La ficha del pedido ofrece revisión de stock antes de confirmar, edición por delta, checklist de preparación, entrega total o parcial, cancelación con motivo/consecuencia, reprogramación, ledger de abonos mixtos y orden de ruta persistente. La corrección reabre con motivo, expone consecuencias antes de editar y conserva el delta en inventario y el historial. Las devoluciones registran por línea si la unidad vuelve o no a existencias.

Rutas permite ordenar, imprimir, revisar totales y cerrar con advertencia de pendientes. Historial busca y pagina en servidor y filtra por fecha, tipo, estado y método. Encargos expone la máquina de proveedor, ambos caminos de recepción, cantidades reales, creación/vinculación segura desde No inventario con stock cero, pagos, incorporación posterior a una ruta y entrega normal bajo el mismo NP.

## Dinero y tiempo

Todos los importes de esta fase son enteros CRC: ₡12.500 se guarda como `12500`. No se usan floats. Las fechas de entrega y ruta se validan como `YYYY-MM-DD` y se conservan como fecha civil de `America/Costa_Rica`, evitando desplazamientos por UTC. Los timestamps técnicos siguen la convención UTC existente.

## Seguridad y límites pendientes

La rama local `security/phase-3b1` permanece intacta y no se mezcló. Mientras esta fase no se publique, las APIs nuevas solo existen localmente. Si se retoman y publican, deberán recibir policies específicas de autorización antes de abrir el Site a empleados o clientes; no se creó una identidad alternativa ni se inventaron actores.

No se envían eventos a CRM, WhatsApp, Poket ni otro servicio. No hay llamadas a OpenAI. La impresión PDF de Pedidos no sustituye un backup; el backup integral D1+R2 continúa **BLOQUEADO** por las limitaciones actuales de Sites.

## Pruebas

- `tests/orders-migration-0015.integration.mjs` valida la migración aditiva desde el esquema anterior y la conservación del inventario.
- `tests/orders-phase-1.integration.mjs` valida estados, stock, deltas, rollback, idempotencia, concurrencia, pagos, devoluciones, rutas, snapshots, NP y fechas.
- `tests/orders-special-foundation.integration.mjs` valida método esperado, máquina de Encargos, ambos caminos de recepción, recepción parcial, idempotencia y concurrencia.
- `tests/orders-phase-2.integration.mjs` valida el contrato de interfaz, resumen diario, detección de duplicados, acciones operativas, pagos, rutas, filtros, idempotencia, concurrencia y navegación responsive.
- `tests/orders-phase-3.integration.mjs` valida impresión exacta y multipágina, cierre de ruta, entregas parciales, correcciones, devoluciones, Encargos completos, saldos, historial y contrato móvil.
- `tests/orders-phase-4.e2e.mjs` valida el escenario final de stock/pagos/corrección/devolución, concurrencia por la última unidad y Encargo de punta a punta.
- `npm test` incorpora las seis pruebas de Pedidos junto con toda la regresión existente.
