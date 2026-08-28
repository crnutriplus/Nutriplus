# NutriPlus — Current State

## Production

- Version: v2.22
- Checkpoint: 42
- Commit: `57fa81be68a1962d70f41fb5173d4a688815d7cb`
- Deployment: `appgdep_6a91a344d5bc8191bb079cdc5f40f9e4`
- URL: https://nutriplus-precios.ever1822.chatgpt.site/
- Last production migration: `0016_round_scarlet_witch.sql`
- Access mode: private/custom; one owner/admin, no external visitors

## Current development

- NutriPlus v2.22 is published. La navegación fría sincroniza la sección persistida; Historial usa SQL compatible con D1; pedidos normales admiten abono inicial; Encargos separan llegada estimada de entrega, conservan líneas recibidas al editar y aparecen/reprograman en Entregas y Rutas mediante una única asignación activa. Consultar otra fecha de Ruta no muta asignaciones. Los recordatorios horarios con la app cerrada continúan bloqueados por falta de scheduler en Sites.

## Security

- Branch: `security/phase-3b1`
- Commit: `ccf0837574f0c9a66414a8c72fabb0db7e1d30f2`
- Status: local and separate; identity headers are not final authorization.
- Do not merge, cherry-pick or copy this work without a specific security task.

## External blockers

- Reliable internal identity and multi-user authorization in ChatGPT Sites.
- Complete, verified D1 + R2 backup and restore.

## Dependency audit

- Critical: 0
- High: 0
- Known moderate: 2 (`exceljs` / transitive `uuid`)

## Pending validation

- Orders v2.16 remains under real user validation.
- Web Push receipt with the Android/PWA closed was physically validated by the user.
