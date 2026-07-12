import { finiteNumber as finite, jsonNoStoreResponse as json } from './shared.js';
import { readCollectorLease } from './collector-failover-lease.js';

export async function enhancedHealth(app, request, env, ctx) {
  const response = await app.fetch(request, env, ctx);
  const base = await response.json().catch(() => ({}));
  let lease = null;
  let hostMonitor = null;
  try {
    lease = await readCollectorLease(env);
    hostMonitor = await env.DB.prepare(`SELECT phase,session_id,station_id,last_success_at,last_error,updated_at
      FROM sh_cloud_host_monitor_state WHERE id=?`).bind('solo:sakurazaka46jp').first();
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || ''))) console.error(error);
  }
  return json({
    ...base,
    collector_lease_until: finite(lease?.lease_until),
    collector_lease_healthy: Boolean(lease && Number(lease.lease_until) > Date.now()),
    cloud_solo_phase: hostMonitor?.phase || null,
    cloud_solo_session_id: finite(hostMonitor?.session_id),
    cloud_solo_station_id: finite(hostMonitor?.station_id),
    cloud_host_last_success_at: finite(hostMonitor?.last_success_at),
    cloud_host_last_error: hostMonitor?.last_error || null,
  }, response.status);
}
