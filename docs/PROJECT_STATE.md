# NutriPlus — Current State

## Production

- Version: v2.19
- Checkpoint: 39
- Commit: `78178c986c0d04eaa87f5e06aadd1611d7e23899`
- Deployment: `appgdep_6a8a07768c108191b63467a01bb2f4bc`
- URL: https://nutriplus-precios.ever1822.chatgpt.site/
- Last production migration: `0016_round_scarlet_witch.sql`
- Access mode: private/custom; one owner/admin, no external visitors

## Current development

- NutriPlus v2.19 is published. Atrás confirma únicamente en el límite real de salida mediante una sola entrada de protección; Cancelar conserva el estado y Salir delega al navegador/PWA.

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
