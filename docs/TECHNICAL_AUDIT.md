# Auditoría técnica base — 2026-08-19

## Alcance y línea base

Auditoría documental y estática realizada sobre NutriPlus v2.9, checkpoint técnico 22, commit `2d91cc944a4194e97bc5b35d7af31824a9b8a2f4`. No se modificó lógica de negocio, APIs, esquema, migraciones, autenticación, OpenAI ni datos.

Se revisaron Git, documentación, estructura, 29 endpoints, 17 tablas, 13 migraciones, scripts, configuración, variables, archivos, logs, pruebas y dependencias.

## Documentación anterior

### Existía

- `README.md`, pero conservaba el texto genérico de `vinext-starter` y afirmaba incorrectamente que el esquema D1 estaba vacío;
- `CHANGELOG.md` con la reconstrucción histórica y separación versión/checkpoint;
- comentarios puntuales en código y scripts.

### Faltaba

- `AGENTS.md`;
- `SECURITY.md`;
- directorio `docs/`;
- arquitectura, modelo de datos, ambientes, pruebas, deployment y recuperación documentados como sistema;
- reglas permanentes de publicación, consumo OpenAI y evolución de migraciones.

## Estructura del repositorio

### Correcto

- separación física entre `app/`, `lib/`, `db/`, `drizzle/`, `tests/`, `scripts/` y `worker/`;
- reglas de negocio reutilizables para precios, importación, facturas, almacenamiento y exportación;
- historial de migraciones y pruebas unitarias/de integración;
- no se detectaron ciclos en un análisis de imports de 58 archivos TypeScript/TSX;
- no se encontraron secretos reales versionados ni logs de producción con claves/tokens.

### Mejora recomendada

- `app/client-app.tsx` tiene 1.909 líneas y mezcla navegación, estado remoto, trabajo sin conexión, calculadora, productos y modales;
- `app/inventory-intake.tsx` tiene 1.326 líneas y mezcla carga, selección de modo, análisis, edición, códigos, confirmación e historial;
- `lib/invoice-ai.ts` (695 líneas) y `lib/chatgpt-invoice-import.ts` (479) concentran validación, transformación y orquestación;
- el endpoint `app/api/inventory-intake/[id]/confirm/route.ts` (402 líneas) concentra transacción, matching, movimientos y verificación;
- no existe una capa de contratos compartidos explícita entre DTOs de frontend y API.
- el build advierte chunks mayores a 500 kB y `public/ocr/` aporta cerca de 50 MB; conviene medir carga real y dividir/servir activos bajo demanda antes de optimizar.

No se recomienda dividir estos archivos sin una tarea específica, tests de regresión y cambios pequeños por flujo.

### Problema importante

- `db/index.ts` duplica el esquema/migraciones mediante creación y `ALTER TABLE` condicionales. Existe riesgo de deriva respecto de `db/schema.ts` y `drizzle/`.
- El esquema no declara claves foráneas. La integridad relacional depende de transacciones y lógica de aplicación.

## Seguridad

### Controles existentes

- política de acceso custom de Sites restringida al propietario;
- clave OpenAI solo en el Worker;
- `.env*`, claves PEM y logs ignorados por Git;
- deduplicación por SHA-256/huella antes de reanalizar;
- límites de archivos y objetos R2 con claves generadas;
- importador ZIP con protección de traversal, rutas absolutas, symlinks, ejecutables, cifrado, número/tamaño de entradas y ZIP bomb;
- esquema, tipos, totales, unidades y hash recalculados para `CHATGPT_IMPORT`;
- confirmación explícita antes de inventario, idempotencia, historial y reversas.

### Hallazgos

| Severidad | Hallazgo | Exposición actual | Acción recomendada |
|---|---|---|---|
| Alta | No existe backup integral probado de D1 + R2. | Pérdida/corrupción fuera de `products` no es recuperable desde la app. | Diseñar y ensayar backups cifrados en ambiente aislado. |
| Alta condicionada | No hay autorización por endpoint ni roles propios. | Reducida mientras Sites siga owner-only; crítica antes de abrir a empleados/clientes. | Diseñar RBAC/ABAC de servidor antes de ampliar acceso. |
| Media | La carga normal de factura acepta MIME declarado/extensión sin comprobar magic bytes. | Un archivo disfrazado puede llegar a R2/lectores. | Validar firma real antes de guardar, con fixtures por formato. |
| Media | `errorResponse()` puede devolver mensajes internos de excepciones. | Posible exposición de detalle de D1/runtime. | Mapear errores públicos a códigos y registrar detalle redactado. |
| Media | No existe política técnica de retención/eliminación de originales y análisis. | Puede conservarse PII más tiempo del necesario. | Definir retención, eliminación y auditoría por categoría. |
| Media | No hay claves foráneas. | Riesgo de referencias huérfanas ante defectos o mantenimiento manual. | Auditar datos y planear migraciones graduales. |

No se ejecutaron restauraciones, bypasses de acceso ni llamadas reales a OpenAI durante esta auditoría.

## Verificación realizada para v2.10

- ESLint y TypeScript estricto pasaron.
- La suite principal pasó 20/20 pruebas unitarias, seguida de todas las integraciones de API, concurrencia, inventario y exportación.
- El build y la validación del artefacto Sites pasaron.
- El paquete real `NutriPlus_945586803.zip` creó un borrador iHerb con pedido `945586803`, fecha `2026-07-03`, tracking `1LSCXLZ0066WJ4P`, total USD 60.58, 4 líneas y 5 unidades.
- Esa prueba comprobó deduplicación, cero productos/operaciones/movimientos antes de confirmar, `api_calls = 0`, costo cero y ninguna llamada a OpenAI.

## Dependencias

### Línea base antes del lote 1

`npm audit --omit=dev --json` informó 16 dependencias de producción afectadas: 15 altas, 1 moderada y 0 críticas. La auditoría completa informó 61: 49 altas, 9 moderadas, 3 bajas y 0 críticas.

Directas de producción que requieren revisión:

| Paquete | Versión | Hallazgo de `npm audit` | Prioridad |
|---|---:|---|---|
| `next` | 16.2.6 | Avisos altos/moderados para rangos anteriores a 16.2.11, más transitivos. El stack actual Vinext/Vite impide un fix automático. | Alta: probar actualización coordinada de Next/React/Vinext. |
| `xlsx` | 0.18.5 | Prototype pollution y ReDoS; npm no ofrece fix automático. Procesa hojas cargadas por personas usuarias. | Alta: evaluar versión mantenida/fuente oficial o reemplazo, con límites y tests. |
| `exceljs` | 4.4.0 | Transitivos afectados (`archiver`, `unzipper`, `uuid`); sin fix automático en el árbol actual. Se usa para exportar. | Media-alta: revisar upgrade/reemplazo y superficie realmente alcanzable. |

El árbol también contiene paquetes transitivos deprecados (`inflight`, `fstream`, `glob@7`, `rimraf@2`, `lodash.isequal`, `@esbuild-kit/*`, `uuid@8`). Provienen principalmente de ExcelJS y Drizzle Kit; no se deben actualizar aisladamente sin comprobar el paquete padre.

`npm outdated` confirmó que el stack tiene versiones posteriores disponibles, entre ellas Next 16.3.1, React 19.2.8, Vinext 1.0.0-beta.7, Vite 8.2.1 y Wrangler 4.124.0 al momento de la auditoría. No se hizo una actualización automática porque implica compatibilidad y cambios funcionales potenciales.

### Lote 1 — framework/runtime (2026-08-20)

Se reprodujo nuevamente la línea base antes de modificar dependencias: `npm audit --omit=dev` informó 16 vulnerabilidades de producción, con 0 críticas, 15 altas, 1 moderada y 0 bajas.

| Cadena | Antes | Después | Avisos corregidos | Decisión |
|---|---:|---:|---|---|
| Next | 16.2.6 | 16.3.1 | `GHSA-6gpp-xcg3-4w24`, `GHSA-m99w-x7hq-7vfj`, `GHSA-89xv-2m56-2m9x`, `GHSA-68g3-v927-f742`, `GHSA-4633-3j49-mh5q`, `GHSA-4c39-4ccg-62r3`, `GHSA-p9j2-gv94-2wf4`, `GHSA-q8wf-6r8g-63ch`, `GHSA-955p-x3mx-jcvp` | 16.2.11 corregía los avisos propios de Next, pero mantenía transitivas vulnerables; 16.3.0 fue el primer estable de la misma major que actualizó toda la cadena y se eligió su parche vigente 16.3.1. |
| PostCSS | 8.4.31 dentro de Next; 8.5.14 compartido | 8.5.23 | `GHSA-qx2v-qp2m-jg93`, `GHSA-6g55-p6wh-862q`, `GHSA-fxqj-rqcc-2cmp`, `GHSA-r28c-9q8g-f849` | Actualización transitiva soportada por Next 16.3.1; no se añadió override. |
| Nanoid | 3.3.12 | 3.3.18 | `GHSA-28wg-ghj8-5hjv`, `GHSA-2v37-7h3g-55p8` | Resuelto por el rango de PostCSS corregido. |
| Sharp de Next | 0.34.5 | 0.35.3 | `GHSA-f88m-g3jw-g9cj` | Resuelto por la dependencia opcional soportada de Next 16.3.1. |

Vinext permaneció en 0.0.50, React y React DOM en 19.2.6, Vite en 8.0.13 y `@vitejs/plugin-rsc` en 0.5.26; sus peers siguieron satisfechos. `eslint-config-next` se alineó de 16.2.6 a 16.3.1. No se modificó código funcional ni se usaron overrides.

Después de `npm ci`, `npm audit --omit=dev` informó 4 vulnerabilidades: 0 críticas, 2 altas, 2 moderadas y 0 bajas. Desaparecieron todos los avisos del framework/runtime objetivo. Permanecen xlsx (alta), `brace-expansion` (alta en la cadena pendiente), ExcelJS (moderada por la cadena reportada) y `uuid` (moderada bajo ExcelJS); su corrección se difiere al lote específico de archivos Excel.

La validación pasó lint, TypeScript, 23/23 pruebas unitarias, todas las integraciones de API/concurrencia/inventario/exportación, build de producción y navegación visual. El ZIP real `CHATGPT_IMPORT` pasó validación, recuperación, reversa, historial e idempotencia con `api_calls = 0`, `api_cost = 0` y ninguna llamada a OpenAI. El bloqueo de backup/restore integral D1 + R2 continúa abierto e intacto.

### Lote 2A — brace-expansion (2026-08-20)

La línea base confirmada fue NutriPlus v2.13, checkpoint técnico 27 y commit `d8d82818d06a3fb4a8622d3d9597f71878423333`, con el repositorio limpio. Antes del cambio, `npm audit --omit=dev` informó 12 nodos afectados: 0 críticos, 11 altos, 1 moderado y 0 bajos. La auditoría completa informó 57: 0 críticos, 46 altos, 8 moderados y 3 bajos.

Se ejecutó una actualización dirigida de `brace-expansion` usando la resolución normal de npm y modificando únicamente el lockfile de dependencias en esta fase. No fue necesario agregar un `override` ni forzar versiones fuera de los rangos declarados por los paquetes padres.

| Rama | Antes | Después | Dependencia padre | Resultado |
|---|---:|---:|---|---|
| 1.x | 1.1.14 | 1.1.18 | minimatch 3.1.5 (`^1.1.7`) | Corregida dentro del rango existente. |
| 2.x | 2.1.4 | 2.1.4 | minimatch 5.1.9 (`^2.0.1`) | Se conservó la resolución segura existente. |
| 5.x, desarrollo | 5.0.6 | 5.0.9 | minimatch 10.2.5 (`^5.0.5`) | Corregida dentro del rango existente. |

Permanecieron exactamente en sus versiones anteriores minimatch 3.1.5, 5.1.9 y 10.2.5; glob 7.2.3; ExcelJS 4.4.0; xlsx 0.18.5 y uuid 8.3.2. También permanecieron las cadenas productivas de ExcelJS por archiver y unzipper, pero ahora la copia compartida de `brace-expansion` 1.x es 1.1.18.

Después de una instalación limpia, `npm audit --omit=dev` informó 3 nodos: 0 críticos, 1 alto, 2 moderados y 0 bajos. La auditoría completa informó 47: 0 críticos, 20 altos, 24 moderados y 3 bajos. La variación de severidades de la auditoría completa refleja la propagación y reclasificación de nodos padres que hace npm; no representa 47 vulnerabilidades raíz independientes.

Desaparecieron de ambas auditorías `GHSA-3jxr-9vmj-r5cp`, `GHSA-mh99-v99m-4gvg` y `GHSA-rgw5-rvv9-x895`. En producción permanecen únicamente xlsx/SheetJS con dos avisos altos y ExcelJS/uuid con el aviso moderado de uuid, contado también en el nodo padre ExcelJS. La auditoría completa conserva además hallazgos de tooling y build fuera del alcance de este lote.

El bundle SSR de Excel continúa incluyendo código desde `node_modules/brace-expansion` y `node_modules/readdir-glob/node_modules/brace-expansion`; el lockfile resuelve esas rutas a 1.1.18 y 2.1.4, respectivamente. La rama 5.0.9 es exclusiva del tooling de desarrollo y no aparece en el artefacto productivo.

Pasaron `npm ci`, ESLint, TypeScript, 23/23 pruebas unitarias, todas las integraciones de API, concurrencia, migración, Facturas, Inventario y exportación, el build y el validador del artefacto Sites. La regresión Excel generó y reabrió el archivo, conservó las tres hojas, encabezados, códigos como texto, monedas, fechas, caracteres españoles, filtros y formato condicional. El smoke test de interfaz cubrió Calculadora, Productos, Inventario, No inventario, Facturas, Historial e Importar Excel; una hoja sintética se leyó y mapeó sin confirmar la importación ni modificar datos.

No se cambió código de importación o exportación, SheetJS, ExcelJS, uuid, D1, R2, bindings, migraciones, infraestructura, autenticación ni OpenAI. No hubo llamadas pagadas; `CHATGPT_IMPORT` conserva `api_calls = 0` y `api_cost = 0`. `docs/BACKUP_RESTORE.md` permanece intacto y el backup integral D1 + R2 continúa formalmente **BLOQUEADO** por las limitaciones actuales de Sites.

### Lote 2B — SheetJS e importación segura (2026-08-20)

La línea base confirmada fue NutriPlus v2.14, checkpoint técnico 28 y commit `2c7615e4d6d9c51d52debedc63f19dd5b343cf0e`, con el repositorio limpio, Node 24.19.0 y npm 11.9.0. Antes del cambio, `npm audit --omit=dev` informó 3 nodos: 0 críticos, 1 alto, 2 moderados y 0 bajos. El nodo alto era `xlsx@0.18.5` y agrupaba `GHSA-4r6h-8v6p-xvw6` (prototype pollution, afectaba versiones anteriores a 0.19.3) y `GHSA-5pgg-2g8v-p4x9` (ReDoS, afectaba versiones anteriores a 0.20.2).

La documentación oficial de SheetJS confirmó que el registro público de npm quedó detenido en 0.18.5 y que el CDN de SheetJS es la fuente autoritativa. Se incorporó sin modificaciones SheetJS Community Edition 0.20.3 desde `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, versionado como `vendor/xlsx-0.20.3.tgz` e instalado mediante `file:`. El archivo tiene SHA-256 `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`, integridad npm `sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==` y licencia Apache 2.0. La atribución y ausencia de modificaciones se registraron en `THIRD_PARTY_NOTICES.md`; no existe descarga de SheetJS en tiempo de ejecución.

El flujo conserva `.xlsx`, `.xlsm`, `.xls` y `.csv`, el Web Worker, `XLSX.read`, `sheet_to_json`, el encabezado Producto, el mapeo actual, las filas completas/incompletas, la deduplicación normalizada que conserva la última aparición, precios, peso, cantidades, stock, códigos, jobs, historial, respaldos y la confirmación antes de escribir. Se priorizan exactamente `Compu` y `Solo Compu`; si un libro tiene varias hojas sin esos nombres se exige selección explícita.

Antes del parseo se aplican: archivo máximo 10 MiB; extensión y MIME coherentes; firma ZIP OOXML para XLSX/XLSM, OLE para XLS y texto para CSV; máximo 200 entradas ZIP; 50 MiB descomprimidos; razón de compresión máxima 100:1; rechazo de ZIP corrupto, cifrado, traversal, rutas absolutas, symlinks, ejecutables, nombres duplicados y estructuras solapadas. El parseo usa modo denso, `raw`, `cellFormula=false`, `cellHTML=false`, `bookVBA=false`, solo la hoja necesaria, máximo 10 hojas, 5.001 filas incluido encabezado, 64 columnas y timeout de Worker de 15 segundos con terminación, `onerror`, `onmessageerror` y validación estricta del mensaje. No se extraen archivos ZIP al sistema de archivos.

Los códigos almacenados como texto preservan ceros iniciales, longitudes, caracteres alfanuméricos y contenido español; los códigos numéricos usan el valor formateado cuando corresponde. Un número entero de más de 15 dígitos genera una advertencia por fila y bloquea la confirmación hasta que la persona usuaria declare haber revisado el archivo original. Las fórmulas no se exponen ni evalúan; solo puede usarse un valor almacenado seguro. Los macros no se cargan ni ejecutan.

Después de `npm ci`, `npm audit --omit=dev` informó 2 nodos: 0 críticos, 0 altos, 2 moderados y 0 bajos, correspondientes exclusivamente a ExcelJS/uuid. Ambos avisos de SheetJS desaparecieron. La auditoría completa vigente informó 46 nodos: 0 críticos, 19 altos, 24 moderados y 3 bajos; pertenecen a tooling/desarrollo y a ExcelJS/uuid fuera del alcance de este lote. La cifra se documenta tal como la agrupó npm y no representa 46 raíces independientes.

Pasaron ESLint, TypeScript, 36/36 pruebas unitarias, la prueba del Worker de producción, integraciones de migración, API, concurrencia, Facturas e Inventario, el build y el validador del artefacto Sites. Los fixtures sintéticos cubren formatos válidos, hojas `Compu`/`Solo Compu`, selección múltiple, archivos vacíos/dañados/disfrazados, ZIP anómalos, límites, fórmulas, español, códigos y exactamente 5.000 productos. La exportación ExcelJS 4.4.0 generó y reabrió las tres hojas con encabezados, códigos de barras como texto, monedas, fechas, caracteres españoles, filtros y formato condicional. El artefacto no contiene `xlsx@0.18.5`; el Worker incluye la versión corregida 0.20.3.

No se modificaron ExcelJS 4.4.0, uuid 8.3.2, D1, R2, bindings, migraciones, infraestructura, autenticación, Facturas, Inventario, Pedidos, CRM, Ventas/Gastos, Poket ni OpenAI. No hubo llamadas pagadas; `CHATGPT_IMPORT` conserva `api_calls = 0` y `api_cost = 0`. `docs/BACKUP_RESTORE.md` permanece intacto y el backup integral D1 + R2 continúa formalmente **BLOQUEADO** por las limitaciones actuales de Sites.

## Pedidos — Fase 1 local (2026-08-20)

La base técnica de Pedidos se desarrolló en `feature/orders-phase-1`, creada directamente desde el `main` productivo `1921a68cf28fa6f6201216de04c1c946456be4d6` (NutriPlus v2.15, checkpoint 29). La rama local `security/phase-3b1` y su commit `ccf0837574f0c9a66414a8c72fabb0db7e1d30f2` permanecieron intactos; no se mezcló Seguridad 3B1/3B2.

La migración aditiva `0015_quiet_anthem.sql` agrega Pedidos, líneas, operaciones idempotentes, eventos, pagos, referencias externas, rutas, devoluciones y entregas normalizadas. `inventory_movements` recibe únicamente referencias opcionales a pedido/línea y tipo de movimiento, preservando todas las filas y flujos históricos. Restricciones y claves foráneas viven en la migración; los triggers se instalan como sentencias preparadas individuales desde `ensureDatabase()`, siguiendo el patrón compatible con Sites ya usado por `0014`. Juntos protegen estados, montos, cantidades, historial append-only y saldo de inventario no negativo. La migración se validó desde una base representativa del esquema anterior y no se aplicó a D1 productivo.

El dominio usa números NP mediante secuencia autoincremental, IDs nativos de Web Crypto, importes CRC enteros, fecha civil de Costa Rica, `operationId` con respuesta repetible y `orders.version` para concurrencia optimista. Confirmar descuenta una sola vez; editar un pedido comprometido aplica solo el delta; cancelar restaura; preparar, entregar y reprogramar no mueven inventario. Pagos y devoluciones son ledgers auditables. Las entregas parciales futuras se normalizan en cabecera/líneas separadas del pedido.

La instalación limpia mediante el wrapper del proyecto, que ejecuta un único `npm ci` con caché aislada, pasó. También pasaron ESLint, TypeScript, 36/36 pruebas unitarias, pruebas de migración `0014` y `0015`, las 25 invariantes de Pedidos, concurrencia, APIs, Facturas, Inventario, importación, exportación Excel/PDF, build y validador del artefacto Sites. El build conserva el aviso conocido de chunks mayores de 500 kB, sin error. `npm audit --omit=dev` informó 2 nodos: 0 críticos, 0 altos, 2 moderados y 0 bajos (`exceljs` y `uuid`), sin cambios de dependencias en esta fase.

La Fase 1 no incluye interfaz ni publicación. No hubo merge a `main`, push, checkpoint, deploy, cambio de versión, escritura D1/R2 productiva ni llamadas a OpenAI. `CHATGPT_IMPORT` conserva cero llamadas/costo. Las APIs de Pedidos requieren policies propias cuando se retome autorización interna; actualmente solo existe la protección externa privada de Sites. `docs/BACKUP_RESTORE.md` quedó intacto y el backup integral D1+R2 continúa formalmente **BLOQUEADO**.

### Uso y peso

- No se identificó una dependencia directa claramente eliminable sin análisis funcional adicional.
- SheetJS se usa para importar hojas; ExcelJS y PDF-lib para exportar; PDF.js/Tesseract para facturas; ZXing para códigos; Drizzle para D1.
- Los paquetes `@tesseract.js-data/*` no aparecen como imports TypeScript porque los datos entrenados están servidos bajo `public/ocr/`; se debe confirmar en una futura tarea si siguen siendo necesarios durante instalación.
- `public/ocr/` ocupa aproximadamente 50 MB e incluye varios cores WASM para compatibilidad. Conviene medir qué variantes cargan los navegadores soportados antes de reducirlo.

## Logs y datos sensibles

- Pedidos agrega un único `console.error` redactado para fallos inesperados: registra código estable, referencia opaca y nombre de excepción, pero no mensaje, SQL, request, PII, headers ni secretos. No hay otros `console.*` propios en `app/`, `lib/`, `db/` o `worker/`.
- Las pruebas usan claves ficticias construidas en tiempo de ejecución.
- Los archivos originales y resultados de análisis pueden contener datos personales, pedido, tracking y envío; deben tratarse como sensibles.
- La política permanente de logging quedó en `SECURITY.md`.

## Autenticación

`app/chatgpt-auth.ts` contiene helpers correctos para identidad opcional/obligatoria y retorno seguro, pero está desconectado del flujo actual. No debe eliminarse como código muerto sin decidir primero el modelo de acceso.

La protección real es la política de Sites. `request-user.ts` atribuye acciones por headers, pero una etiqueta de auditoría no autoriza la operación. No se inventaron roles.

## Backups y recuperación

- Existe snapshot completo de `products` antes de importar/eliminar y una restauración que toma otro snapshot preventivo.
- Existen jobs reanudables, recibos idempotentes y reversa de movimientos.
- La exportación Excel/PDF no es un backup restaurable.
- Los checkpoints preservan código, no datos.
- No existe un procedimiento integral y probado para todas las tablas D1 y objetos R2.
- La revisión del 2026-08-20 confirmó que los recursos son administrados exclusivamente por ChatGPT Sites. La plataforma solo expone lectura acotada de D1 y no ofrece exportación integral de D1, listado administrativo de R2 ni escritura hacia destinos aislados. El simulacro D1 + R2 queda formalmente bloqueado hasta que Sites ofrezca esas capacidades o se autorice otra infraestructura; no se realizó ninguna migración.

## Prioridades para una auditoría posterior

1. **Alta, bloqueada por Sites:** plan y simulacro de recuperación D1/R2 cuando exista exportación integral o infraestructura autorizada.
2. **Completada para SheetJS:** el lote 2B corrigió `xlsx` y endureció la importación; ExcelJS/uuid permanecen separados y pendientes de una decisión específica.
3. **Alta antes de nuevos usuarios:** autorización por servidor y roles.
4. **Media:** magic bytes para cargas normales y mensajes de error públicos.
5. **Media:** una sola estrategia de migración y evaluación de claves foráneas.
6. **Media:** dividir componentes gigantes en cambios pequeños cubiertos por tests.
7. **Baja:** optimizar activos OCR y formalizar contratos de DTOs.
