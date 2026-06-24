# Cloud-primary / local-failover architecture

## Goal

Cloudflare Worker is the primary collector and must be able to collect every required data category without a permanently running PC. The Windows collector remains a complete emergency replacement and optional WebSocket supplement. Running both at the same time must not create duplicate logical records or corrupt session state.

## Roles

### Cloudflare Worker — primary

- Buddies channel snapshot every minute
- chat history and two-minute comment velocity
- queue and track metadata
- host profile snapshots
- `sakurazaka46jp` solo-broadcast detection and session data
- official-news fail-safe monitoring
- weekly recap ingestion from Google Apps Script
- scheduled summary maintenance and retention
- collector lease renewal

### Local collector — failover and supplement

- Uses the same normalized payload contracts as the Worker
- `auto` mode: performs full polling only when the cloud lease is stale
- `active` mode: performs full polling regardless of cloud status
- `standby` mode: never performs scheduled REST polling
- may keep WebSocket supplements enabled while cloud polling is healthy
- can be promoted without changing D1 schema or Pages APIs

## Coordination lease

Scope `stationhead-primary` is stored in `sh_collector_leases`.

- Worker renews a 180-second lease on every one-minute cron invocation.
- Local `auto` mode checks the lease before a full polling cycle.
- A lease is advisory, not the only duplicate-prevention mechanism.
- Failure to read the lease must not permanently block failover; local uses a configurable grace period.

## Idempotency

Every logical write has a deterministic key independent of collector identity.

| Data | Logical key |
|---|---|
| Buddies snapshot | `channel:{channel_id}:minute:{observed_minute}` |
| comment | Stationhead comment ID |
| queue state | `station:{station_id}:queue:{queue_start_time}:hash:{queue_hash}` |
| track metadata | Spotify ID |
| host profile | `profile:{handle}:hour:{observed_hour}` |
| solo session | source scope + handle + station ID + broadcast start |
| solo station snapshot | `solo:{session_id}:minute:{observed_minute}` |
| solo comment | session ID + comment ID |
| raw event | source + station/channel + event + payload hash + time bucket |
| email recap | `stationhead-email:{week_of}` |

`sh_ingest_claims` records the accepted logical key, payload hash, collector and priority. The write path uses the claim and data mutation in one D1 batch where practical. Existing table unique keys remain the final safeguard.

## Source precedence

- Cloud scheduled REST collection: priority 100
- local forced full collection: priority 80
- local automatic failover: priority 70
- local WebSocket supplement: priority 60
- historical imports: priority 20

For a key already present:

1. identical payload hash: ignore as duplicate;
2. higher-priority payload: replace/update the canonical logical record;
3. equal-priority newer payload: update only mutable fields;
4. lower-priority conflicting payload: keep canonical record and log the conflict.

Comments and immutable identifiers are never overwritten with empty data.

## Shared collection core

Normalization and metadata logic moves to `shared/` and is imported by both runtimes.

- `shared/stationhead-normalize.js`
- `shared/track-metadata.js`
- `shared/validation.js`
- `shared/dedupe.js`

Runtime adapters are kept separate:

- Worker adapter: direct D1 access and Cron execution
- local adapter: HTTPS ingest and optional WebSocket

## Failure behaviour

- Worker unhealthy for less than the lease TTL: local remains standby.
- Worker unhealthy past TTL: local starts full polling.
- Worker returns while local is active: Worker renews lease; local finishes its current cycle and returns to standby.
- Both forced active: deterministic keys and claims prevent duplicate logical rows.
- Pages/D1 unavailable: local queues compact payloads on disk and retries with the same logical keys.

## Migration sequence

1. Add coordination, claims and conflict tables.
2. Add collector identity and deterministic keys to ingest payloads.
3. Make existing ingest paths idempotent before enabling failover.
4. Move all host and solo polling into Worker.
5. Add local `auto|active|standby` mode.
6. Extract shared normalization logic.
7. Consolidate Worker entrypoint and front-end patches.
8. Add incremental summaries, retention, tests and CI.

Production is switched to local standby only after cloud host/solo collection and health checks are verified.