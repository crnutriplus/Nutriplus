# Modelo de datos

## Persistencia real

NutriPlus usa Cloudflare D1, compatible con SQLite. Drizzle ORM describe el esquema en `db/schema.ts`, mientras que los Route Handlers usan tanto Drizzle como sentencias preparadas de D1.

Las migraciones versionadas están en `drizzle/` y el journal registra 13 entradas, de `0000_fluffy_shinobi_shaw.sql` a `0012_breezy_bullseye.sql`.

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

### Movimientos y auditoría de inventario

| Tabla | Propósito |
|---|---|
| `inventory_operations` | Ingreso, ajuste rápido o reversa, con estado, responsable y totales. |
| `inventory_movements` | Cambio por producto, cantidad previa, delta y cantidad resultante. |

Una confirmación genera una operación y uno o más movimientos. Una reversa conserva el ingreso original y crea otra operación con movimientos contrarios, enlazada mediante `reversal_of`/`original_movement_id`.

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

El esquema no declara `FOREIGN KEY`. Los campos `document_id`, `operation_id`, `product_id`, `import_id`, `backup_id` y `deletion_id` representan relaciones lógicas que las transacciones y validaciones de la aplicación deben mantener.

Implicaciones:

- D1 no bloquea por sí solo referencias huérfanas;
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
