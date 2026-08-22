# NutriPlus — Current State

## Production

- Version: v2.17
- Checkpoint: 36
- Commit: `350b24e6bc2eb95c65c4e59eba2ccb2773f94334`
- Deployment: `appgdep_6a89b27faff081919c0795366b85a17d`
- URL: https://nutriplus-precios.ever1822.chatgpt.site/
- Last production migration: `0016_round_scarlet_witch.sql`
- Access mode: private/custom; one owner/admin, no external visitors

## Current development

- Notifications are published in v2.17. Alertas internas funcionan. La sonda productiva confirmó HTTPS general y acceso simple al origen FCM; el `POST` Web Push completo todavía falla con `TypeError` antes de una respuesta HTTP.

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
- Android/PWA closed-app push remains pending mientras se aísla qué componente del request Web Push completo provoca el `TypeError` productivo.
