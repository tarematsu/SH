# Pages API gateway

All public HTTP APIs are owned by Cloudflare Pages under `/api`.

The scheduled Workers (`sh-monitor-buddies`, `sh-monitor-minute`, and `sh-monitor-other`) have `workers_dev` and preview URLs disabled. They remain responsible for cron and Queue execution only.

Use `GET /api` for the public endpoint catalog. Health endpoints are available at:

- `GET /api/health` and `GET /api/health/collector`
- `GET /api/health/minute`
- `GET /api/health/other`
- `GET /api/minute-facts/latest`

Do not add public HTTP routes to Worker entrypoints. Add new public read/write endpoints to `site/functions/api` and bind their data sources in `site/wrangler.jsonc`.
