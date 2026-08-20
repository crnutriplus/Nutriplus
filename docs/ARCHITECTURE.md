# Arquitectura de NutriPlus

## Resumen

NutriPlus es una aplicación full stack monolítica desplegada como Cloudflare Worker mediante ChatGPT Sites. Usa componentes React para la interfaz, Route Handlers para la API, D1 para los datos estructurados y R2 para archivos originales de facturas.

```text
Navegador/PWA
  ├─ interfaz React y procesamiento local de PDF/OCR/códigos/Excel
  └─ /api/*
       └─ Worker Vinext
            ├─ D1: datos operativos, auditoría y análisis
            ├─ R2: PDF e imágenes de facturas
            └─ OpenAI Responses API: solo modo automático habilitado
```

## Capas

### Interfaz

- `app/page.tsx` monta `NutriPlusApp`.
- `app/client-app.tsx` concentra navegación, calculadora, productos, importación, ajustes, trabajo sin conexión y modales.
- `app/inventory-intake.tsx` concentra el flujo de ingreso por factura.
- `app/globals.css` contiene los estilos globales.
- `public/sw.js` y `manifest.webmanifest` proporcionan capacidades PWA.
- PDF.js y Tesseract se cargan bajo demanda para lectura local; ZXing se usa para códigos.

La navegación principal implementada es Calcular, Productos, Importar y Ajustes. Facturas se abre desde **Agregar inventario** en Productos. No hay un directorio `components/` ni módulos de Pedidos, CRM, Poket, clientes o WhatsApp.

### API y servidor

Los 29 Route Handlers de `app/api/` gestionan:

- productos, cantidades, abastecimiento y eliminaciones;
- No inventario y traslado a inventario;
- ajustes y elementos recientes;
- importaciones masivas, progreso, historial y restauración;
- documentos de inventario, archivos, análisis, revisión, confirmación, cancelación y reversa;
- importación de paquetes ChatGPT y búsqueda de códigos.

`worker/index.ts` es la entrada de Cloudflare. Inyecta D1, R2 y la configuración de IA en variables globales del runtime de servidor antes de delegar en Vinext. No existe un backend independiente ni una API pública separada.

### Datos y archivos

- `db/schema.ts`: definición Drizzle de las tablas.
- `db/index.ts`: acceso a D1 y compatibilidad/inicialización en tiempo de ejecución.
- `drizzle/`: 13 migraciones históricas (`0000` a `0012`) y snapshots.
- `lib/invoice-storage.ts`: validación básica, hash y persistencia de facturas en R2.
- `.openai/hosting.json`: bindings lógicos `DB` y `BUCKET` del proyecto de Sites.

Los detalles están en [DATA_MODEL.md](DATA_MODEL.md).

### Servicios externos

OpenAI Responses API se usa exclusivamente en el análisis automático de facturas cuando `INVOICE_AI_ENABLED` está habilitado. El servidor envía el documento completo en el mecanismo admitido por la API, usa Structured Outputs y puede habilitar búsqueda web. La clave no llega al frontend.

El modo Manual y `CHATGPT_IMPORT` no llaman a OpenAI. `CHATGPT_IMPORT` verifica el paquete y crea el mismo tipo de borrador que se revisa antes de confirmar.

## Flujos principales

### Productos e inventario

1. La interfaz envía una mutación con identificador idempotente.
2. El Route Handler valida datos y concurrencia.
3. D1 guarda el producto o movimiento y un recibo/estado verificable.
4. La interfaz actualiza el estado o conserva la mutación para reintentar sin conexión.

Las importaciones Excel y eliminaciones masivas se modelan como jobs por filas, con claims para concurrencia. Antes de modificar productos se crea un snapshot del catálogo.

### Factura automática

1. El servidor valida límites, calcula SHA-256/huella y guarda originales en R2.
2. La huella evita analizar de nuevo el mismo conjunto.
3. Si la IA está habilitada, el servidor llama a Responses API y guarda un registro del análisis.
4. Se crea o actualiza un documento `draft`; un resultado inconsistente requiere revisión.
5. Un fallo técnico conserva factura y progreso y cambia a Manual.
6. Solo **Confirmar ingreso** crea la operación y movimientos de inventario.

### Factura manual

Guarda la factura y el borrador sin llamada a OpenAI. La persona puede completar líneas o usar lectura local de respaldo. La confirmación comparte el flujo transaccional del modo automático.

### Importación de análisis de ChatGPT

1. Acepta un ZIP con `analysis.json` y exactamente una factura.
2. Bloquea rutas, symlinks, ejecutables, cifrado no admitido y expansión excesiva.
3. Valida esquema `nutriplus.invoice_import`, versión `1.0`, origen, tipos, líneas, unidades, precios y totales recalculados.
4. Compara el SHA-256 de la factura con `source.sha256`.
5. Reutiliza deduplicación y almacenamiento actuales.
6. Guarda un análisis con origen `CHATGPT_IMPORT`, cero llamadas y costo cero.
7. Crea un borrador y exige revisión/confirmación antes de inventario.

## Autenticación y permisos

La protección efectiva actual es la política de acceso de Sites. `app/chatgpt-auth.ts` contiene helpers opcionales de Sign in with ChatGPT, pero no está conectado a las páginas ni a los endpoints. No hay roles propios.

Esto es suficiente solo mientras la política de plataforma mantenga el sitio restringido. La apertura a empleados o clientes requiere autorización de servidor antes de exponer más usuarios.

## Estado de mantenibilidad

### Correcto

- límites claros entre persistencia D1, archivos R2 y consumo OpenAI;
- funciones de negocio reutilizables bajo `lib/`;
- migraciones históricas y pruebas de integración;
- deduplicación, idempotencia, concurrencia y reversa explícitas;
- ningún ciclo detectado por el análisis estático de imports entre 58 archivos TypeScript/TSX.

### Mejora recomendada

- dividir `app/client-app.tsx` (1.909 líneas) por vistas y dominios;
- dividir `app/inventory-intake.tsx` (1.326 líneas) por selector, carga, revisión e historial;
- separar orquestación y presentación en el endpoint de confirmación de factura;
- definir contratos compartidos de API para reducir tipos duplicados entre frontend y servidor.

### Problema importante

- `db/index.ts` mantiene una segunda representación del esquema mediante `CREATE TABLE` y `ALTER TABLE` además de Drizzle/migraciones. Esta compatibilidad puede desviarse del esquema fuente.
- No hay restricciones `FOREIGN KEY` declaradas; las relaciones se preservan por lógica de aplicación.
- La autorización de endpoints depende de la política externa de Sites y no soporta roles propios.

No se cambió ninguno de estos puntos en la auditoría documental para evitar una reorganización o migración riesgosa.
