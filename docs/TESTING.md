# Pruebas y calidad

## Puerta de calidad obligatoria

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
npm run validate:artifact
```

`npm test` ya ejecuta `npm run build`; el build explícito se conserva como verificación final cuando una tarea lo exige.

## Suite principal

`npm test` ejecuta:

- `tests/rendered-html.test.mjs`: metadata y versión renderizadas;
- `tests/invoice-reader-unit.test.mjs`: normalización/lectura local de facturas;
- `tests/invoice-ai-unit.test.mjs`: configuración, modelos y estimación de consumo;
- `tests/chatgpt-invoice-import-unit.test.mjs`: parser y seguridad del ZIP;
- `tests/inventory-migration-0014.integration.mjs`: migración desde el índice de v2.11, reingreso tras reversa, límites por saldo y compatibilidad con ingreso rápido;
- `tests/orders-migration-0015.integration.mjs`: migración aditiva desde el esquema productivo actual, conservación de inventario y restricciones/triggers de Pedidos;
- `tests/orders-phase-1.integration.mjs`: estados, inventario por delta, idempotencia, concurrencia, pagos, devoluciones, rutas, snapshots, numeración NP y fechas de Costa Rica;
- `tests/orders-special-foundation.integration.mjs`: expectativa de pago, estados de Encargos, ambos caminos de recepción, cantidades parciales, idempotencia y concurrencia;
- `tests/orders-phase-2.integration.mjs`: contrato de interfaz operativa, tarjetas diarias, duplicados, acciones, pagos, rutas, filtros, responsive, idempotencia y concurrencia;
- `tests/orders-phase-3.integration.mjs`: impresión exacta y multipágina, cierre de ruta, entregas parciales, correcciones, devoluciones, Encargos completos, saldos, historial y contrato móvil;
- `tests/api-integration.mjs`: productos, ajustes, quotes e importaciones;
- `tests/concurrency-integration.mjs`: idempotencia y concurrencia;
- `tests/inventory-intake-integration.mjs`: documentos, confirmación, cierre no destructivo a nivel de interfaz, omisión/reactivación, saldo neto, reingreso, concurrencia, historial por factura y reversas;
- `tests/export-integration.mjs`: Excel/PDF exportados.

Las integraciones ejecutan el artefacto construido con dobles locales de D1/R2 cuando corresponde. No modifican producción.

## Pedidos — base ampliada

Para validar aisladamente el dominio nuevo:

```bash
node tests/orders-migration-0015.integration.mjs
node tests/orders-phase-1.integration.mjs
node tests/orders-special-foundation.integration.mjs
node tests/orders-phase-2.integration.mjs
node tests/orders-phase-3.integration.mjs
```

La prueba de Fase 1 cubre borrador sin stock, confirmación única, reintentos, rollback por faltantes, edición confirmada por delta, cancelación, preparación/entrega, reapertura, pagos mixtos, devoluciones, actualización obsoleta, carrera por la última unidad, reprogramación, snapshots, NP concurrente y fecha operativa. La ampliación comprueba además que el método esperado no toca el ledger, que las transiciones de proveedor no mueven inventario, que marcar recibido deja una resolución pendiente y que los caminos `INVENTORY_NOW` y `ALREADY_INVENTORY` conservan idempotencia, trazabilidad, stock real y recepción parcial. La prueba de Fase 2 recorre las operaciones que consume la interfaz. La de Fase 3 valida los flujos avanzados contra el Worker construido, incluido PDF de varias páginas, saldos, rutas con pendientes, entrega parcial idempotente y el ciclo completo de un Encargo.

Estas pruebas usan una base SQLite temporal compatible con D1. No aplican `0015` a producción, no crean movimientos reales, no usan R2 y no hacen llamadas a OpenAI.

## Pruebas opcionales con archivos

### Paquete ChatGPT real

```bash
NUTRIPLUS_CHATGPT_IMPORT_ZIP=/ruta/al/NutriPlus_*.zip npm run test:chatgpt-import
```

Valida un ZIP real contra el endpoint construido y comprueba borrador, deduplicación, hash, recuperación parcial/completa, reversa, reingreso, historial agrupado, cero llamadas/costo y ausencia de modificación del inventario antes de confirmar. El test instala un `fetch` que falla si el flujo intenta llamar a OpenAI.

### Contrato de facturas reales sin consumo

```bash
NUTRIPLUS_IHERB_TEST_PDF=/ruta/iherb.pdf \
NUTRIPLUS_AMAZON_TEST_PDF=/ruta/amazon.pdf \
npm run test:real-invoices
```

Usa las facturas como entrada, pero sustituye Responses API por respuestas controladas. La clave incluida por el test es ficticia. Verifica contrato, archivos completos, modelo y persistencia sin consumo real.

### Almacenamiento local con IA deshabilitada

```bash
NUTRIPLUS_IHERB_TEST_PDF=/ruta/iherb.pdf \
NUTRIPLUS_AMAZON_TEST_PDF=/ruta/amazon.pdf \
npm run test:real-invoices:local
```

Comprueba almacenamiento/recuperación de archivos con `INVOICE_AI_ENABLED=false`.

## Regla sobre OpenAI

No ejecutar una llamada pagada real para probar interfaz, errores, validación o una factura repetida. Usar fixtures, mocks y respuestas almacenadas. Una prueba real requiere autorización expresa y debe registrar el consumo resultante.

## Qué falta

- no existe una suite E2E de navegador que recorra todos los botones del deployment;
- las migraciones críticas `0014` y `0015` tienen pruebas automáticas con datos representativos; no existe todavía una matriz desde cada snapshot histórico de D1;
- la interfaz de Pedidos tiene contrato estático responsive e integración real contra el Worker local; la recorrida visual de navegador se reserva para la verificación final del checkpoint;
- no hay prueba automatizada de backup integral/recuperación D1+R2 porque ese mecanismo aún no existe;
- las pruebas opcionales dependen de rutas de fixtures externas y no forman parte de `npm test`.

Estas carencias deben tratarse en tareas separadas. No se debe compensar ejecutando mutaciones destructivas ni restauraciones sobre producción.

## Criterio de finalización

Una tarea no está completa si falla lint, TypeScript, una prueba relacionada, el build o el deployment. Después de publicar se debe comprobar la versión y, para cambios funcionales, el flujo afectado en la aplicación publicada.
