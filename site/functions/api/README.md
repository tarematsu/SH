# Pages API gateway

All public HTTP APIs are owned by Cloudflare Pages under `/api`.

The scheduled Workers (`sh-monitor-buddies`, `sh-monitor-minute`, and `sh-monitor-other`) have public Worker URLs disabled. They remain responsible for cron and Queue execution only.

Use `GET /api` for the machine-readable endpoint catalog. Canonical monitoring and minute-facts routes include:

- `GET /api/health`, `/api/health/minute`, and `/api/health/other`
- `GET /api/minute-facts`
- `GET /api/minute-facts/current`
- `GET /api/minute-facts/latest`

The former collector-health and history compatibility paths are retired and return HTTP 404. Callers must use the canonical routes listed by `GET /api`.

The canonical groups, retired endpoints, and internal paths are defined once in `site/functions/lib/api-contract.js`. Both the API catalog and `_middleware.js` consume that contract.

Public Pages ingestion is disabled. `/api/ingest` and `/api/host-ingest` return 404.

Do not add public HTTP routes to Worker entrypoints. Add new public read endpoints to `site/functions/api`, register them in the shared API contract, and bind their data sources in `site/wrangler.jsonc`.
