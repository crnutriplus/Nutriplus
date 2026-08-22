# NutriPlus — Current State

## Production

- Version: v2.17
- Checkpoint: 34
- Commit: `8daedfe9be5e6de390e6507ad3de0974ea2defd2`
- Deployment: `appgdep_6a89ab75a3988191bce25ed48f491613`
- URL: https://nutriplus-precios.ever1822.chatgpt.site/
- Last production migration: `0016_round_scarlet_witch.sql`
- Access mode: private/custom; one owner/admin, no external visitors

## Current development

- Notifications are published in v2.17. Alertas internas funcionan; la entrega Web Push está bloqueada por el transporte saliente actual de Sites hacia FCM.

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
- Android/PWA closed-app push remains pending hasta que Sites permita entrega HTTPS saliente al push service o se autorice una infraestructura externa segura.
