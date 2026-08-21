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

La navegación principal implementada es Calcular, Productos, Importar y Ajustes. Facturas se abre desde **Agregar inventario** en Productos. Pedidos dispone de base de datos, dominio y API en la rama local `feature/orders-phase-1`; su base incluye expectativa de pago y Encargos normalizados, pero todavía no tiene interfaz en este punto de la secuencia. No hay módulos de CRM, Poket, clientes o WhatsApp.

### API y servidor

Los 42 Route Handlers de `app/api/` gestionan:

- productos, cantidades, abastecimiento y eliminaciones;
- No inventario y traslado a inventario;
- ajustes y elementos recientes;
- importaciones masivas, progreso, historial y restauración;
- documentos de inventario, archivos, análisis, revisión, confirmación, cancelación y reversa;
- importación de paquetes ChatGPT y búsqueda de códigos;
- borradores, confirmación, preparación, entrega, cancelación, reapertura, reprogramación, pagos, devoluciones e historial de Pedidos;
- estados de proveedor y resolución idempotente de recepciones de Encargos mediante entrada inmediata o vínculo con inventario previamente ingresado;
- creación/listado de rutas de entrega y asignación ordenada de pedidos.

`worker/index.ts` es la entrada de Cloudflare. Inyecta D1, R2 y la configuración de IA en variables globales del runtime de servidor antes de delegar en Vinext. No existe un backend independiente ni una API pública separada.

### Datos y archivos

- `db/schema.ts`: definición Drizzle de las tablas.
- `db/index.ts`: acceso a D1 y compatibilidad/inicialización en tiempo de ejecución.
- `drizzle/`: 16 migraciones (`0000` a `0015`) y snapshots; `0015` es aditiva y permanece sin aplicar a producción durante Pedidos Fase 1.
- `lib/invoice-storage.ts`: validación básica, hash y persistencia de facturas en R2.
- `.openai/hosting.json`: bindings lógicos `DB` y `BUCKET` del proyecto de Sites.

Los detalles están en [DATA_MODEL.md](DATA_MODEL.md).

### Servicios externos

OpenAI Responses API se usa exclusivamente en el análisis automático de facturas cuando `INVOICE_AI_ENABLED` está habilitado. El servidor envía el documento completo en el mecanismo admitido por la API, usa Structured Outputs y puede habilitar búsqueda web. La clave no llega al frontend.

El modo Manual y `CHATGPT_IMPORT` no llaman a OpenAI. `CHATGPT_IMPORT` verifica el paquete y crea el mismo tipo de borrador que se revisa antes de confirmar.

### Historial y cierre de factura

La vista principal del historial se construye desde `inventory_documents`, agrega sus líneas originales y anida los movimientos completados. `processed_operation_id` se conserva como referencia histórica, pero no decide por sí solo si una línea está disponible.

Cerrar una factura limpia únicamente el estado React del modal. El documento, sus líneas, análisis, archivos y movimientos continúan en D1/R2. Las líneas originales se omiten mediante `status='ignored'` y `action='ignore'`; solo una línea adicional `manual-*` sin movimientos puede borrarse.

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
7. La disponibilidad se deriva de la suma neta de movimientos de cada línea; una reversa conserva auditoría y vuelve a habilitar el saldo neutralizado.

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

### Pedidos — base técnica local

La Fase 1 separa cabecera, líneas, pagos, eventos, devoluciones, entregas y rutas. Un pedido empieza como `DRAFT` y no mueve inventario. `CONFIRMED` descuenta stock mediante `inventory_movements`; una edición confirmada aplica únicamente el delta y una cancelación desde `CONFIRMED` o `PREPARED` restaura el compromiso vigente. `PREPARED` y `DELIVERED` no vuelven a descontar.

Las mutaciones sensibles usan `operationId` con respuesta persistida, y `orders.version` evita sobrescrituras obsoletas. La asignación `NP-000001`, `NP-000002`, etc. usa una secuencia autoincremental en la misma transacción lógica, sin `MAX()+1`. Los importes CRC son enteros y las fechas operativas son valores `YYYY-MM-DD` de Costa Rica, no instantes UTC.

La entrega futura parcial se modela mediante `order_fulfillments` y `order_fulfillment_lines`: el pedido, sus entregas y una venta futura permanecen conceptos distintos. En Fase 1, entregar registra todas las cantidades pendientes. La especificación completa está en [ORDERS.md](ORDERS.md).

## Autenticación y permisos

La protección efectiva actual es la política de acceso de Sites. `app/chatgpt-auth.ts` contiene helpers opcionales de Sign in with ChatGPT, pero no está conectado a las páginas ni a los endpoints. No hay roles propios.

Esto es suficiente solo mientras la política de plataforma mantenga el sitio restringido. La apertura a empleados o clientes requiere autorización de servidor antes de exponer más usuarios. Las APIs locales de Pedidos deberán recibir policies propias cuando se retome la rama `security/phase-3b1`; esa rama no se mezcló con Pedidos.

## Estado de mantenibilidad

### Correcto

- límites claros entre persistencia D1, archivos R2 y consumo OpenAI;
- funciones de negocio reutilizables bajo `lib/`;
- migraciones históricas y pruebas de integración;
- deduplicación, idempotencia, concurrencia y reversa explícitas;
- ningún ciclo detectado por el análisis estático de imports entre 58 archivos TypeScript/TSX.

### Mejora recomendada

- dividir `app/client-app.tsx` (1.909 líneas) por vistas y dominios;
- dividir `app/inventory-intake.tsx` (1.546 líneas) por selector, carga, revisión e historial;
- separar orquestación y presentación en el endpoint de confirmación de factura;
- definir contratos compartidos de API para reducir tipos duplicados entre frontend y servidor.

### Problema importante

- `db/index.ts` mantiene una segunda representación del esquema mediante `CREATE TABLE` y `ALTER TABLE` además de Drizzle/migraciones. Esta compatibilidad puede desviarse del esquema fuente.
- Las tablas históricas conservan relaciones lógicas sin `FOREIGN KEY`; el dominio nuevo de Pedidos sí declara claves foráneas y restricciones graduales, sin alterar las tablas históricas.
- La autorización de endpoints depende de la política externa de Sites y no soporta roles propios.

No se cambió ninguno de estos puntos en la auditoría documental para evitar una reorganización o migración riesgosa.
