# Respaldos y recuperación

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

NutriPlus no tiene todavía un plan integral y probado de backup/restore para D1 + R2. Una pérdida o corrupción fuera de `products` no puede recuperarse con el mecanismo de importaciones.

Recomendación de prioridad alta:

1. definir RPO/RTO y retención;
2. inventariar capacidades reales de exportación/snapshot del ambiente de Sites;
3. crear exportaciones cifradas y versionadas de D1;
4. respaldar objetos y metadata de R2 de forma coherente;
5. documentar responsables, acceso y rotación;
6. ensayar restauración en un ambiente aislado;
7. comprobar recuentos, hashes y relaciones después de restaurar;
8. registrar fecha y resultado de cada simulacro.

No implementar ni probar el plan directamente en producción. Debe ser una tarea separada con ambiente de ensayo y autorización específica.
