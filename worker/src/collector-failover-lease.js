import { finiteNumber as finite, jsonNoStoreResponse as json } from './shared.js';

// Coordination lease used to tell collector/run-failover.mjs whether the
// cloud Worker (the "buddies" worker) is healthy. When this lease is stale,
// the local failover collector takes over. This is unrelated to the email
// recap feature; it previously lived in email-recap-lease.js purely because
// the HTTP handler for /coordination/lease happened to be wired up there.
export const COLLECTOR_LEASE_PATH = '/coordination/lease';
export const COLLECTOR_LEASE_SCOPE = 'stationhead-primary';
export const COLLECTOR_LEASE_TTL_MS = 180000;

export async function renewCollectorLease(env) {
  if (!env.DB) return null;
  const now = Date.now();
  const leaseUntil = now + COLLECTOR_LEASE_TTL_MS;
  try {
    await env.DB.prepare(`INSERT INTO sh_collector_leases (
        scope,holder_id,holder_kind,priority,lease_until,heartbeat_at,updated_at,metadata_json
      ) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(scope) DO UPDATE SET
        holder_id=excluded.holder_id,holder_kind=excluded.holder_kind,
        priority=excluded.priority,lease_until=excluded.lease_until,
        heartbeat_at=excluded.heartbeat_at,updated_at=excluded.updated_at,
        metadata_json=excluded.metadata_json`)
      .bind(
        COLLECTOR_LEASE_SCOPE,
        'cloudflare-worker',
        'cloud',
        100,
        leaseUntil,
        now,
        now,
        JSON.stringify({ cron: 'every-minute', ttl_ms: COLLECTOR_LEASE_TTL_MS }),
      ).run();
    return { leaseUntil, heartbeatAt: now };
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) return null;
    throw error;
  }
}

export async function readCollectorLease(env) {
  if (!env.DB) return null;
  try {
    return env.DB.prepare(`SELECT scope,holder_id,holder_kind,priority,
      lease_until,heartbeat_at,updated_at FROM sh_collector_leases WHERE scope=?`)
      .bind(COLLECTOR_LEASE_SCOPE).first();
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) return null;
    throw error;
  }
}

export async function collectorLeaseCoordination(env) {
  const row = await readCollectorLease(env);
  const now = Date.now();
  return json({
    ok: true,
    scope: COLLECTOR_LEASE_SCOPE,
    healthy: Boolean(row && Number(row.lease_until || 0) > now && row.holder_kind === 'cloud'),
    holder_id: row?.holder_id || null,
    holder_kind: row?.holder_kind || null,
    priority: finite(row?.priority),
    lease_until: finite(row?.lease_until),
    heartbeat_at: finite(row?.heartbeat_at),
    server_time: now,
    setup_required: !row,
  });
}
