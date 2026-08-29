# NutriPlus — Current State

## Production

- Version: v2.23
- Checkpoint: 44
- Commit: `f419675397ec0d0f75dc3830d5d6fafec973d9a4`
- Deployment: `appgdep_6a92da5cca8881918e1d660a4cc441d9`
- URL: https://nutriplus-precios.ever1822.chatgpt.site/
- Last production migration: `0017_equal_microchip.sql`
- Access mode: private/custom; one owner/admin, no external visitors

## Current development

- NutriPlus v2.23 is published. Finanzas v1 reconoce ventas solo al entregar, conserva costos históricos, separa caja/pagos de ventas, administra gastos, presupuestos y recurrencias explícitas, y exporta Excel/PDF. Importar vive en Ajustes > Datos y la barra principal incluye Finanzas. La salida usa CloseWatcher/Navigation API cuando están disponibles, sin centinelas ni crecimiento artificial del historial. Notifications/Web Push permanece intacto.

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
- Android/PWA physical validation remains pending for the new exit-confirmation path.
