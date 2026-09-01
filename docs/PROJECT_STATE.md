# NutriPlus — Current State

## Production

- Version: v2.30
- Checkpoint: 60
- Commit: `b99202523fb0f2d65be130c68e34eded96761167`
- Deployment: `appgdep_6a972ff160b08191a96cfd1ed66538be`
- URL: https://nutriplus-precios.ever1822.chatgpt.site/
- Last production migration: `0017_equal_microchip.sql`
- Access mode: private/custom; one owner/admin, no external visitors

## Current development

- v2.30 corrige la reversión de ingresos de factura mediante coincidencia literal del `operationId` financiero y ajusta ventas netas, COGS y rentabilidad desde las devoluciones de pedido ya existentes, sin reescribir la entrega original ni reabrir rutas.
- Caja continúa derivándose exclusivamente de pagos y reembolsos reales. No se añadió migración, `0018_messy_nemesis.sql`, tablas/endpoints/UI de Clientes ni CRM.

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
