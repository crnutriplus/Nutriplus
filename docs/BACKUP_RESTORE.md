# Respaldos y recuperación

## Estado del backup integral D1 + R2

> **BLOQUEADO POR LA PLATAFORMA — verificado el 2026-08-20.**

La auditoría se realizó sobre NutriPlus v2.12, checkpoint técnico 26 y el estado de código identificado antes de esta documentación por el commit `0bb1c88df90592013aadb2a93f4a87e64bc63049`.

Los recursos de producción son administrados exclusivamente por ChatGPT Sites. La persona propietaria de NutriPlus no tiene una cuenta Cloudflare enlazada a estos recursos ni D1/R2 propios. Por decisión expresa, no se realizará por ahora ninguna migración, sustitución o cambio de infraestructura.

### Evidencia comprobada

- `.openai/hosting.json` declara únicamente los bindings lógicos D1 `DB` y R2 `BUCKET`; no contiene ni debe contener IDs físicos o credenciales.
- Sites permite consultar el inventario de tablas y páginas limitadas de filas de D1 en modo de solo lectura.
- Sites no expone una exportación integral de D1 que incluya esquema físico, índices, triggers, datos y estado de migraciones.
- Sites no expone una operación administrativa para listar, exportar o restaurar todos los objetos de R2, incluida su metadata.
- Sites no expone escritura administrativa hacia una D1/R2 aislada para ejecutar un simulacro de restauración.
- El checkout no contiene `wrangler.jsonc`, IDs físicos de recursos ni credenciales Cloudflare. El CLI de Sites disponible gestiona el ciclo del código, no exportaciones/restauraciones de datos.
- El binding D1 de producción contiene 17 tablas de aplicación: `settings`, `products`, `non_inventory_quotes`, `import_jobs`, `import_job_rows`, `import_backups`, `import_backup_products`, `product_deletion_jobs`, `product_deletion_rows`, `mutation_receipts`, `inventory_documents`, `inventory_document_lines`, `inventory_document_files`, `invoice_ai_analyses`, `supplier_product_aliases`, `inventory_operations` e `inventory_movements`.
- El código conserva las migraciones `0000` a `0014` y crea además dos triggers de protección de movimientos desde `ensureDatabase()`. La interfaz de Sites no permite exportar y comparar directamente el catálogo físico de producción para demostrar que esquema, índices, triggers y ledger de migraciones fueron copiados.

### Consecuencia

Con las capacidades actuales no se puede demostrar de extremo a extremo ninguno de estos puntos obligatorios:

| Requisito | Estado | Motivo |
|---|---|---|
| Exportación integral de D1 | **Bloqueado** | No existe exportación administrativa de esquema + datos + índices + triggers. |
| Inventario completo de R2 | **Bloqueado** | No se pueden listar todos los objetos, por lo que tampoco se pueden detectar huérfanos. |
| SHA-256 de cada objeto R2 | **Bloqueado** | Solo pueden recuperarse archivos referenciados por flujos de la aplicación; eso no prueba que sean todos los objetos. |
| Consistencia D1 ↔ R2 | **Bloqueado** | No se puede comparar D1 con un listado completo e independiente del bucket. |
| Restauración en D1/R2 aislados | **Bloqueado** | Sites no expone creación/escritura administrativa de destinos aislados. |
| Comparación origen/restauración | **Bloqueado** | No existe una restauración integral válida que comparar. |

Por esta razón **no existe todavía un backup integral D1 + R2 verificado** y no se debe presentar como disponible. Implementar únicamente scripts o respaldar solo objetos referenciados produciría una cobertura parcial y no cumpliría el objetivo de recuperación ante desastre.

### Decisión de seguridad

Durante esta fase:

- no se creó ningún endpoint `/backup` o `/restore`;
- no se añadieron secretos, tokens ni credenciales;
- no se modificaron D1, R2, bindings, migraciones ni infraestructura;
- no se creó una cuenta Cloudflare ni recursos externos;
- no se ejecutó restauración sobre producción;
- no se programaron backups automáticos;
- no se cambió la versión pública ni se desplegó una implementación incompleta.

### Condiciones para desbloquearlo

La fase podrá reabrirse únicamente cuando exista una capacidad administrativa oficial y segura que permita, como mínimo:

1. exportar D1 completo, incluido esquema, datos, índices, triggers y estado de migraciones;
2. listar y descargar todos los objetos R2 con keys, bytes y metadata;
3. crear o seleccionar D1/R2 aislados y escribir en ellos;
4. verificar que los destinos sean distintos de producción;
5. ejecutar la comparación de conteos, hashes y referencias D1 → R2.

Esto puede provenir de una futura función oficial de ChatGPT Sites o de una futura migración expresamente autorizada hacia recursos Cloudflare controlados por NutriPlus. Ninguna de las dos acciones forma parte del alcance actual.

## Qué existe actualmente

### Snapshot de productos

Antes de procesar una importación Excel se ejecuta `createBackupForImport()`. Antes de una eliminación masiva se ejecuta `createInventoryBackup()`. Ambos copian el estado completo de `products` a:

- `import_backups`: cabecera, cantidad y fecha;
- `import_backup_products`: copia de cada fila de producto.

El historial se muestra en la sección Importar y permite seleccionar **Volver a este respaldo**.

### Restauración de productos

`POST /api/imports/{id}/restore`:

1. bloquea la restauración si hay una importación/eliminación activa;
2. verifica que exista el snapshot solicitado;
3. crea primero otro snapshot del inventario actual;
4. reemplaza `products` con las filas guardadas;
5. restablece la secuencia de IDs;
6. marca el job original como restaurado y devuelve el total comprobado.

Esta operación debe iniciarse desde la interfaz y con confirmación humana. No se ejecutó sobre producción durante la auditoría.

### Recuperación funcional adicional

- Los jobs de importación y eliminación conservan estado por fila y pueden reanudarse.
- Las mutaciones idempotentes se apoyan en `mutation_receipts`.
- Los ingresos de factura no se borran para deshacerlos: se crea una operación de reversa y movimientos contrarios.
- Si se reenvía una factura duplicada a la que le faltan objetos R2, el flujo puede reponer los archivos sin repetir el análisis.

Estas funciones son recuperación operativa; no sustituyen un backup integral.

## Qué cubre el snapshot

Solo filas de `products`, incluidos costo, peso, cantidad, mínimo, fechas de abastecimiento/cero, versión y timestamps. No cubre:

- `settings`;
- `non_inventory_quotes`;
- facturas, líneas, análisis, alias, operaciones o movimientos;
- jobs y auditoría fuera del snapshot;
- objetos PDF/imágenes de R2;
- configuración o secretos del deployment.

## Exportaciones

La descarga Excel/PDF es una exportación para uso humano. No incluye todas las tablas, IDs, relaciones ni originales R2, por lo que no es un formato de restauración de la aplicación.

## Checkpoints y plataforma

Los checkpoints de Sites y commits de Git preservan código. No se encontró en el repositorio un procedimiento comprobado de snapshots programados/exportación completa de D1 ni versionado/replicación de R2. No se debe afirmar que existe recuperación de datos solo porque la plataforma pueda tener capacidades externas.

## Brecha operativa

NutriPlus no tiene todavía un backup/restore integral y probado para D1 + R2. Una pérdida o corrupción fuera de `products` no puede recuperarse con el mecanismo de importaciones. El diseño y simulacro integral permanecen formalmente **bloqueados por las capacidades administrativas actuales de Sites**, según el estado verificado arriba.

Recomendación de prioridad alta:

1. definir RPO/RTO y retención;
2. inventariar capacidades reales de exportación/snapshot del ambiente de Sites;
3. crear exportaciones cifradas y versionadas de D1;
4. respaldar objetos y metadata de R2 de forma coherente;
5. documentar responsables, acceso y rotación;
6. ensayar restauración en un ambiente aislado;
7. comprobar recuentos, hashes y relaciones después de restaurar;
8. registrar fecha y resultado de cada simulacro.

No implementar ni probar el plan directamente en producción. Debe ser una tarea separada con ambiente de ensayo, acceso administrativo suficiente y autorización específica.

## Prueba de restauración

**No ejecutada.** No existe acceso para producir una copia integral ni recursos D1/R2 aislados administrables donde restaurarla. Intentar simular éxito con fixtures locales o únicamente con los archivos referenciados por D1 no demostraría recuperación integral del entorno real.

Estado de los datos al cerrar esta revisión:

- producción no fue restaurada ni modificada;
- no se copiaron datos personales a un destino nuevo;
- no se crearon recursos externos;
- los snapshots parciales de productos y los mecanismos operativos existentes permanecen sin cambios.
