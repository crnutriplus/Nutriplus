# NutriPlus

NutriPlus es una aplicación privada para calcular precios, administrar productos e inventario y registrar ingresos a partir de facturas. La versión pública vigente se define en `lib/public-version.ts`; es independiente del checkpoint de Sites y del commit de Git.

## Estado funcional actual

Funciones implementadas y comprobadas en el código:

- calculadora de precios en CRC a partir de costo, peso y ajustes comerciales;
- catálogo de Productos y lista separada de No inventario;
- búsqueda, códigos, escaneo, existencias, stock mínimo y alertas de abastecimiento;
- altas, edición, eliminación individual o masiva, concurrencia y cola sin conexión;
- importación de inventario desde Excel, historial y respaldo previo de productos;
- exportación del inventario a Excel y PDF;
- ingreso de inventario por factura en tres modalidades: Automático con IA, Manual e Importar análisis de ChatGPT;
- revisión, deduplicación, borradores, cierre no destructivo, omisión reversible de líneas, confirmación explícita, movimientos, reversa y reingreso por saldo neto;
- historial de análisis de facturas y control estimado de consumo de OpenAI.

No existen todavía módulos funcionales de Pedidos, CRM, Poket, portal de clientes, WhatsApp ni agente comercial. Que alguno figure en una herramienta de planificación no lo convierte en parte de esta aplicación.

## Arquitectura actual

| Capa | Implementación |
|---|---|
| Interfaz | React 19, TypeScript y App Router compatible con Next mediante Vinext |
| Servidor | Route Handlers bajo `app/api/`, ejecutados por un Cloudflare Worker |
| Persistencia | Cloudflare D1 (SQLite), Drizzle ORM y migraciones SQL |
| Archivos | Cloudflare R2 para los PDF e imágenes originales de facturas |
| Procesamiento local | PDF.js, Tesseract.js, ZXing, SheetJS, ExcelJS y PDF-lib |
| Servicio externo | OpenAI Responses API, solo en el modo automático de facturas y cuando está habilitado |
| Publicación | ChatGPT Sites, configurado mediante `.openai/hosting.json` |

El Worker recibe los bindings `DB` y `BUCKET`, además de la configuración opcional de OpenAI, y los expone únicamente al código de servidor. Los componentes de interfaz consumen los endpoints internos; no reciben la clave de OpenAI.

Más detalle en:

- [Arquitectura](docs/ARCHITECTURE.md)
- [Modelo de datos](docs/DATA_MODEL.md)
- [Ambientes y variables](docs/ENVIRONMENT.md)
- [Pruebas](docs/TESTING.md)
- [Despliegue](docs/DEPLOYMENT.md)
- [Respaldos y recuperación](docs/BACKUP_RESTORE.md)
- [Auditoría técnica](docs/TECHNICAL_AUDIT.md)
- [Seguridad](SECURITY.md)
- [Historial de versiones](CHANGELOG.md)

## Estructura del repositorio

```text
app/                 interfaz, estilos y Route Handlers
db/                  esquema Drizzle y acceso/inicialización de D1
drizzle/             migraciones SQL y snapshots históricos
lib/                 reglas de precios, facturas, importación, exportación y persistencia
public/              PWA, logo y activos locales de PDF/OCR
scripts/             instalación, build y validación para Sites
tests/               pruebas unitarias y de integración
worker/              entrada del Cloudflare Worker y bindings de servidor
.openai/hosting.json proyecto de Sites y nombres lógicos de D1/R2
```

## Requisitos e instalación

- Node.js `>=22.13.0`;
- Linux con `flock`, `curl` y GNU `timeout` para los scripts de ciclo de vida de Sites;
- bindings locales compatibles con Cloudflare para las funciones que usan D1 o R2.

Instalación reproducible desde el lockfile:

```bash
npm run install:ci
```

El helper usa rutas de caché temporales dentro del proyecto, evita instalaciones concurrentes y valida la integridad del tarball de Vinext fijado en `package-lock.json`. `.sites-runtime/` y `.wrangler/` son temporales y están ignorados por Git.

## Desarrollo y calidad

```bash
npm run dev               # servidor local Vinext/Vite
npm run lint              # ESLint
npx tsc --noEmit          # TypeScript estricto
npm test                  # build y suite principal
npm run build             # build limitado en tiempo y validación del artefacto
npm run validate:artifact # valida un artefacto ya generado
```

Las pruebas adicionales que necesitan archivos reales están explicadas en [docs/TESTING.md](docs/TESTING.md). Ninguna prueba debe hacer llamadas pagadas a OpenAI sin autorización expresa; se usan fixtures y dobles de `fetch` cuando es posible.

## Variables y secretos

Los nombres de configuración de servidor que utiliza el código son:

- `OPENAI_API_KEY`: secreto de servidor; nunca debe llegar al navegador ni a Git;
- `INVOICE_AI_ENABLED`: habilita las llamadas automáticas cuando tiene un valor verdadero;
- `INVOICE_AI_MODEL`: modelo principal; el código usa `gpt-5.6-terra` si falta;
- `INVOICE_AI_MONTHLY_LIMIT_USD`: límite mensual estimado; el valor predeterminado es `5`;
- `DB`: binding lógico de Cloudflare D1;
- `BUCKET`: binding lógico de Cloudflare R2.

No se documentan valores de secretos. Consulte [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) antes de configurar un ambiente.

## Facturas

- **Automático con IA:** conserva la factura completa, usa Responses API con Structured Outputs, registra modelo/uso/costo y cae a Manual ante un fallo.
- **Manual:** no llama a OpenAI; permite completar o revisar las líneas localmente.
- **Importar análisis de ChatGPT:** recibe un ZIP con `analysis.json` y exactamente una factura, valida su estructura y SHA-256, registra `api_calls = 0` y `api_cost = 0`, y crea un borrador. El inventario cambia únicamente después de **Confirmar ingreso**.

El historial se organiza por factura y conserva todas sus líneas. Para cada una se calcula `cantidad activa = suma neta de movimientos completados` y `cantidad disponible = max(0, cantidad original − cantidad activa)`. Cerrar la vista no borra el documento; una línea original puede omitirse y reactivarse, pero no eliminarse de forma normal.

## Base de datos, respaldos y despliegue

El esquema está en `db/schema.ts`, las migraciones históricas en `drizzle/` y el acceso a D1 en `db/index.ts`. No se deben editar ni borrar migraciones ya aplicadas.

Los respaldos actuales cubren snapshots de la tabla de productos antes de importaciones o eliminaciones masivas. No constituyen un respaldo integral de D1 ni de R2. Consulte [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) antes de una recuperación.

La publicación se realiza con el ciclo de vida de ChatGPT Sites, no con un `wrangler deploy` manual. El procedimiento y la verificación están en [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
