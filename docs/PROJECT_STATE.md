# NutriPlus — Current State

## Production

- Version: v2.28
- Checkpoint: 49
- Commit: `4a4f5bad66e6d22828bfaa5c8deba453b72d2c2f`
- Deployment: `appgdep_6a960f8e8cc48191910add3b61a6f5ee`
- URL: https://nutriplus-precios.ever1822.chatgpt.site/
- Last production migration: `0017_equal_microchip.sql`
- Access mode: private/custom; one owner/admin, no external visitors

## Current development

- v2.28 está publicada como hotfix de Facturas/Inventario: un SKU de proveedor huérfano se conserva como evidencia original y no bloquea un producto canónico vigente seleccionado; un SKU con dueño vigente distinto sigue bloqueado sin reasignación. Las referencias reanudadas a productos eliminados solo se recuperan por código canónico único.
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
