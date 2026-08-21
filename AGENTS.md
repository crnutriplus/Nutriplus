# Reglas permanentes para agentes — NutriPlus

Aplican a todo el repositorio. La instrucción actual prevalece cuando sea más restrictiva.

## Inicio, fuente de verdad y alcance

Para una tarea normal:

1. leer `docs/PROJECT_STATE.md`;
2. verificar Git mínimamente (`status`, rama y commits recientes);
3. localizar el alcance con `rg`/`grep` y rangos concretos;
4. leer y modificar solo los archivos relacionados.

No reconstruir toda la historia del proyecto. Ampliar la verificación solo para releases, migraciones, seguridad, riesgo de datos, contradicciones, estado aparentemente desactualizado o petición expresa.

La fuente de verdad es código → esquema/migraciones → pruebas → aplicación publicada. Asana u otros planes no prueban implementación. Preservar cambios ajenos, evitar Git destructivo y no tocar módulos fuera del alcance.

## WORK EFFICIENCY — NUTRIPLUS

- Usar `PROJECT_STATE.md` como estado inicial; actualizarlo solo cuando cambie un dato allí registrado.
- Buscar antes de explorar; no leer archivos o documentos irrelevantes.
- No hacer refactors, limpiezas cosméticas ni alternativas completas no solicitadas.
- Reutilizar helpers, servicios, patrones y suites existentes; no crear infraestructura paralela.
- No usar web si código, docs o tests ya contienen la respuesta vigente.
- No repetir una verificación costosa si pasó y nada relacionado cambió.
- Con especificación cerrada, continuar implementación → pruebas → corrección sin pausas mecánicas.
- Detenerse ante decisiones nuevas de negocio, seguridad, riesgo de datos, contradicciones o cambios destructivos.
- No repetir la instrucción ni logs extensos en el reporte. Informar cambios, archivos, pruebas, commit y bloqueos; en release añadir versión, checkpoint, migración, deployment, regresión, audit y smoke test.
- No ejecutar `npm ci` si `node_modules`, `package.json`, `package-lock.json` y el entorno siguen vigentes. Sí usarlo en entorno limpio, cambio de dependencias o release reproducible.
- Reservar el build completo para puertas importantes, bundling/configuración, pruebas que consumen `dist` y releases.

## Invariantes de negocio

- Validar server-side toda operación sensible; el navegador nunca es autoridad.
- Inventario: cada cambio debe ser trazable mediante movimientos, transaccional, idempotente y concurrente; nunca permitir saldo activo negativo ni aplicar/restaurar unidades dos veces.
- Facturas: cerrar la interfaz no borra documento, borrador, progreso ni inventario. Las líneas originales se conservan y la omisión es reversible. La disponibilidad se deriva de la suma neta de movimientos completados; ingreso, reversa y reingreso legítimo coexisten. Ver `docs/INVENTORY_INTAKE.md` y `docs/DATA_MODEL.md`.
- Pedidos: validar estados, versión y stock en servidor. Confirmar descuenta exactamente una vez; cancelar/reabrir/corregir restaura o aplica solo el delta autorizado. Totales, devoluciones y entregas deben conservar historial e idempotencia. Ver `docs/ORDERS.md`.
- Dinero: importes CRC enteros y cálculos server-side. `order_payments` es el ledger real append-only; el método esperado de pago no representa dinero recibido ni puede fabricar pagos.
- Usar transacciones/guards/constraints para operaciones de inventario, pagos, facturas y pedidos; proteger retries, doble toque y carreras.
- Preservar compatibilidad con Productos, No inventario, Facturas, Inventario, Pedidos, importación/exportación, trabajo sin conexión, historial y reversas.

## Base de datos y migraciones

- Esquema en `db/schema.ts`; acceso/compatibilidad D1 en `db/index.ts`.
- No borrar ni modificar migraciones ya aplicadas. Crear una nueva migración aditiva, preservar datos y probar esquema, `ensureDatabase()`, índices, triggers y módulos afectados.
- No ejecutar mutaciones diagnósticas, restauraciones, D1/R2, bindings o infraestructura productiva sin autorización específica.

## Seguridad, datos y OpenAI

- Secretos exclusivamente server-side y fuera de Git, frontend, respuestas y logs. Nunca exponer keys, tokens, cookies, headers de autenticación, SQL, stack traces o rutas sensibles.
- No crear bypass, relajar acceso ni inventar identidad/roles. Mantener separada `security/phase-3b1` hasta instrucción expresa.
- Tratar PDF, imágenes, JSON, ZIP y hojas como entrada no confiable; validar tamaño, cantidad, firma/MIME, hash, rutas, contenido inesperado, traversal, symlinks, ejecutables y compresión abusiva según corresponda.
- Seguir `SECURITY.md`: logging mínimo, redactado y sin documentos o datos sensibles innecesarios.
- No hacer llamadas pagadas a OpenAI para pruebas. Usar fixtures/mocks; respetar `INVOICE_AI_ENABLED` y deduplicar antes del consumo. Una llamada real requiere autorización expresa.
- `CHATGPT_IMPORT` es independiente de OpenAI API y conserva `api_calls = 0` y `api_cost = 0`.

## Pruebas escalonadas

**Nivel 1 — desarrollo:** ejecutar primero el test afectado/nuevo y TypeScript/ESLint necesario; corregir y repetir ese control. `npm run check:fast` es la puerta rápida. No lanzar la suite completa tras cada cambio pequeño.

**Nivel 2 — módulo:** al terminar una unidad importante usar `check:orders`, `check:inventory` o `check:invoices`, además de consumidores directos indicados en `docs/TESTING.md`.

**Nivel 3 — release:** `npm run check:release` es obligatorio antes de release/merge productivo y para migraciones o cambios transversales de inventario, dinero o concurrencia. La eficiencia nunca reduce cobertura, E2E, secret scan, audit ni regresión productiva.

Si un control falla, corregir y repetir primero el afectado. No repetir una puerta completa que ya pasó si después solo cambió documentación sin impacto en ella.

## Publicación, versión y documentación

- Una tarea funcional normal continúa hasta pruebas, commit, checkpoint, deployment y verificación publicada, salvo prohibición o gate explícito. Una tarea local se detiene tras sus controles locales.
- Antes de publicar, verificar realidad Git/Sites, diff, migraciones, secretos y HIGH/CRITICAL. Después comprobar deployment terminal, versión visible y flujo afectado sin mutaciones destructivas.
- Versión pública en `lib/public-version.ts` y SemVer equivalente en `package.json`; checkpoint, deployment y commit son identificadores distintos. Actualizar `CHANGELOG.md` sin reescribir historia.
- Antes de cada release verificar la realidad y actualizar `docs/PROJECT_STATE.md`. No modificarlo por cambios triviales ni crear archivos paralelos de memoria/contexto.
- Actualizar documentación solo cuando cambie arquitectura, esquema, variables, seguridad, pruebas, despliegue o comportamiento real; no documentar planes como existentes.

## Errores comprensibles

Todo error visible usa: **PROBLEMA + CAUSA COMPRENSIBLE + QUÉ HACER + ESTADO DE LOS DATOS**. Diferenciar fallos recuperables/definitivos y explicar si algo quedó guardado o si nada cambió. Nunca mostrar detalles internos sensibles.
