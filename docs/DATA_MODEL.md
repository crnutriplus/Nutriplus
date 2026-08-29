# Modelo de datos

## Persistencia real

NutriPlus usa Cloudflare D1, compatible con SQLite. Drizzle ORM describe el esquema en `db/schema.ts`, mientras que los Route Handlers usan tanto Drizzle como sentencias preparadas de D1.

Las migraciones versionadas están en `drizzle/` y el journal registra 17 entradas, de `0000_fluffy_shinobi_shaw.sql` a `0016_round_scarlet_witch.sql`. La migración `0015` de Pedidos ya pertenece a producción v2.16. `0016` es una ampliación aditiva local para notificaciones y no se aplicó a producción.

## Entidades

### Configuración y catálogo

| Tabla | Propósito |
|---|---|
| `settings` | Tipo de cambio, tarifas, márgenes y redondeo globales. |
| `products` | Catálogo de inventario, costo/peso, existencias, mínimo y control de versión. |
| `non_inventory_quotes` | Productos cotizados que aún no pertenecen al inventario. |
| `mutation_receipts` | Recibos idempotentes de mutaciones y respuesta almacenada. |

`products.normalized_name` y `products.code` tienen índices únicos. Los precios en USD se guardan en centavos (`*_usd_cents`), el peso en milésimas de libra (`*_milli_lb`) y los valores CRC como enteros.

### Facturas y análisis

| Tabla | Propósito |
|---|---|
| `inventory_documents` | Cabecera de factura, huella, proveedor, números, modo, estado y confirmación. |
| `inventory_document_lines` | Productos extraídos/revisados, cantidades, presentación, códigos, matching y estado. |
| `inventory_document_files` | Metadata y SHA-256 de cada archivo original almacenado en R2. |
| `invoice_ai_analyses` | Cada análisis OpenAI o ChatGPT Import, modelo, uso, costo, resultado y errores. |
| `supplier_product_aliases` | Equivalencia confirmada entre ID de proveedor, código canónico y producto. |

Relaciones lógicas:

- un `inventory_document` tiene muchas líneas, archivos y análisis;
- `active_analysis_id` identifica el análisis vigente;
- una línea puede enlazar un `product` o un `non_inventory_quote` durante la revisión;
- un alias enlaza una identidad del proveedor con un producto y código confirmado.

La huella de `inventory_documents` es única. La combinación documento/número de análisis también es única, al igual que la clave de línea dentro de cada documento.

`CHATGPT_IMPORT` conserva en la extracción normalizada el costo bruto/neto por línea, descuentos explícitos o prorrateados y el desglose seguro de pagos. Al confirmar, esos datos alimentan el ledger `finance_expenses` existente con claves idempotentes por documento/medio; `expense_date` usa el día de confirmación en `America/Costa_Rica`, mientras `inventory_documents.document_date` conserva la fecha original. Las líneas personales permanecen conciliables pero se excluyen del gasto del negocio. Los créditos de tienda quedan como movimiento no monetario y no alteran caja. No se crea una tabla ni una fuente financiera paralela.

### Movimientos y auditoría de inventario

| Tabla | Propósito |
|---|---|
| `inventory_operations` | Ingreso, ajuste rápido o reversa, con estado, responsable y totales. |
| `inventory_movements` | Cambio por producto, cantidad previa, delta y cantidad resultante. |

Una confirmación genera una operación y uno o más movimientos. Una reversa conserva el ingreso original y crea otra operación con movimientos contrarios, enlazada mediante `reversal_of`/`original_movement_id`.

La disponibilidad de una línea no depende del booleano histórico `processed_operation_id`. Se calcula así:

```text
cantidad_activa = suma(quantity_change) de movimientos completados de la línea
cantidad_disponible = max(0, total_to_add - cantidad_activa)
```

La migración `0014` elimina el índice `inventory_movements_invoice_line_unique`, que impedía un reingreso legítimo después de una reversa, y recalcula los estados de documentos existentes. Como el ejecutor SQL de Sites no admite cuerpos de trigger dentro del archivo de migración, `ensureDatabase()` instala ambos triggers como sentencias preparadas individuales antes de atender cualquier mutación: bloquean transaccionalmente una suma activa mayor que `total_to_add` o menor que cero. El índice `(operation_id, document_line_id)` continúa garantizando una sola mutación de esa línea dentro del mismo `operationId`.

### Pedidos

| Tabla | Propósito |
|---|---|
| `order_number_allocations` | Secuencia transaccional para números `NP-######`. |
| `orders` | Cabecera, snapshots de cliente/dirección, estado, fecha, importes, método esperado nullable y versión optimista. |
| `order_lines` | Líneas activas/históricas, vínculo opcional a producto y snapshots comerciales/de costo. |
| `order_operations` | Recibos idempotentes con hash de solicitud y respuesta repetible. |
| `order_status_events` | Transiciones append-only con motivo, operación y actor nullable. |
| `order_events` | Eventos internos append-only para historial e integraciones futuras. |
| `order_payments` | Ledger de pagos y reversas; el estado de pago se deriva. |
| `order_external_references` | Referencias desacopladas a proveedores externos futuros. |
| `delivery_routes` / `route_orders` | Rutas por fecha y posición estable de cada pedido. |
| `order_returns` / `order_return_lines` | Devoluciones y decisión explícita de reingreso a inventario. |
| `order_fulfillments` / `order_fulfillment_lines` | Entregas separadas del pedido y preparadas para cantidades parciales. |
| `special_order_details` | Relación 1:1 para estado de proveedor, solicitud, pedido, estimación, recepción y resolución del Encargo. |
| `special_order_receipts` / `special_order_receipt_lines` | Recepciones append-only, camino elegido, producto vinculado, cantidad real y si creó movimiento de entrada. |

`inventory_movements` recibe tres columnas opcionales: `order_id`, `order_line_id` y `movement_type`. Las filas históricas y de Facturas permanecen válidas con valores nulos. Solo los movimientos con línea de pedido activan la validación de producto, cantidades previa/resultante y saldo no negativo, y actualizan el producto dentro del mismo batch D1. Igual que los guards de `0014`, `ensureDatabase()` instala los triggers de Pedidos como sentencias D1 individuales porque el ejecutor de migraciones de Sites no acepta cuerpos con terminadores internos.

Los importes de Pedidos se almacenan como enteros CRC. Las fechas operativas de entrega y ruta son texto `YYYY-MM-DD` interpretado en `America/Costa_Rica`; los timestamps técnicos conservan la convención UTC del proyecto.

`expected_payment_method` solo comunica la expectativa operativa (`CASH`, `SINPE`, `CARD`, `OTHER` o `NULL`). Los pagos reales permanecen exclusivamente en `order_payments`, por lo que editar la expectativa no fabrica ni altera movimientos financieros.

Los Encargos usan dos máquinas separadas: `orders.status` para logística y `special_order_status` para proveedor/recepción. Marcar recibido no suma stock. Una resolución `INVENTORY_NOW` crea `SPECIAL_ORDER_RECEIPT`; `ALREADY_INVENTORY` registra explícitamente que la entrada ocurrió por Facturas/Inventario y no crea un segundo movimiento. La suma normalizada de `quantity_received` deja preparado el modelo para recepciones parciales.

Cada fila de `order_fulfillments` representa una operación de entrega y sus líneas conservan cantidades positivas por línea original. Las cantidades pendientes se derivan del pedido menos la suma de fulfillments; no se sobrescribe el detalle comprado. Los resúmenes y la impresión de rutas también se derivan de pedidos, pagos netos, fulfillments y posiciones activas, sin tablas duplicadas de cierre.

### Notificaciones

| Tabla | Propósito |
|---|---|
| `notification_events` | Hechos durables, payload mínimo, estado de procesamiento, operación de origen opcional y clave única de deduplicación. |
| `notifications` | Centro de alertas: presentación, severidad, entidad/ruta, lectura, descarte y estado agregado de entrega. |
| `notification_preferences` | Preferencias owner/admin actuales con `principal_id` nullable para evolución multiusuario. |
| `push_subscriptions` | Endpoint y claves públicas de Web Push por dispositivo, última actividad y desactivación. |
| `notification_deliveries` | Intentos por alerta/subscription, respuesta, error, reintentos y fecha de entrega. |
| `notification_resource_states` | Estado/ciclo por entidad para deduplicación y rearmado de umbrales. |

Las transiciones de `products.quantity_available` se clasifican como `NORMAL`, `LOW_STOCK` u `OUT_OF_STOCK`. Solo los cruces crean eventos; bajar repetidamente dentro del mismo estado no genera spam. Salir de agotado registra `inventory.back_in_stock` y permite un cruce futuro válido. Evento, notificación y destino de entrega tienen índices únicos independientes.

`notification_events` es la frontera durable. Web Push es un efecto posterior: no forma parte de la autoridad de inventario/pedidos y su fallo no revierte la mutación. Los resúmenes temporales usan fechas `YYYY-MM-DD` de `America/Costa_Rica`; Sites no aporta un scheduler, de modo que se generan por reconciliación al abrir/actualizar la app.

### Importaciones, respaldos y eliminaciones

| Tabla | Propósito |
|---|---|
| `import_jobs` | Estado y contadores de importaciones Excel o snapshots. |
| `import_job_rows` | Filas normalizadas, claims, resultado y mensaje por fila. |
| `import_backups` | Cabecera de un snapshot de productos asociado a un job. |
| `import_backup_products` | Copia de cada producto incluida en el snapshot. |
| `product_deletion_jobs` | Estado y contadores de una eliminación masiva. |
| `product_deletion_rows` | Productos reclamados/procesados por el job de eliminación. |

Los campos `claim_token` y `claimed_at` permiten que los procesos se reanuden sin procesar simultáneamente la misma fila.

## Relaciones y restricciones

Las tablas históricas no declaran `FOREIGN KEY`; sus campos `document_id`, `operation_id`, `product_id`, `import_id`, `backup_id` y `deletion_id` continúan como relaciones lógicas. Las tablas nuevas de Pedidos y Notificaciones sí declaran claves foráneas entre sus entidades y aplican `CASCADE`, `RESTRICT` o `SET NULL` según la conservación histórica requerida.

Implicaciones:

- D1 no bloquea por sí solo referencias huérfanas en las tablas históricas;
- una futura incorporación de claves foráneas requiere auditoría de datos, estrategia de borrado y nueva migración;
- no se deben agregar restricciones directamente en producción sin probar compatibilidad con restauraciones, reversas y jobs reanudables.

## Archivos en R2

Los bytes de PDF/imágenes no viven en D1. `inventory_document_files.storage_key` apunta a objetos R2 bajo:

```text
inventory-invoices/{documentId}/{fileIndex}
```

D1 guarda nombre, MIME, tamaño y SHA-256. El lector verifica que el tamaño recuperado coincida con el registro; la huella permite deduplicar el conjunto.

## Evolución del esquema

Reglas obligatorias:

1. no borrar ni editar migraciones aplicadas;
2. modificar primero `db/schema.ts`;
3. generar una migración nueva con `npm run db:generate`;
4. revisar SQL y preservación de datos;
5. mantener compatibilidad temporal en `ensureDatabase()` solo cuando esté justificada;
6. agregar pruebas de migración/lectura/escritura;
7. documentar el cambio y verificarlo en el deployment.

Hallazgo: `db/index.ts` replica gran parte del esquema con creación y adiciones condicionales. Se mantiene por compatibilidad histórica, pero debe existir una futura tarea específica para definir una sola autoridad de evolución sin poner D1 en riesgo.
