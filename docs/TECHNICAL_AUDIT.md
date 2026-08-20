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

### Resultado reproducido

`npm audit --omit=dev --json` informó 16 dependencias de producción afectadas: 15 altas, 1 moderada y 0 críticas. La auditoría completa informó 61: 49 altas, 9 moderadas, 3 bajas y 0 críticas.

Directas de producción que requieren revisión:

| Paquete | Versión | Hallazgo de `npm audit` | Prioridad |
|---|---:|---|---|
| `next` | 16.2.6 | Avisos altos/moderados para rangos anteriores a 16.2.11, más transitivos. El stack actual Vinext/Vite impide un fix automático. | Alta: probar actualización coordinada de Next/React/Vinext. |
| `xlsx` | 0.18.5 | Prototype pollution y ReDoS; npm no ofrece fix automático. Procesa hojas cargadas por personas usuarias. | Alta: evaluar versión mantenida/fuente oficial o reemplazo, con límites y tests. |
| `exceljs` | 4.4.0 | Transitivos afectados (`archiver`, `unzipper`, `uuid`); sin fix automático en el árbol actual. Se usa para exportar. | Media-alta: revisar upgrade/reemplazo y superficie realmente alcanzable. |

El árbol también contiene paquetes transitivos deprecados (`inflight`, `fstream`, `glob@7`, `rimraf@2`, `lodash.isequal`, `@esbuild-kit/*`, `uuid@8`). Provienen principalmente de ExcelJS y Drizzle Kit; no se deben actualizar aisladamente sin comprobar el paquete padre.

`npm outdated` confirmó que el stack tiene versiones posteriores disponibles, entre ellas Next 16.3.1, React 19.2.8, Vinext 1.0.0-beta.7, Vite 8.2.1 y Wrangler 4.124.0 al momento de la auditoría. No se hizo una actualización automática porque implica compatibilidad y cambios funcionales potenciales.

### Uso y peso

- No se identificó una dependencia directa claramente eliminable sin análisis funcional adicional.
- SheetJS se usa para importar hojas; ExcelJS y PDF-lib para exportar; PDF.js/Tesseract para facturas; ZXing para códigos; Drizzle para D1.
- Los paquetes `@tesseract.js-data/*` no aparecen como imports TypeScript porque los datos entrenados están servidos bajo `public/ocr/`; se debe confirmar en una futura tarea si siguen siendo necesarios durante instalación.
- `public/ocr/` ocupa aproximadamente 50 MB e incluye varios cores WASM para compatibilidad. Conviene medir qué variantes cargan los navegadores soportados antes de reducirlo.

## Logs y datos sensibles

- No se hallaron `console.*` en `app/`, `lib/`, `db/` o `worker/` fuera de los activos de terceros bajo `public/`.
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

1. **Alta:** plan y simulacro de recuperación D1/R2.
2. **Alta:** actualización coordinada de Next/React/Vinext y estrategia para `xlsx`.
3. **Alta antes de nuevos usuarios:** autorización por servidor y roles.
4. **Media:** magic bytes para cargas normales y mensajes de error públicos.
5. **Media:** una sola estrategia de migración y evaluación de claves foráneas.
6. **Media:** dividir componentes gigantes en cambios pequeños cubiertos por tests.
7. **Baja:** optimizar activos OCR y formalizar contratos de DTOs.
