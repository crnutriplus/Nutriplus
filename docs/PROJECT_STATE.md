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

- v2.24 está preparada para la puerta final: pago automático idempotente de facturas CHATGPT_IMPORT, descuentos/costos exactos, exclusión personal, montos CRC decimales, alta en línea de productos, retorno contextual de Finanzas/Ventas y PDF operativo de Ruta en blanco y negro. No añade migraciones ni modifica Notifications/Web Push.

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
