# NutriPlus — Current State

## Production

- Version: v2.18 (release correction pending deployment verification)
- Checkpoint: pending
- Commit: pending
- Deployment: pending
- URL: https://nutriplus-precios.ever1822.chatgpt.site/
- Last production migration: `0016_round_scarlet_witch.sql`
- Access mode: private/custom; one owner/admin, no external visitors

## Current development

- Notifications are published. La matriz productiva aisló `redirect: "error"` como causa del `TypeError`; v2.18 cambia el request completo a redirección manual segura. La aceptación final y el delivery se verificarán en producción.

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
- Android/PWA closed-app receipt and `notificationclick` remain pending user validation.
