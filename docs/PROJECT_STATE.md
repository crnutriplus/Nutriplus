# NutriPlus — Current State

## Production

- Version: v2.20
- Checkpoint: 40
- Commit: `3b769a70e4a94af9e38341bae06d534641f2d0fb`
- Deployment: `appgdep_6a8a0efb0d548191aa6d81940d73cf8f`
- URL: https://nutriplus-precios.ever1822.chatgpt.site/
- Last production migration: `0016_round_scarlet_witch.sql`
- Access mode: private/custom; one owner/admin, no external visitors

## Current development

- NutriPlus v2.20 is published. The persistent App Shell preserves each main section, uses real SPA history for Atrás, and keeps the bottom navigation visible without the floating Notifications launcher.

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
