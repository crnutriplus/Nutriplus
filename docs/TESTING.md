# Pruebas y calidad

## Flujo escalonado

```bash
npm run check:fast
npm run check:orders
npm run check:inventory
npm run check:invoices
npm run check:release
```

- **Nivel 1 — desarrollo:** test afectado/nuevo y `check:fast`. No incluye instalación, build ni E2E.
- **Nivel 2 — módulo:** usar el alias del módulo al cerrar una unidad importante. Estos aliases construyen una vez porque sus integraciones consumen `dist`.
- **Nivel 3 — release:** ejecutar `check:release` una sola vez al final. Incluye TypeScript, ESLint, build, suite completa, integraciones/E2E, migraciones, concurrencia, validador Sites, secret scan y audit de producción. No hace llamadas pagadas a OpenAI.

`npm test` ya ejecuta un build y la regresión completa. No repetir un build explícito si esa puerta pasó y no cambió código relacionado.

### Regresión mínima recomendada

| Cambio en | Puerta mínima |
|---|---|
| UI/helper aislado | Test afectado + `check:fast` |
| Pedidos/Encargos | `check:orders` |
| Facturas/ingreso por factura | `check:invoices` |
| Movimientos o saldo de inventario | `check:inventory` (incluye consumidores de Facturas/Pedidos) |
| Migración | Prueba de migración + módulos afectados; luego `check:release` |
| Código compartido/transversal | Consumidores directos; luego `check:release` si toca inventario, dinero o concurrencia |

No repetir `npm ci` con dependencias instaladas y manifests sin cambios. Usarlo en entornos limpios, cambios de dependencias o una release reproducible.

## Suite principal

`npm test` ejecuta:

- `tests/rendered-html.test.mjs`: metadata y versión renderizadas;
- `tests/invoice-reader-unit.test.mjs`: normalización/lectura local de facturas;
- `tests/invoice-ai-unit.test.mjs`: configuración, modelos y estimación de consumo;
- `tests/chatgpt-invoice-import-unit.test.mjs`: parser y seguridad del ZIP;
- `tests/inventory-matching-unit.test.mjs` y `tests/product-presentation-unit.test.mjs`: prioridad barcode/proveedor+SKU, nombre diferente y presentación comercial normalizada;
- `tests/notification-destinations-unit.test.mjs` y `tests/notifications-unit.test.mjs`: destinos internos tipados, cifrado Web Push/VAPID, validación de subscription, permiso iniciado por la persona, Service Worker, caché segura, `notificationclick` y manifest PWA;
- `tests/inventory-migration-0014.integration.mjs`: migración desde el índice de v2.11, reingreso tras reversa, límites por saldo y compatibilidad con ingreso rápido;
- `tests/orders-migration-0015.integration.mjs`: migración aditiva desde el esquema productivo actual, conservación de inventario y restricciones/triggers de Pedidos;
- `tests/notifications-migration-0016.integration.mjs`: migración desde v2.16, conservación exacta de tablas/filas/definiciones y nuevas restricciones/estados de alertas;
- `tests/orders-phase-1.integration.mjs`: estados, inventario por delta, idempotencia, concurrencia, pagos, devoluciones, rutas, snapshots, numeración NP y fechas de Costa Rica;
- `tests/orders-special-foundation.integration.mjs`: expectativa de pago, estados de Encargos, ambos caminos de recepción, cantidades parciales, idempotencia y concurrencia;
- `tests/orders-phase-2.integration.mjs`: contrato de interfaz operativa, tarjetas diarias, duplicados, acciones, pagos, rutas, filtros, responsive, idempotencia y concurrencia;
- `tests/orders-phase-3.integration.mjs`: impresión exacta y multipágina, cierre de ruta, entregas parciales, correcciones, devoluciones, Encargos completos, saldos, historial y contrato móvil;
- `tests/orders-phase-4.e2e.mjs`: flujo E2E con stock 10→7→5→6→7, pagos completos, reapertura, devolución, carrera por la última unidad y Encargo completo;
- `tests/notifications.integration.mjs`: umbrales/rearmado, idempotencia, preferencias, lectura/descarte, aislamiento de fallos push, subscriptions, resúmenes de Pedidos, cadencia de Encargos y zona horaria;
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
node tests/orders-phase-4.e2e.mjs
```

La prueba de Fase 1 cubre borrador sin stock, confirmación única, reintentos, rollback por faltantes, edición confirmada por delta, cancelación, preparación/entrega, reapertura, pagos mixtos, devoluciones, actualización obsoleta, carrera por la última unidad, reprogramación, snapshots, NP concurrente y fecha operativa. La ampliación comprueba además que el método esperado no toca el ledger, que las transiciones de proveedor no mueven inventario, que marcar recibido deja una resolución pendiente y que los caminos `INVENTORY_NOW` y `ALREADY_INVENTORY` conservan idempotencia, trazabilidad, stock real y recepción parcial. La prueba de Fase 2 recorre las operaciones que consume la interfaz. La de Fase 3 valida los flujos avanzados contra el Worker construido, incluido PDF de varias páginas, saldos, rutas con pendientes, entrega parcial idempotente y el ciclo completo de un Encargo. La de Fase 4 reproduce el escenario de release exacto, una carrera por la última unidad y un Encargo de punta a punta bajo el mismo NP.

`orders-migration-0015.integration.mjs` ejecuta las migraciones `0000` a `0014`, confirma las 17 tablas de v2.15, guarda definiciones y conteos, inserta datos heredados y aplica `0015`. Después verifica las 17 tablas y sus filas, las nuevas entidades, las tres columnas aditivas de movimientos y los guards de inventario/estados.

La puerta de v2.16 se ejecutó después de `npm ci` aislado. `npm audit --omit=dev` informó 0 críticos, 0 altos, 2 moderados y 0 bajos: `exceljs` y su `uuid` transitivo ya documentados. No se forzó un downgrade incompatible para ocultar esos avisos.

Estas pruebas usan una base SQLite temporal compatible con D1. No aplican migraciones a producción, no crean movimientos reales, no usan R2 y no hacen llamadas a OpenAI.

## Notificaciones

Para validar la base de forma aislada después del build:

```bash
node --test tests/notifications-unit.test.mjs
node tests/notifications-migration-0016.integration.mjs
node tests/notifications.integration.mjs
```

La suite comprueba los 21 casos mínimos de la instrucción: ausencia de alerta sobre el umbral, primer cruce, no repetición, agotado distinto, recuperación/rearmado, nuevo ciclo, retry idempotente, fallo push sin rollback, permanencia interna, lectura, descarte, preferencias, UX de permiso rechazado, endpoint único, desactivación 404/410, exclusión de `/api/*` del caché, URL segura al hacer clic, consolidación de Pedidos, política sin spam de Encargos, `America/Costa_Rica` y preservación de v2.16 por `0016`.

Las llamadas Web Push usan claves P-256 efímeras y un `fetch` local inyectado. No contactan un push service real, no usan secretos ni prueban un teléfono. La recepción con la aplicación cerrada debe validarse después de una publicación expresamente autorizada; no se infiere de estas pruebas locales.

Resultado local final del 2026-08-21:

- `npm ci`: pasó (652 paquetes instalados);
- TypeScript y ESLint: pasaron sin errores;
- pruebas focalizadas: 5/5 pasaron;
- `npm test`: pasó con 39/39 pruebas unitarias y las 14 integraciones/E2E posteriores;
- build y validador Sites: pasaron; permanece solo el aviso no bloqueante conocido de chunks mayores de 500 kB;
- `git diff --check`: pasó;
- secret scan textual de fuentes propias: 0 credenciales encontradas;
- `npm audit --omit=dev`: 0 críticas, 0 altas y 2 moderadas conocidas (`exceljs`/`uuid`).

## Pruebas opcionales con archivos

La integración autocontenida `tests/invoice-finance.integration.mjs` forma parte de `npm test`, `check:invoices` y `check:finance`. Verifica reconocimiento parcial por línea, pagos divididos, últimos cuatro dígitos seguros, crédito de tienda no monetario, exclusión personal, reversas/reingreso, fecha financiera de confirmación, enlace privado HEAD/GET a la factura e idempotencia sin depender de archivos externos. `tests/inventory-inline-unit.test.mjs` cubre el escáner reutilizado, cálculo con parámetros vigentes, mínimo de stock, autoselección y recuperación segura del guard de confirmación.

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
- las migraciones críticas `0014`, `0015` y `0016` tienen pruebas automáticas; `0016` parte del esquema completo v2.16, pero no existe una matriz desde cada snapshot histórico anterior;
- la interfaz de Pedidos tiene contrato estático responsive e integración real contra el Worker local; la recorrida visual de navegador se reserva para la verificación final del checkpoint;
- no existe todavía una prueba física de Android Chrome/PWA, permiso, subscription, recepción cerrada y clic contra un deployment autorizado;
- Sites no expone scheduler del proyecto, por lo que no puede probarse una ejecución horaria server-side de alertas temporales;
- no hay prueba automatizada de backup integral/recuperación D1+R2 porque ese mecanismo aún no existe;
- las pruebas opcionales dependen de rutas de fixtures externas y no forman parte de `npm test`.

Estas carencias deben tratarse en tareas separadas. No se debe compensar ejecutando mutaciones destructivas ni restauraciones sobre producción.

## Criterio de finalización

Una tarea no está completa si falla el nivel correspondiente. Una release exige `check:release`, revisión de cualquier HIGH/CRITICAL y comprobación del deployment, versión y flujo afectado después de publicar.
