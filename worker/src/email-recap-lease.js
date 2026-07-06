import { finite, json } from './email-recap-utils.js';

export const EMAIL_RECAP_LEASE_SCOPE = 'stationhead-primary';
export const EMAIL_RECAP_LEASE_TTL_MS = 180000;

export async function renewCloudLease(env) {
  if (!env.DB) return null;
  const now = Date.now();
  const leaseUntil = now + EMAIL_RECAP_LEASE_TTL_MS;
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
        EMAIL_RECAP_LEASE_SCOPE,
        'cloudflare-worker',
        'cloud',
        100,
        leaseUntil,
        now,
        now,
        JSON.stringify({ cron: 'every-minute', ttl_ms: EMAIL_RECAP_LEASE_TTL_MS }),
      ).run();
    return { leaseUntil, heartbeatAt: now };
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) return null;
    throw error;
  }
}

export async function readCloudLease(env) {
  if (!env.DB) return null;
  try {
    return env.DB.prepare(`SELECT scope,holder_id,holder_kind,priority,
      lease_until,heartbeat_at,updated_at FROM sh_collector_leases WHERE scope=?`)
      .bind(EMAIL_RECAP_LEASE_SCOPE).first();
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) return null;
    throw error;
  }
}

export async function coordination(env) {
  const row = await readCloudLease(env);
  const now = Date.now();
  return json({
    ok: true,
    scope: EMAIL_RECAP_LEASE_SCOPE,
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
