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
- authenticated weekly leaderboard collection
- weekly recap ingestion from Google Apps Script
- email recap anchors in weekly history
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
| weekly leaderboard | ranking date + ranking type |

`sh_ingest_claims` records the accepted logical key, payload hash, collector and priority. Existing table unique keys remain the final safeguard. Identical higher-priority payloads promote ownership without rewriting canonical data.

## Source precedence

- Cloud scheduled REST collection: priority 100
- local forced full collection: priority 80
- local automatic failover: priority 70
- local WebSocket supplement: priority 60
- historical imports: priority 20

For a key already present:

1. identical payload hash: ignore as duplicate and promote claim ownership when appropriate;
2. higher-priority payload: replace/update the canonical logical record;
3. equal-priority newer payload: update only mutable fields;
4. lower-priority conflicting payload: keep canonical record and log the conflict.

Comments and immutable identifiers are never overwritten with empty data.

## Shared collection core

Normalization and metadata logic is being moved to shared modules in stages. Runtime adapters remain separate:

- Worker adapter: direct D1 access and Cron execution
- local adapter: HTTPS ingest and optional WebSocket

The production failover release first standardizes payload contracts and D1 write semantics. Full source-file extraction is a low-risk follow-up after production telemetry confirms the cloud monitor.

## Failure behaviour

- Worker unhealthy for less than the lease TTL: local remains standby.
- Worker unhealthy past TTL: local starts full polling.
- Worker returns while local is active: Worker renews lease; local finishes its current cycle and returns to standby.
- Both forced active: deterministic keys and claims prevent duplicate logical rows.
- Pages/D1 unavailable: current data is retried by later polling where source APIs retain it. A durable local disk outbox remains a separate follow-up because transparent proxying was not accepted by repository safety controls.

## Production migrations

Apply in order:

1. `004_collector_coordination.sql`
2. `005_cloud_host_monitor.sql`
3. `006_email_weekly_summary.sql`
4. `007_host_session_safety.sql`

All four are executed twice in CI against SQLite, including trigger behaviour with sample data.

## Migration sequence

Completed in the production failover release:

1. coordination, claims and conflict tables;
2. collector identity and deterministic keys;
3. idempotent snapshot, queue, host and leaderboard writes;
4. cloud host/profile/solo polling;
5. local `auto|active|standby` supervisor;
6. cloud weekly leaderboard and recap validation;
7. dashboard payload/read reduction;
8. email history anchors;
9. syntax, unit, SQL and Worker bundle CI.

Follow-up after production observation:

- durable local disk outbox;
- complete shared normalization extraction;
- final Worker wrapper flattening;
- CSS and archived one-time tool deletion where connector safety permits.
