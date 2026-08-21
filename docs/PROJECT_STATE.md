# NutriPlus — Current State

## Production

- Version: v2.16
- Checkpoint: 30
- Commit: `4805ca548e4bb6cfa735b23330e7d90168c18c9a`
- Deployment: `appgdep_6a87d243d23c8191a23360414bcfd4cc`
- URL: https://nutriplus-precios.ever1822.chatgpt.site/
- Last production migration: `0015_quiet_anthem.sql`
- Access mode: private/custom; one owner/admin, no external visitors

## Current development

- `feature/notifications` at `b92896aaa720a4fcf371f70b180105b3c7abb97f` is local, separate from `main` and not published.
- Its migration `0016_round_scarlet_witch.sql` is not a production migration.

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
- Notifications still needs an authorized publication and real Android/PWA closed-app push validation before any production claim.
