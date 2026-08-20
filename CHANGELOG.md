# Historial de versiones de NutriPlus

NutriPlus mantiene dos identificadores independientes:

- **Versión pública:** se muestra a las personas usuarias y avanza como `2.3`, `2.4`, `2.5`, etc.
- **Checkpoint / commit / deployment:** identifica técnicamente un estado del código. Nunca es el número público de NutriPlus.

`package.json` usa SemVer, por lo que representa la versión pública `2.12` como `2.12.0`. El valor que controla la versión mostrada por la aplicación está en `lib/public-version.ts`.

## 2.12 — 2026-08-19

- La X de Facturas ahora cierra únicamente la factura activa y limpia su estado de interfaz; no borra el borrador, no revierte inventario y solo advierte cuando existen ediciones locales sin guardar.
- “Cambiar paquete” se normalizó como “Cambiar factura”. Cargar otra factura no elimina la anterior.
- Las líneas originales ya no se eliminan: pueden marcarse como Omitidas y reactivarse, conservando cantidad, identificadores y trazabilidad. Solo las líneas manuales sin movimientos mantienen eliminación explícita.
- La disponibilidad se calcula por cantidad neta: suma de ingresos menos reversas. Una reversa vuelve a habilitar únicamente el saldo disponible y permite `ingreso → reversa → reingreso` sin borrar movimientos.
- El índice único por línea de v2.11 se reemplazó mediante la migración `0014` por límites transaccionales de capacidad y saldo no negativo, manteniendo idempotencia por operación y protección frente a confirmaciones concurrentes.
- El estado de la factura se recalcula como borrador, revisión, parcial o procesada según cantidades activas, pendientes y omitidas, incluso para datos creados antes de esta versión.
- El historial principal ahora se agrupa factura por factura y muestra todas las líneas originales, cantidades de factura/activas/disponibles, omisiones, reversas y movimientos auditables.
- Las pruebas cubren cierre no destructivo, texto visible, omitir/reactivar, bloqueo de eliminación original, reingreso después de reversa, carrera concurrente, historial agrupado y recuperación `CHATGPT_IMPORT` con cero llamadas y costo cero.

## 2.11 — 2026-08-19

- La reimportación del mismo paquete `CHATGPT_IMPORT` recupera ahora el borrador existente en estado inicial, parcial o completado, sin crear otra factura ni llamar a OpenAI.
- Las líneas ya ingresadas permanecen visibles y bloqueadas; las pendientes pueden continuarse desde la revisión existente.
- Se reforzó la idempotencia por línea de factura mediante un índice único para movimientos de ingreso, sin afectar movimientos rápidos ni reversas.
- La recuperación puede restaurar la fila visual de una línea procesada a partir de su movimiento histórico cuando esa relación faltaba, sin alterar cantidades de inventario.
- Los errores de ZIP, estructura, JSON, esquema, versión, hash, totales, cantidades, códigos y persistencia muestran mensajes específicos, accionables y sin detalles sensibles.
- Se añadieron códigos internos estables, títulos en notificaciones y la regla permanente de mensajes de error y recuperación en `AGENTS.md`.
- Las pruebas cubren el ciclo de dos líneas `DRAFT → PARTIAL → COMPLETED`, reintentos, historial, archivos inválidos, cero movimientos duplicados, `api_calls = 0` y `api_cost = 0`.

## 2.10 — 2026-08-19

- Se auditó la arquitectura real, el modelo de datos, los ambientes, las pruebas, el deployment, los respaldos, la seguridad y las dependencias.
- Se reemplazó el README genérico por documentación específica de NutriPlus y se creó el manual permanente `AGENTS.md`.
- Se documentaron controles existentes, riesgos y prioridades futuras sin implementar cambios funcionales.
- Se confirmó en el código la existencia de Automático con IA, Manual e Importar análisis de ChatGPT.
- No se modificaron APIs, lógica de Facturas/Inventario/Productos, autenticación, OpenAI, esquema ni migraciones.

## 2.9 — 2026-08-19

- Se separó la versión pública de los checkpoints técnicos de Sites.
- Se normalizó el historial iniciado en `2.0`, `2.0.1` y `2.0.2` como `2.0`, `2.1` y `2.2`.
- Se añadió la versión pública visible y metadata verificable.
- No hubo cambios funcionales en Facturas, Inventario, Productos, Pedidos, CRM, pagos, autenticación, OpenAI ni base de datos.

## Correspondencia histórica comprobada

Un checkpoint guardado no prueba por sí solo que ese estado haya sido desplegado. La tabla conserva el identificador técnico sin presentarlo como versión pública.

| Checkpoint | Commit | Fecha | Identificación anterior | Cambio principal | Versión pública normalizada |
|---:|---|---|---|---|---:|
| 1 | `6ca0935` | 2026-08-07 | `0.1.0`, prueba privada | Preparación de prueba privada | Sin versión pública |
| 2 | `3bc2bc9` | 2026-08-07 | `1.0.0` | Primera versión de la calculadora | 1.0 |
| 3 | `3059683` | 2026-08-07 | `1.1.0` | Búsqueda rápida, teclado y gestión de productos | 1.1 |
| 4 | `2a56ad4` | 2026-08-07 | `1.2.0` | Teclado, escaneo, guardado y códigos | 1.2 |
| 5 | `efb7bcf` | 2026-08-08 | `1.3.0` | Inventario y exportaciones | 1.3 |
| 6 | `ec4c09b` | 2026-08-08 | `1.4.0` | Importaciones resilientes, alertas y escaneo seguro | 1.4 |
| 7 | `f21d40b` | 2026-08-09 | `1.5.0` | Catálogo, abastecimiento, códigos y procesos en segundo plano | 1.5 |
| 8 | `160cee5` | 2026-08-09 | `1.6.0` | Inventario seguro, uso sin conexión y exportaciones | 1.6 |
| 9 | `f8ef9a6` | 2026-08-11 | `1.7.0` | Códigos, No inventario y ajustes | 1.7 |
| 10 | `3cbf23d` | 2026-08-11 | `1.8.0` | Traslado de cotizaciones y recientes instantáneos | 1.8 |
| 11 | `949a78b` | 2026-08-11 | `1.8.0`, parche intermedio | Validaciones del traslado a inventario | Sin versión pública independiente |
| 12 | `83cc932` | 2026-08-11 | `1.9.0` | Concurrencia, operaciones masivas y auditoría | 1.9 |
| 13 | `b11198b` | 2026-08-11 | `2.0.0` / 2.0 | Ingreso por facturas e historial reversible | 2.0 |
| 14 | `92c87a9` | 2026-08-11 | `2.0.1` | Códigos por línea y validación transaccional | 2.1 |
| 15 | `53dfda8` | 2026-08-11 | `2.0.2` | Carga de facturas PDF y avisos de error | 2.2 |
| 16 | `44c596d` | 2026-08-12 | Seguía declarando `2.0.2` | Facturas con IA y modo Manual | 2.3 |
| 17 | `af6ed08` | 2026-08-12 | Seguía declarando `2.0.2` | Compatibilidad de migraciones D1 | 2.4 |
| 18 | `fff7f3f` | 2026-08-12 | Seguía declarando `2.0.2` | Estimaciones de consumo de OpenAI | 2.5 |
| 19 | `e2bf73c` | 2026-08-17 | Seguía declarando `2.0.2` | Recuperación de archivos en cargas duplicadas | 2.6 |
| 20 | `ec30d7a` | 2026-08-17 | Seguía declarando `2.0.2` | Terra por servidor, revisión segura e historial | 2.7 |
| 21 | `9045024` | 2026-08-19 | Seguía declarando `2.0.2` | Importación segura de análisis de ChatGPT | 2.8 |
| 22 | `2d91cc9` | 2026-08-19 | Primera versión visible normalizada | Separación de versión pública y checkpoint | 2.9 |

La evidencia disponible permite afirmar que el checkpoint 20 tuvo un deployment exitoso y que el 21 era la versión desplegada inmediatamente antes de esta normalización. Sites expone el historial completo de checkpoints guardados, pero no un listado histórico equivalente de todos los deployments; por eso no se atribuye un despliegue independiente a los demás checkpoints cuando no puede probarse. Los checkpoints 1 y 11 están identificados expresamente como prueba privada y parche intermedio, respectivamente, y no como publicaciones públicas independientes.

La publicación actual de este documento corresponde a NutriPlus **v2.12**. Su checkpoint y commit técnicos quedan registrados por Sites y Git al guardar la publicación; no se incrustan en el propio commit porque un commit no puede contener su propio hash.

## Regla futura

La próxima implementación publicada después de `2.12` será `2.13`, luego `2.14`, y así sucesivamente. No se usarán `2.0.3`, `2.0.4` ni números de checkpoint o deployment como versiones públicas.
