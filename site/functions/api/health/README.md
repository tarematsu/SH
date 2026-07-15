# Health endpoints

These endpoints read the durable D1 state written by scheduled Workers. They do not call Worker HTTP URLs.

- `collector.js` reads the primary collector read model from `MINUTE_DB`.
- `minute.js` reads `sh_minute_fact_runtime_state` from `MINUTE_DB`.
- `other.js` reads scheduler, buddy playback, official news, and cloud host state from `OTHER_DB`.

A healthy response uses HTTP 200. Missing, stale, failed, or incomplete state uses HTTP 503 while returning structured component details.

Health endpoints are canonical Pages routes. Worker `/health` handlers may remain in source for local diagnostics and rollback, but `workers_dev`, preview URLs, and public Worker routes are disabled in production configuration.
