# NutriPlus — Current State

## Production

- Version: v2.21
- Checkpoint: 41
- Commit: `e2e810463d0a2008ac1c8aeca1741e1ce448bd3e`
- Deployment: `appgdep_6a911dca4c38819199f371da74cc252a`
- URL: https://nutriplus-precios.ever1822.chatgpt.site/
- Last production migration: `0016_round_scarlet_witch.sql`
- Access mode: private/custom; one owner/admin, no external visitors

## Current development

- NutriPlus v2.21 is published. Pedidos y Rutas sincronizan asignaciones canónicas, cierran con decisión Entregado/No entregado, muestran totales financieros completos y permiten un abono inicial atómico al crear Encargos. Cancelar la salida rearma el mismo guard sin hacer crecer el historial.

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
