# Pages API gateway

All public HTTP APIs are owned by Cloudflare Pages under `/api`.

The Workers have public URLs disabled. `sh-runtime-orchestrator` owns collection, persistence, metadata, Pages read-model publication, and every other non-Sakurazaka scheduled or Queue lane. `sh-sakurazaka46jp` remains isolated for official-news and solo-broadcast monitoring.

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

The canonical groups are defined in `site/functions/lib/api-contract.js`. Tests enforce that every JavaScript file under `site/functions/api` corresponds to one declared public route, including the API index. There is no API middleware or internal HTTP route allow-list.

Collection and solo-session persistence are private modules under `site/functions/lib`. Workers call those modules directly; there are no Pages ingestion routes.

Do not add public HTTP routes to Worker entrypoints. Add new public read endpoints to `site/functions/api`, register them in the shared API contract, and bind their data sources in `site/wrangler.jsonc`.
