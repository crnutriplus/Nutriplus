# Seguridad de NutriPlus

Este documento describe los controles presentes y las reglas obligatorias para cambios futuros. No sustituye una auditoría de seguridad independiente.

## Modelo de acceso actual

El sitio publicado utiliza una política de acceso administrada por ChatGPT Sites y, al momento de esta auditoría, está restringido al propietario. La aplicación incluye helpers de Sign in with ChatGPT en `app/chatgpt-auth.ts`, pero las páginas y Route Handlers actuales no los invocan para autorizar cada operación.

No existe un sistema propio de roles (administración, empleados o clientes). Los endpoints dependen de la barrera de acceso de la plataforma; `lib/request-user.ts` usa encabezados de identidad confiables cuando están disponibles únicamente para atribuir acciones y aplica una etiqueta genérica si faltan.

Antes de ampliar el acceso a más personas o crear portales, se debe diseñar autorización de servidor por rol y recurso. Identidad no equivale a autorización.

## Secretos

- Guardar claves y credenciales solo como secretos o variables de servidor.
- Nunca guardar secretos en Git, documentos, fixtures, capturas, frontend, almacenamiento del navegador o respuestas de API.
- `OPENAI_API_KEY` se inyecta en el Worker y solo la consume el código de servidor.
- Nunca registrar claves, tokens bearer, cookies, encabezados de autenticación o URL con credenciales.
- No crear claves nuevas ni copiar valores existentes para pruebas si no es necesario.
- Poket, WhatsApp y cualquier integración futura deben usar credenciales separadas, de mínimo privilegio y rotables; este repositorio no define credenciales para servicios aún no implementados.

Los archivos `.env*`, PEM, logs y directorios temporales de Sites/Wrangler están ignorados por Git. Esto complementa, pero no reemplaza, la revisión del diff antes de cada commit.

## OpenAI

- Respetar `INVOICE_AI_ENABLED`; un valor falso impide llamadas automáticas.
- Mantener `OPENAI_API_KEY` fuera del navegador.
- Deduplicar por huella antes de consumir API.
- Usar fixtures o mocks para pruebas. Una llamada real pagada requiere autorización expresa.
- Registrar modelo, estado, tokens disponibles, búsquedas y costo estimado sin registrar el contenido completo de la factura.
- `CHATGPT_IMPORT` no debe acceder a la clave ni a Responses API; debe registrar cero llamadas y costo cero.

## Entradas y archivos no confiables

PDF, imágenes, JSON, ZIP y hojas de cálculo deben considerarse no confiables incluso si provienen de una persona autorizada. Validar en servidor cuando corresponda:

- límites de tamaño y cantidad;
- tipo permitido, extensión y firma real del contenido;
- nombres, rutas y caracteres inesperados;
- hash y correspondencia entre archivo y metadata;
- estructura, tipos, rangos, totales y campos obligatorios;
- traversal (`../`), rutas absolutas, symlinks, ejecutables, cifrado no admitido, compresión extrema y tamaño descomprimido.

La carga normal de facturas limita a 20 archivos, 20 MB por archivo y 45 MB por conjunto, calcula SHA-256 y almacena en claves R2 generadas. El importador de análisis de ChatGPT aplica además validación de firma, límites de ZIP, ruta segura, estructura exacta y correspondencia de hash.

Hallazgo pendiente: la carga normal determina actualmente PDF/imagen por MIME declarado o extensión antes de guardarlo, sin validar magic bytes. No se cambia en esta auditoría documental; debe corregirse en una tarea de seguridad con pruebas de compatibilidad.

## Validación de operaciones

- Validar entradas en el servidor; las restricciones de interfaz no son controles de seguridad.
- Mantener operaciones de inventario idempotentes, deduplicadas y auditables.
- No modificar inventario al cargar o analizar una factura: solo **Confirmar ingreso** puede hacerlo.
- Las reversas deben crear movimientos contrarios y conservar el registro original.
- No confiar en totales o bloques de validación aportados por un ZIP; recalcularlos.
- No ejecutar restauraciones sobre producción como prueba.

## Logging seguro

La aplicación no mantiene actualmente un sistema central de logs de negocio y el código de producción no contiene llamadas directas a `console.*`. Si se agregan logs:

- registrar evento, estado, identificador técnico opaco, duración y código de error;
- redactar email, nombres, direcciones, tracking, contenido de facturas y códigos cuando no sean indispensables;
- no registrar cuerpos completos, archivos, prompts, respuestas de IA, headers, cookies, claves ni tokens;
- separar mensajes seguros para el usuario de detalles internos de diagnóstico;
- definir retención y acceso antes de registrar datos personales.

Hallazgo pendiente: el helper general `errorResponse()` devuelve el mensaje original de algunas excepciones. Aunque muchos mensajes son controlados por la aplicación, un error de infraestructura podría revelar detalle interno. Se recomienda mapear errores a códigos y conservar el detalle solo en telemetría segura.

## Base de datos y almacenamiento

- No borrar ni reescribir migraciones aplicadas.
- Crear migraciones nuevas, preservando datos y trazabilidad.
- D1 contiene datos operativos y análisis; R2 conserva originales de facturas. Limitar acceso a ambos bindings al Worker.
- Los checkpoints de código no son respaldos de D1/R2.
- Los snapshots de importación cubren productos, no toda la base ni los objetos R2. Consulte `docs/BACKUP_RESTORE.md`.

## Dependencias

Ejecutar periódicamente `npm audit` y revisar cada actualización con pruebas. La auditoría del 2026-08-19 detectó avisos altos en dependencias de producción, incluidos Next, SheetJS (`xlsx`) y transitivos de ExcelJS. No se actualizaron en esta tarea para evitar un cambio funcional sin validación; el detalle y prioridad están en `docs/TECHNICAL_AUDIT.md`.

## Controles que no se deben debilitar

- política de acceso de Sites;
- secretos solo en servidor;
- límites y deduplicación de archivos;
- confirmación explícita antes de inventario;
- historial, recibos de mutación, control de concurrencia y reversas;
- límites de consumo y flag de IA;
- validación reforzada del ZIP de ChatGPT.

## Comunicación de hallazgos

No publique vulnerabilidades, datos de facturas ni credenciales en issues públicos. Informe el hallazgo al propietario del proyecto con pasos mínimos de reproducción y sin adjuntar datos personales innecesarios. Si un secreto aparece en un log o commit, deje de usarlo, revoque/rótelo en el proveedor y revise el historial afectado.
