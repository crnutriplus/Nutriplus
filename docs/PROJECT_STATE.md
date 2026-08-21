# NutriPlus — Current State

## Production

- Version: v2.17
- Checkpoint: 32
- Commit: `ea59f40ab80695666782b45d1cc0df0c223c1554`
- Deployment: `appgdep_6a88bcfe30448191a9fce3de3dfba92a`
- URL: https://nutriplus-precios.ever1822.chatgpt.site/
- Last production migration: `0016_round_scarlet_witch.sql`
- Access mode: private/custom; one owner/admin, no external visitors

## Current development

- Notifications are published in v2.17; Android closed-app validation remains pending with the owner.

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
- Android/PWA closed-app push validation remains pending with the owner.
