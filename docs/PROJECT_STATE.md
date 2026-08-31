# NutriPlus — Current State

## Production

- Version: v2.27
- Checkpoint: 48
- Commit: `ef89f1e6da529be31a0a89973c112c6a8a1b54fb`
- Deployment: `appgdep_6a95f2e67ea081918d6e3db16d010cd9`
- URL: https://nutriplus-precios.ever1822.chatgpt.site/
- Last production migration: `0017_equal_microchip.sql`
- Access mode: private/custom; one owner/admin, no external visitors

## Current development

- v2.27 está publicada como hotfix de Facturas/Inventario/Web Push: identidad canónica de producto y código, resolución de línea reanudada por ID o `lineKey`, persistencia idempotente sin duplicados, presentación comercial normalizada y deep links tipados con cola `READY/ACK`.
- No incluye migraciones, `0018_messy_nemesis.sql`, tablas/endpoints/UI de Clientes o CRM. El trabajo de CRM no está presente en este checkout y no se reconstruye en esta release.

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
- Los nuevos toques de deep link tipados de v2.27 requieren validación física del propietario en Android/PWA después de publicar.
