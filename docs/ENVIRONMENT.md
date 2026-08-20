# Ambientes y configuración

## Ambientes

### Desarrollo local

`npm run dev` inicia Vite/Vinext con el Cloudflare Vite plugin. `vite.config.ts` crea bindings locales con los mismos nombres lógicos del deployment y mantiene el estado de Wrangler/Miniflare dentro del proyecto.

Los archivos `.env*` están ignorados por Git. Use únicamente el mecanismo local soportado por el runtime de Cloudflare/Sites y no copie secretos a archivos versionados.

### Build y pruebas

Los scripts pasan por `scripts/sites-env.sh` para obtener rutas de home, caché y temporales escribibles. `scripts/build-verified.sh` limita el build en tiempo y valida el artefacto generado.

Las pruebas de IA usan un `fetch` inyectado o la deshabilitan. No deben depender de una clave real.

### Producción

ChatGPT Sites ejecuta el Worker de `worker/index.ts`, conecta los recursos declarados en `.openai/hosting.json` y administra la política de acceso. No se versionan IDs físicos de D1/R2 ni valores de secretos en la configuración de la aplicación.

## Bindings y variables de aplicación

| Nombre | Tipo | Requerido | Uso y valor predeterminado |
|---|---|---:|---|
| `DB` | Binding D1 | Sí | Base de datos operativa. Declarado lógicamente en `.openai/hosting.json`. |
| `BUCKET` | Binding R2 | Sí para facturas | Originales PDF/imágenes. Declarado lógicamente en `.openai/hosting.json`. |
| `OPENAI_API_KEY` | Secreto de servidor | Solo para IA automática | Autorización de Responses API. Sin valor predeterminado. Nunca se expone al frontend. |
| `INVOICE_AI_ENABLED` | Variable de servidor | No | Solo `1`, `true`, `yes` u `on` (sin distinguir mayúsculas) habilitan la llamada. Si falta o es falso, no hay llamada. |
| `INVOICE_AI_MODEL` | Variable de servidor | No | Modelo automático. Predeterminado: `gpt-5.6-terra`. |
| `INVOICE_AI_MONTHLY_LIMIT_USD` | Variable de servidor | No | Tope mensual estimado; predeterminado `5`. Un valor inválido o negativo vuelve al predeterminado. |

El reanálisis administrativo con Sol usa la constante de servidor `gpt-5.6-sol` y requiere confirmación expresa en la interfaz. No es un fallback automático.

## Variables de herramientas

No son configuración funcional de NutriPlus:

| Nombre | Propósito |
|---|---|
| `CODEX_SANDBOX` | Ajusta el watcher de Vite en el sandbox. |
| `WRANGLER_WRITE_LOGS` | Control de logs de Wrangler; el proyecto lo deja deshabilitado por defecto. |
| `WRANGLER_LOG_PATH` | Ruta local de logs bajo `.wrangler/`. |
| `MINIFLARE_REGISTRY_PATH` | Registro local de Miniflare bajo `.wrangler/`. |
| `SITES_INSTALL_TIMEOUT`, `SITES_INSTALL_KILL_AFTER` | Límites controlados del instalador. |
| `SITES_BUILD_TIMEOUT`, `SITES_BUILD_KILL_AFTER` | Límites controlados del build. |

Variables usadas solo por pruebas opcionales:

- `NUTRIPLUS_CHATGPT_IMPORT_ZIP`;
- `NUTRIPLUS_IHERB_TEST_PDF`;
- `NUTRIPLUS_AMAZON_TEST_PDF`.

Son rutas locales a fixtures; no deben apuntar a archivos sensibles compartidos ni terminar en Git.

## Configuración segura

1. Mantener los secretos en el administrador de servidor/Sites.
2. Verificar solo presencia o estado; no imprimir valores en terminal, logs o respuestas.
3. Mantener nombres de variables idénticos en `cloudflare-env.d.ts`, `worker/index.ts` y la configuración del ambiente.
4. Probar primero con `INVOICE_AI_ENABLED=false` y mocks.
5. Habilitar IA únicamente después de verificar clave, modelo, límite y política de datos.
6. Al rotar una clave, actualizar el secreto de servidor y revocar el anterior; no cambiar el frontend.

## Diagnóstico sin exponer secretos

El endpoint de configuración de facturas devuelve únicamente valores seguros como habilitado/modelo/límite, no la clave. Si un ambiente falla:

- confirme que `DB` y `BUCKET` estén enlazados;
- confirme que la variable de IA tenga un valor válido;
- confirme solo que la clave exista, nunca su contenido;
- revise el estado del deployment y códigos de error redactados;
- no agregue `console.log(env)` ni devuelva el objeto de entorno al navegador.
