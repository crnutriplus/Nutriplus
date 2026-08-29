# NutriPlus — Current State

## Production

- Version: v2.24
- Checkpoint: 45
- Commit: `d23aa47f36ca9a0ff011c1f06eb869442d7a1f8d`
- Deployment: `appgdep_6a930e8e0abc8191bbfe7762a40ecfc6`
- URL: https://nutriplus-precios.ever1822.chatgpt.site/
- Last production migration: `0017_equal_microchip.sql`
- Access mode: private/custom; one owner/admin, no external visitors

## Current development

- v2.25 está preparada para la puerta final: producto inline completo con escáner/cálculo, recuperación segura de pending huérfano, compra pagada visible en Caja con fecha de confirmación y PDF de Ruta sin Cliente. No añade migraciones ni modifica Notifications/Web Push.

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
