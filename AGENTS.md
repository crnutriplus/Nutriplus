# Manual permanente para agentes de NutriPlus

Estas reglas se aplican a todo el repositorio. Las instrucciones explícitas de la tarea actual tienen prioridad cuando sean más restrictivas.

## 1. Fuente de verdad y diagnóstico previo

Antes de implementar o corregir:

1. inspeccionar el estado de Git, archivos modificados, commits recientes y documentación existente;
2. buscar el nombre de la función, rutas, tablas, flags, pruebas y componentes relacionados;
3. verificar si existe una implementación parcial, desconectada o no publicada;
4. reutilizar y completar el código existente antes de crear otro flujo;
5. evitar duplicaciones y eliminar solo código inequívocamente abandonado dentro del alcance.

Asana y otras herramientas de planificación no demuestran que una función esté implementada. La fuente de verdad, en este orden, es:

1. el código;
2. el esquema y las migraciones de base de datos;
3. las pruebas;
4. la aplicación publicada.

## 2. Alcance y compatibilidad

- No modificar módulos ajenos a la tarea salvo que sea imprescindible y quede explicado.
- No hacer refactors masivos por estética.
- Preservar compatibilidad con Facturas, Inventario, Productos, No inventario, importaciones, exportaciones, trabajo sin conexión, historial y reversas.
- No reconstruir un módulo que ya funciona ni crear una segunda implementación paralela.
- Conservar los cambios preexistentes de la persona usuaria y no usar operaciones destructivas de Git.
- Una implementación funcional no está terminada porque funcione solo localmente.

## 3. Regla de guardado y publicación

Cuando se solicite una implementación o corrección funcional, salvo indicación expresa en contrario, al terminar se debe:

1. guardar todos los cambios;
2. ejecutar lint;
3. ejecutar TypeScript;
4. ejecutar las pruebas relacionadas;
5. ejecutar build;
6. corregir errores y volver a ejecutar los controles afectados;
7. crear commit y checkpoint;
8. incrementar la versión pública según la regla vigente;
9. publicar/desplegar;
10. comprobar el deployment publicado;
11. verificar que la función aparezca y opere realmente allí;
12. informar versión pública, checkpoint, commit completo y resultados de pruebas.

No considerar terminada una implementación si no compila, falla TypeScript o lint, falla una prueba relacionada, falla el deployment o la función no aparece en producción. Una tarea que prohíba publicar debe detenerse después de las comprobaciones locales.

## 4. Versionado

- La versión pública vive en `lib/public-version.ts` y avanza `2.9 → 2.10 → 2.11 → 2.12`.
- `package.json` expresa la misma versión como SemVer (`2.10.0`, por ejemplo).
- No usar `2.9.1`, `2.9.2` ni el número de checkpoint/deployment como versión pública salvo instrucción expresa.
- Checkpoint, deployment y commit son identificadores técnicos independientes; usar siempre los valores realmente generados.
- Agregar una entrada a `CHANGELOG.md` sin borrar ni reescribir el historial reconstruido. Debe preservarse que `2.0.1` se normalizó a `2.1` y `2.0.2` a `2.2`.

## 5. Base de datos y migraciones

- El esquema fuente está en `db/schema.ts`; el acceso a D1 y la compatibilidad en tiempo de ejecución están en `db/index.ts`.
- No borrar migraciones históricas ni modificar una migración ya aplicada.
- Para un cambio de esquema, crear una migración nueva, preservar datos y documentar la transición.
- Revisar compatibilidad entre la nueva migración, el esquema Drizzle, `ensureDatabase()` y pruebas.
- No ejecutar restauraciones ni mutaciones diagnósticas sobre producción sin autorización específica.
- Mantener trazabilidad e idempotencia de operaciones de inventario.

## 6. Seguridad y datos

- Mantener secretos solo en servidor y fuera de Git. Nunca exponer `OPENAI_API_KEY`, tokens, cookies o credenciales al frontend, respuestas o logs.
- No crear bypass de acceso, desactivar controles de plataforma o relajar autenticación para facilitar pruebas.
- No confiar en datos del navegador; validar operaciones sensibles en el servidor.
- Tratar PDF, imágenes, JSON, ZIP y hojas de cálculo como entrada no confiable.
- Validar, según el formato, tamaño, cantidad, extensión, MIME real/firma, hash, nombres, rutas, contenido inesperado, traversal, symlinks, ejecutables y ZIP bombs.
- Sanitizar entradas y evitar conservar información sensible innecesaria.
- Seguir la política de logging de `SECURITY.md`: registrar contexto mínimo y nunca documentos completos ni encabezados de autenticación.
- Las futuras integraciones (Poket, WhatsApp u otras) deben usar secretos de servidor propios, mínimo privilegio y autorización explícita; no inventar credenciales ni contratos.

## 7. OpenAI y consumo

- No hacer llamadas pagadas reales solo para probar interfaz, validaciones, errores o facturas ya procesadas.
- Preferir fixtures, mocks, respuestas almacenadas y archivos previamente procesados.
- Respetar `INVOICE_AI_ENABLED`; si está deshabilitado, no se llama a OpenAI.
- Mantener la deduplicación antes de cualquier consumo automático.
- Una prueba con consumo real requiere autorización expresa para ese caso. Si falta, detenerse antes de llamar.
- La importación `CHATGPT_IMPORT` es independiente de OpenAI API y debe conservar `api_calls = 0` y `api_cost = 0`.

## 8. Calidad y documentación

Controles mínimos:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Ejecutar además las pruebas específicas del módulo. `npm test` ya incluye un build; un build explícito puede repetirse cuando la tarea o el diagnóstico lo exijan.

Actualizar README, documentación y CHANGELOG cuando cambien arquitectura, esquema, variables, seguridad, pruebas, despliegue o comportamiento público. No documentar funciones planeadas como existentes. No incluir secretos ni datos reales de clientes o facturas.

## 9. Verificación y entrega

Antes de publicar, revisar el diff para confirmar que no hay cambios accidentales, secretos ni artefactos temporales. Después de publicar:

- comprobar el estado terminal del deployment;
- comprobar la versión pública visible o su metadata en la URL publicada;
- verificar el flujo modificado sin hacer operaciones destructivas ni consumo no autorizado;
- informar con claridad pruebas ejecutadas, límites de la verificación y cualquier riesgo pendiente.
