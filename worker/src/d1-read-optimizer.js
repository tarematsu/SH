const VELOCITY_SUM = `SELECT COALESCE(SUM(comment_count),0) FROM sh_comment_minute_counts
      WHERE station_id=? AND bucket_start>=? AND bucket_start<=?`;
const ZERO_VELOCITY = `SELECT 0 FROM (SELECT ? AS station_id, ? AS from_at, ? AS to_at)`;
const HEARTBEAT_INTERVAL_MS = 10 * 60_000;
const FAILURE_CLEAR_TTL_MS = 10 * 60_000;
const COLLECTOR_STATE_TTL_MS = 5 * 60_000;
const COLLECTOR_STATE_WRITE_INTERVAL_MS = 5 * 60_000;
const RAW_STATEMENT = Symbol('raw-d1-statement');
const STATEMENT_META = Symbol('d1-statement-meta');
const optimizerStates = new WeakMap();

export function rewriteDuplicateVelocityRead(sql, chatEnabled = true) {
  const text = String(sql || '');
  if (!chatEnabled || !text.includes('INSERT INTO sh_channel_snapshots')) return text;
  return text.includes(VELOCITY_SUM) ? text.replace(VELOCITY_SUM, ZERO_VELOCITY) : text;
}

function statementKind(sql) {
  const raw = String(sql || '');
  if (!raw.includes('sh_collector_') && !raw.includes('sh_worker_collector_state')) return null;
  const compact = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  if (compact.startsWith('insert into sh_collector_heartbeats')) return 'heartbeat';
  if (compact.startsWith('delete from sh_collector_failure_state') && compact.includes('where id=?')) {
    return 'failure-clear';
  }
  if (compact.startsWith('insert into sh_collector_failure_state')) return 'failure-write';
  if (compact.startsWith('select auth_token, device_uid, token_expires_at, last_run_at, last_success_at,')
      && compact.includes("from sh_worker_collector_state where id = 'stationhead'")) {
    return 'collector-state-read';
  }
  if (/^select last_success_at,\s*last_error from sh_worker_collector_state where id\s*=\s*'stationhead'/.test(compact)) {
    return 'collector-state-health-read';
  }
  if (compact.startsWith('insert into sh_worker_collector_state')) {
    return /values\s*\(\s*'stationhead'\s*,\s*\?/.test(compact)
      ? 'collector-state-write'
      : 'collector-state-invalidate-write';
  }
  return null;
}

function skippedResult(reason) {
  return {
    success: true,
    meta: { changes: 0, skipped_by_optimizer: true, skip_reason: reason },
  };
}

function stateFor(db) {
  let state = optimizerStates.get(db);
  if (!state) {
    state = {
      heartbeatCache: new Map(),
      failureClearUntil: 0,
      collectorState: null,
      collectorStateExpiresAt: 0,
      collectorStatePersistedAt: 0,
      collectorStateSignature: null,
    };
    optimizerStates.set(db, state);
  }
  return state;
}

function collectorStateFromBinds(binds, now) {
  const [authToken, deviceUid, tokenExpiresAt, lastRunAt, lastSuccessAt, lastError,
    lastChannelId, lastStationId] = binds || [];
  return {
    auth_token: authToken ?? null,
    device_uid: deviceUid ?? null,
    token_expires_at: tokenExpiresAt ?? null,
    last_run_at: lastRunAt ?? null,
    last_success_at: lastSuccessAt ?? null,
    last_error: lastError ?? null,
    last_channel_id: lastChannelId ?? null,
    last_station_id: lastStationId ?? null,
    updated_at: now,
  };
}

function collectorStateSignature(row) {
  return JSON.stringify([
    row?.auth_token ?? null,
    row?.device_uid ?? null,
    row?.token_expires_at ?? null,
    row?.last_error ?? null,
    row?.last_channel_id ?? null,
    row?.last_station_id ?? null,
  ]);
}

function cachedCollectorStateResult(kind, row) {
  if (kind === 'collector-state-health-read') {
    return {
      last_success_at: row?.last_success_at ?? null,
      last_error: row?.last_error ?? null,
    };
  }
  return row ? { ...row } : row;
}

function isCollectorStateRead(kind) {
  return kind === 'collector-state-read' || kind === 'collector-state-health-read';
}

export function withDuplicateVelocityReadRemoved(env, nowFn = Date.now) {
  if (!env?.DB) return env;
  const db = env.DB;
  const chatEnabled = Number(env.CHAT_LIMIT ?? 50) > 0;
  const shared = stateFor(db);

  function noteFailureWrite() {
    shared.failureClearUntil = 0;
  }

  function invalidateCollectorState() {
    shared.collectorState = null;
    shared.collectorStateExpiresAt = 0;
    shared.collectorStatePersistedAt = 0;
    shared.collectorStateSignature = null;
  }

  function wrapStatement(statement, meta) {
    return new Proxy(statement, {
      get(target, property) {
        if (property === RAW_STATEMENT) return target;
        if (property === STATEMENT_META) return meta;
        if (property === 'bind') {
          return (...args) => wrapStatement(target.bind(...args), { ...meta, binds: args });
        }
        if (property === 'first') {
          return async (...args) => {
            const now = Number(nowFn()) || Date.now();
            if (isCollectorStateRead(meta.kind)
                && shared.collectorState
                && shared.collectorStateExpiresAt > now) {
              return cachedCollectorStateResult(meta.kind, shared.collectorState);
            }
            const result = await target.first(...args);
            if (meta.kind === 'collector-state-read' && result) {
              shared.collectorState = { ...result };
              shared.collectorStateExpiresAt = now + COLLECTOR_STATE_TTL_MS;
              shared.collectorStateSignature = collectorStateSignature(result);
              shared.collectorStatePersistedAt = Number(result.updated_at || now);
            }
            return result;
          };
        }
        if (property === 'run') {
          return async (...args) => {
            const now = Number(nowFn()) || Date.now();
            if (meta.kind === 'heartbeat') {
              const [collectorId, , , hostname, version, metadataJson] = meta.binds || [];
              const key = String(collectorId || '');
              const signature = JSON.stringify([hostname ?? null, version ?? null, metadataJson ?? null]);
              const cached = shared.heartbeatCache.get(key);
              if (cached && cached.expiresAt > now && cached.signature === signature) {
                return skippedResult('heartbeat-cadence');
              }
              const result = await target.run(...args);
              if (result?.success !== false) {
                shared.heartbeatCache.set(key, { signature, expiresAt: now + HEARTBEAT_INTERVAL_MS });
              }
              return result;
            }
            if (meta.kind === 'failure-clear') {
              if (shared.failureClearUntil > now) return skippedResult('failure-already-clear');
              const result = await target.run(...args);
              if (result?.success !== false) shared.failureClearUntil = now + FAILURE_CLEAR_TTL_MS;
              return result;
            }
            if (meta.kind === 'collector-state-invalidate-write') {
              const result = await target.run(...args);
              if (result?.success !== false) invalidateCollectorState();
              return result;
            }
            if (meta.kind === 'collector-state-write') {
              const next = collectorStateFromBinds(meta.binds, now);
              const signature = collectorStateSignature(next);
              const stable = signature === shared.collectorStateSignature;
              const withinCheckpoint = now - shared.collectorStatePersistedAt < COLLECTOR_STATE_WRITE_INTERVAL_MS;
              shared.collectorState = next;
              shared.collectorStateExpiresAt = now + COLLECTOR_STATE_TTL_MS;
              shared.collectorStateSignature = signature;
              if (stable && withinCheckpoint) return skippedResult('collector-state-checkpoint');
              const result = await target.run(...args);
              if (result?.success !== false) shared.collectorStatePersistedAt = now;
              return result;
            }
            if (meta.kind === 'failure-write') noteFailureWrite();
            return target.run(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  const optimizedDb = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => {
          const rewritten = rewriteDuplicateVelocityRead(sql, chatEnabled);
          const kind = statementKind(rewritten);
          const statement = target.prepare(rewritten);
          if (kind === null && rewritten === String(sql || '')) return statement;
          return wrapStatement(statement, {
            sql: rewritten,
            kind,
            binds: [],
          });
        };
      }
      if (property === 'batch') {
        return async (statements) => {
          const list = Array.isArray(statements) ? statements : [];
          if (list.some((item) => item?.[STATEMENT_META]?.kind === 'failure-write')) noteFailureWrite();
          const invalidatesCollectorState = list.some(
            (item) => item?.[STATEMENT_META]?.kind === 'collector-state-invalidate-write',
          );
          const results = await target.batch(list.map((item) => item?.[RAW_STATEMENT] || item));
          if (invalidatesCollectorState && results.every((result) => result?.success !== false)) {
            invalidateCollectorState();
          }
          return results;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === 'DB') return optimizedDb;
      return Reflect.get(target, property, receiver);
    },
  });
}

export function resetD1OptimizerState(db) {
  if (db) optimizerStates.delete(db);
}
