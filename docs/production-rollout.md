# Production rollout

## Preconditions

- GitHub Actions `check` is green for the merge commit.
- Existing Worker secrets remain configured.
- The current D1 database has the base Stationhead, history, host, Worker, official-news and email-recap tables.
- The local Collector is not changed to `auto` until the Worker deployment and lease endpoint are confirmed.

## Deploy

```powershell
cd C:\Stationhead
git pull

cd worker
npx wrangler d1 execute stationhead-monitor --remote --file=..\database\migrations\004_collector_coordination.sql
npx wrangler d1 execute stationhead-monitor --remote --file=..\database\migrations\005_cloud_host_monitor.sql
npx wrangler d1 execute stationhead-monitor --remote --file=..\database\migrations\006_email_weekly_summary.sql
npx wrangler d1 execute stationhead-monitor --remote --file=..\database\migrations\007_host_session_safety.sql
npx wrangler d1 execute stationhead-monitor --remote --file=..\database\migrations\008_buddy_auth_control.sql
npx wrangler deploy --config .\wrangler.jsonc
```

The Pages project is expected to deploy from the GitHub `main` branch. Confirm the Pages deployment before enabling local failover.

## Verify Worker

```powershell
Invoke-RestMethod https://stationhead-monitor-collector.tarematsu.workers.dev/health
Invoke-RestMethod https://stationhead-monitor-collector.tarematsu.workers.dev/coordination/lease
```

Within two minutes, the lease must show:

```text
healthy   : True
holder_id : cloudflare-worker
```

D1 verification:

```powershell
npx wrangler d1 execute stationhead-monitor --remote --command="SELECT scope,holder_id,holder_kind,priority,datetime(lease_until/1000,'unixepoch','+9 hours') AS lease_until_jst FROM sh_collector_leases;"

npx wrangler d1 execute stationhead-monitor --remote --command="SELECT data_type,collector_id,source_priority,COUNT(*) AS count FROM sh_ingest_claims GROUP BY data_type,collector_id,source_priority ORDER BY data_type,source_priority DESC;"

npx wrangler d1 execute stationhead-monitor --remote --command="SELECT id,phase,session_id,station_id,datetime(last_success_at/1000,'unixepoch','+9 hours') AS last_success_jst,last_error FROM sh_cloud_host_monitor_state ORDER BY id;"

npx wrangler d1 execute stationhead-monitor --remote --command="SELECT id,datetime(updated_at/1000,'unixepoch','+9 hours') AS updated_at_jst,last_error,datetime(lock_until/1000,'unixepoch','+9 hours') AS lock_until_jst FROM sh_worker_auth_control ORDER BY id;"
```

## Enable local automatic failover

```powershell
cd C:\Stationhead\collector
npm install
npm start
```

Expected log while Worker is healthy:

```text
cloud lease state changed {"healthy":true,...}
```

No `local collector started` line should appear while the cloud lease is healthy.

## Simultaneous-run check

Stop the auto supervisor first, then run the local Collector in active mode for at least two minutes:

```powershell
npm run start:active
```

Then verify that logical claims retain Cloud priority 100 and that conflicts are audited rather than duplicated.

```powershell
cd C:\Stationhead\worker
npx wrangler d1 execute stationhead-monitor --remote --command="SELECT data_type,collector_id,source_priority,COUNT(*) AS count FROM sh_ingest_claims WHERE observed_at>unixepoch('now','-10 minutes')*1000 GROUP BY data_type,collector_id,source_priority;"

npx wrangler d1 execute stationhead-monitor --remote --command="SELECT resolution,COUNT(*) AS count FROM sh_ingest_conflicts WHERE detected_at>unixepoch('now','-10 minutes')*1000 GROUP BY resolution;"
```

## Rollback

Worker code rollback does not require dropping the new tables or triggers. They are additive and safe for the previous Worker.

1. Deploy the previous known-good Worker commit.
2. Start the local Collector directly:

```powershell
cd C:\Stationhead\collector
npm run start:direct
```

3. Keep the coordination/claim tables in D1 for audit history.
4. To stop the email-to-weekly overlay only:

```powershell
cd C:\Stationhead\worker
npx wrangler d1 execute stationhead-monitor --remote --command="DROP TRIGGER IF EXISTS trg_sh_email_stream_weekly_insert; DROP TRIGGER IF EXISTS trg_sh_email_stream_weekly_update;"
```

Do not delete collected data during rollback.
