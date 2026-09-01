# NutriPlus — Current State

## Production

- Version: v2.29
- Checkpoint: 59
- Commit: `7d9578e0b8d2abbba484646aa6198868e8479334`
- Deployment: `appgdep_6a96b5cec4b48191864aa46b5362298f`
- URL: https://nutriplus-precios.ever1822.chatgpt.site/
- Last production migration: `0017_equal_microchip.sql`
- Access mode: private/custom; one owner/admin, no external visitors

## Current development

- v2.29 está publicada como hotfix de Facturas/Inventario: el reconocimiento financiero por línea compara el prefijo estructurado de `source_id` literalmente con `instr(...)=1`; D1 ya no ejecuta el `LIKE` que fallaba en Calmify. El ledger, reversas, reproceso y reintentos permanecen append-only e idempotentes.
- El endpoint temporal `/api/internal/inventory-finance-diagnostic` fue retirado antes de publicar. No se añadió migración, `0018_messy_nemesis.sql`, tablas/endpoints/UI de Clientes ni CRM; el trabajo de CRM no está presente en este checkout y no se reconstruye en esta release.

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
