# Pages API gateway

All public HTTP APIs are owned by Cloudflare Pages under `/api`.

The Workers have public URLs disabled. `sh-buddies-ingest` owns collection persistence, `sh-minute-enrichment` owns metadata and Pages read-model publication, `sh-sakurazaka46jp` owns official-news and solo-broadcast monitoring, and `sh-runtime-orchestrator` owns the remaining scheduled and Queue lanes.

Use `GET /api` for the machine-readable endpoint catalog. The public API surface is:

- `GET /api/health`
- `GET /api/health/minute`
- `GET /api/health/other`
- `GET /api/health/sakurazaka46jp`
- `GET /api/dashboard`
- `GET /api/history`
- `GET /api/track-history`
- `GET /api/sakurazaka46jp`
- `GET /api/host-history`

`/api/dashboard` includes current state, the complete queue, recent dashboard history, and completed UTC-day member and stream changes. `track-history` includes track like data and the latest all-time ranking. `sakurazaka46jp` provides official broadcast listener series.

Removed endpoints do not have compatibility handlers or catalog entries. File absence is the public 404 boundary.

The canonical groups and internal implementation paths are defined in `site/functions/lib/api-contract.js`. Both the API catalog and middleware consume that contract.

Public Pages ingestion is disabled. The internal ingest modules remain callable by Workers, while `/api/ingest` and `/api/host-ingest` are blocked by API middleware.

Do not add public HTTP routes to Worker entrypoints. Add new public read endpoints to `site/functions/api`, register them in the shared API contract, and bind their data sources in `site/wrangler.jsonc`.
