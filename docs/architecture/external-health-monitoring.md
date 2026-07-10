# External collection monitoring

## Ownership

Stationhead owns collection and exposes collector health through `/api/health`.
HomePanel Cloud owns periodic health polling, incident transition detection, and optional notification delivery.

The Stationhead Worker no longer runs its own scheduled email monitor unless `STATIONHEAD_INTERNAL_MONITOR_ENABLED=true` is explicitly configured as a temporary rollback.

## Health sources

- Main collector success and failure state: `sh_worker_collector_state`
- Cloud/local primary coordination: `sh_collector_leases`
- Latest collected data: `sh_channel_snapshots`
- Secondary playback collector status: `sh_collector_status`
- Secondary playback current data: `sh_playback_channel_current`

The cloud collector does not write a per-minute `cloudflare-worker` heartbeat. `last_run_at`, `last_success_at`, and `last_error` already provide the required liveness information without a duplicate write path.

## Collection efficiency

- Snapshot ingestion does not trigger maintenance.
- D1 rollup and backfill maintenance runs as hourly scheduled auxiliary work.
- Track metadata enrichment runs only when queue structure changes.
- The centralized collection plan determines snapshot, queue, comment, metadata, and heartbeat work.
- Legacy heartbeat ingestion remains available for external/local collectors during compatibility migration, but Buddy playback health uses `sh_collector_status`.

## HomePanel configuration

HomePanel Cloud polls the Stationhead health endpoint every five minutes.

Required:

- `STATIONHEAD_MONITOR_URL` or `STATIONHEAD_HEALTH_URL`

Optional notifications:

- `RESEND_API_KEY`
- `STATIONHEAD_ALERT_TO`
- `STATIONHEAD_ALERT_FROM`
- `STATIONHEAD_HEALTH_STALE_MS`

The HomePanel state is available from its authenticated `/v1/stationhead-health` endpoint.
