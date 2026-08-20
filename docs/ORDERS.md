# Pedidos — Fase 1

## Estado y alcance

Esta fase implementa únicamente la base técnica local de Pedidos: modelo D1, migración, reglas de dominio, inventario transaccional, pagos, devoluciones, rutas, API y pruebas. Está en la rama `feature/orders-phase-1`, creada desde el `main` productivo de NutriPlus v2.15. No incluye interfaz, impresión, CRM, WhatsApp, Poket, Ventas/Gastos ni Encargos completos.

La migración `0015_quiet_anthem.sql` no se ha aplicado a producción. No hubo merge a `main`, push, checkpoint, deploy, cambio de versión ni escritura en D1/R2 productivos.

## Entidades

| Área | Tablas | Decisión |
|---|---|---|
| Identidad | `order_number_allocations`, `orders` | ID técnico con Web Crypto y número operativo NP mediante secuencia autoincremental. |
| Detalle | `order_lines` | Producto opcional y snapshots inmutables de nombre, presentación, código, precio y costo. |
| Control | `order_operations`, `order_status_events`, `order_events` | Idempotencia, versión optimista e historial append-only. |
| Dinero | `order_payments` | Ledger de pagos/reversiones; saldo y estado derivados. |
| Entrega | `delivery_routes`, `route_orders`, `order_fulfillments`, `order_fulfillment_lines` | Ruta estable y entrega separada del pedido. |
| Correcciones | `order_returns`, `order_return_lines` | Devolución auditable con reingreso de stock explícito. |
| Integraciones | `order_external_references` | IDs externos desacoplados, sin conectar servicios en esta fase. |

`customer_id` es nullable. El pedido conserva nombre, teléfono y dirección como snapshots aunque en el futuro se vincule a un CRM. `product_id` también es nullable: una línea manual queda en el historial, pero nunca mueve inventario.

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

El pedido, la entrega y una venta futura son entidades diferentes. `order_fulfillments` agrupa cada entrega y `order_fulfillment_lines` registra la cantidad de cada línea. Esto permite entregar una parte y mantener el resto pendiente o reprogramado sin borrar líneas. La Fase 1 implementa el cierre completo actual, pero el esquema ya admite múltiples entregas parciales.

Una ruta tiene fecha operativa, etiqueta y estado. `route_orders` conserva una posición positiva y única por ruta; cada pedido admite como máximo una asignación activa. Los totales futuros de cierre se derivarán de pedidos, pagos y entregas, sin duplicarlos.

## API local

| Método y ruta | Función |
|---|---|
| `GET/POST /api/orders` | Listar con filtros/paginación o crear borrador. |
| `GET/PATCH/DELETE /api/orders/:id` | Consultar, editar o eliminar únicamente un borrador. |
| `POST /api/orders/:id/confirm` | Confirmar y descontar inventario. |
| `POST /api/orders/:id/prepare` | Marcar preparado. |
| `POST /api/orders/:id/deliver` | Registrar entrega sin nuevo descuento. |
| `POST /api/orders/:id/cancel` | Cancelar y restaurar cuando corresponde. |
| `POST /api/orders/:id/reprogram` | Cambiar fecha sin cancelar ni mover stock. |
| `POST /api/orders/:id/reopen` | Reabrir una entrega con motivo. |
| `GET/POST /api/orders/:id/payments` | Consultar o registrar ledger de pagos. |
| `POST /api/orders/:id/returns` | Registrar devolución y reingreso opcional. |
| `GET /api/orders/:id/history` | Obtener eventos, estados, pagos, devoluciones y entregas. |
| `GET/POST /api/delivery-routes` | Listar o crear rutas. |
| `POST /api/delivery-routes/:id/orders` | Asignar posición estable. |

El listado admite fecha, rango, estado, estado de pago derivado, teléfono normalizado, número, producto, tipo y paginación limitada.

## Dinero y tiempo

Todos los importes de esta fase son enteros CRC: ₡12.500 se guarda como `12500`. No se usan floats. Las fechas de entrega y ruta se validan como `YYYY-MM-DD` y se conservan como fecha civil de `America/Costa_Rica`, evitando desplazamientos por UTC. Los timestamps técnicos siguen la convención UTC existente.

## Seguridad y límites pendientes

La rama local `security/phase-3b1` permanece intacta y no se mezcló. Mientras esta fase no se publique, las APIs nuevas solo existen localmente. Si se retoman y publican, deberán recibir policies específicas de autorización antes de abrir el Site a empleados o clientes; no se creó una identidad alternativa ni se inventaron actores.

No se envían eventos a CRM, WhatsApp, Poket ni otro servicio. No hay llamadas a OpenAI. La exportación futura de Pedidos no sustituirá un backup; el backup integral D1+R2 continúa **BLOQUEADO** por las limitaciones actuales de Sites.

## Pruebas

- `tests/orders-migration-0015.integration.mjs` valida la migración aditiva desde el esquema anterior y la conservación del inventario.
- `tests/orders-phase-1.integration.mjs` valida estados, stock, deltas, rollback, idempotencia, concurrencia, pagos, devoluciones, rutas, snapshots, NP y fechas.
- `npm test` incorpora ambas pruebas junto con toda la regresión existente.
