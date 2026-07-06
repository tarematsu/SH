const ORIGINAL_D1_STATEMENT = Symbol('original-d1-statement');

export function rewriteThrottledSql(value) {
  let sql = String(value || '');

  if (sql.includes('INSERT INTO sh_collector_leases') && !sql.includes('sh_collector_leases.updated_at >= 120000')) {
    sql = sql.replace(
      'metadata_json=excluded.metadata_json',
      `metadata_json=excluded.metadata_json
      WHERE excluded.updated_at-sh_collector_leases.updated_at >= 120000
         OR excluded.holder_id IS NOT sh_collector_leases.holder_id
         OR excluded.holder_kind IS NOT sh_collector_leases.holder_kind
         OR excluded.priority IS NOT sh_collector_leases.priority
         OR excluded.metadata_json IS NOT sh_collector_leases.metadata_json`,
    );
  }

  if (sql.includes('INSERT INTO sh_collector_heartbeats') && !sql.includes('sh_collector_heartbeats.last_seen_at>=300000')) {
    sql = sql.replace(
      'version=excluded.version, metadata_json=excluded.metadata_json',
      `version=excluded.version, metadata_json=excluded.metadata_json
      WHERE excluded.last_seen_at-sh_collector_heartbeats.last_seen_at>=300000
         OR excluded.hostname IS NOT sh_collector_heartbeats.hostname
         OR excluded.version IS NOT sh_collector_heartbeats.version
         OR excluded.metadata_json IS NOT sh_collector_heartbeats.metadata_json`,
    );
  }

  if (sql.includes('INSERT INTO sh_worker_collector_state') && !sql.includes('sh_worker_collector_state.last_success_at')) {
    sql = sql.replace(
      'updated_at=excluded.updated_at',
      `updated_at=excluded.updated_at
      WHERE excluded.auth_token IS NOT sh_worker_collector_state.auth_token
         OR excluded.device_uid IS NOT sh_worker_collector_state.device_uid
         OR excluded.token_expires_at IS NOT sh_worker_collector_state.token_expires_at
         OR excluded.last_error IS NOT sh_worker_collector_state.last_error
         OR excluded.last_channel_id IS NOT sh_worker_collector_state.last_channel_id
         OR excluded.last_station_id IS NOT sh_worker_collector_state.last_station_id
         OR COALESCE(excluded.last_success_at,0)-COALESCE(sh_worker_collector_state.last_success_at,0)>=300000
         OR COALESCE(excluded.last_run_at,0)-COALESCE(sh_worker_collector_state.last_run_at,0)>=300000`,
    );
  }

  if (sql.includes('INSERT INTO sh_cloud_host_monitor_state') && !sql.includes('sh_cloud_host_monitor_state.updated_at>=300000')) {
    sql = sql.replace(
      'last_error=excluded.last_error,updated_at=excluded.updated_at',
      `last_error=excluded.last_error,updated_at=excluded.updated_at
      WHERE excluded.phase IS NOT sh_cloud_host_monitor_state.phase
         OR excluded.session_id IS NOT sh_cloud_host_monitor_state.session_id
         OR excluded.station_id IS NOT sh_cloud_host_monitor_state.station_id
         OR excluded.candidate_count IS NOT sh_cloud_host_monitor_state.candidate_count
         OR excluded.inactive_count IS NOT sh_cloud_host_monitor_state.inactive_count
         OR excluded.last_profile_at IS NOT sh_cloud_host_monitor_state.last_profile_at
         OR excluded.last_queue_hash IS NOT sh_cloud_host_monitor_state.last_queue_hash
         OR excluded.last_error IS NOT sh_cloud_host_monitor_state.last_error
         OR excluded.updated_at-sh_cloud_host_monitor_state.updated_at>=300000`,
    );
  }

  return sql;
}

function wrapStatement(statement) {
  return new Proxy(statement, {
    get(target, property) {
      if (property === ORIGINAL_D1_STATEMENT) return target;
      if (property === 'bind') return (...args) => wrapStatement(target.bind(...args));
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function withD1WriteThrottling(env) {
  if (!env?.DB) return env;
  const db = env.DB;
  const wrappedDb = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => wrapStatement(target.prepare(rewriteThrottledSql(sql)));
      }
      if (property === 'batch') {
        return (statements) => target.batch(
          (statements || []).map((statement) => statement?.[ORIGINAL_D1_STATEMENT] || statement),
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === 'DB') return wrappedDb;
      return Reflect.get(target, property, receiver);
    },
  });
}
