# Pages API gateway

All public HTTP APIs are owned by Cloudflare Pages under `/api`.

The scheduled Workers (`sh-monitor-buddies`, `sh-monitor-minute`, and `sh-monitor-other`) have `workers_dev` and preview URLs disabled. They remain responsible for cron and Queue execution only.

Use `GET /api` for the machine-readable endpoint catalog. Canonical monitoring and minute-facts routes include:

- `GET /api/health`, `/api/health/minute`, and `/api/health/other`
- `GET /api/minute-facts`
- `GET /api/minute-facts/current`
- `GET /api/minute-facts/latest`

`/api/health/collector`, `history-current`, `history-migrated`, `history-raw`, and `official-history` remain compatibility aliases. Their responses include `Deprecation`, `Link`, and `X-API-Successor` headers pointing to the canonical route.

The canonical groups, compatibility successors, retired endpoints, and internal blocked paths are defined once in `site/functions/lib/api-contract.js`. Both the API catalog and `_middleware.js` consume that contract so route documentation and enforcement cannot drift independently.

Public Pages ingestion is disabled. `/api/ingest` and `/api/host-ingest` return 404, and `_middleware.js` also blocks implementation filenames such as `ingest-core`, `ingest-legacy`, `dashboard-legacy`, and `history-legacy` from becoming accidental APIs.

Do not add public HTTP routes to Worker entrypoints. Add new public read endpoints to `site/functions/api`, register them in the shared API contract, and bind their data sources in `site/wrangler.jsonc`. Keep reusable implementation modules outside the public route surface or explicitly register their paths as internal and blocked.
