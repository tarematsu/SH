const VELOCITY_SUM = `SELECT COALESCE(SUM(comment_count),0) FROM sh_comment_minute_counts
      WHERE station_id=? AND bucket_start>=? AND bucket_start<=?`;
const ZERO_VELOCITY = `SELECT 0 FROM (SELECT ? AS station_id, ? AS from_at, ? AS to_at)`;
const HEARTBEAT_INTERVAL_MS = 10 * 60_000;
const FAILURE_CLEAR_TTL_MS = 10 * 60_000;
const RAW_STATEMENT = Symbol('raw-d1-statement');
const STATEMENT_META = Symbol('d1-statement-meta');

export function rewriteDuplicateVelocityRead(sql, chatEnabled = true) {
  const text = String(sql || '');
  if (!chatEnabled || !text.includes('INSERT INTO sh_channel_snapshots')) return text;
  return text.includes(VELOCITY_SUM) ? text.replace(VELOCITY_SUM, ZERO_VELOCITY) : text;
}

function statementKind(sql) {
  const compact = String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (compact.startsWith('insert into sh_collector_heartbeats')) return 'heartbeat';
  if (compact.startsWith('delete from sh_collector_failure_state') && compact.includes('where id=?')) {
    return 'failure-clear';
  }
  if (compact.startsWith('insert into sh_collector_failure_state')) return 'failure-write';
  return null;
}

function skippedResult(reason) {
  return {
    success: true,
    meta: { changes: 0, skipped_by_optimizer: true, skip_reason: reason },
  };
}

export function withDuplicateVelocityReadRemoved(env, nowFn = Date.now) {
  if (!env?.DB) return env;
  const db = env.DB;
  const chatEnabled = Number(env.CHAT_LIMIT ?? 50) > 0;
  const heartbeatCache = new Map();
  let failureClearUntil = 0;

  function noteFailureWrite() {
    failureClearUntil = 0;
  }

  function wrapStatement(statement, meta) {
    return new Proxy(statement, {
      get(target, property) {
        if (property === RAW_STATEMENT) return target;
        if (property === STATEMENT_META) return meta;
        if (property === 'bind') {
          return (...args) => wrapStatement(target.bind(...args), { ...meta, binds: args });
        }
        if (property === 'run') {
          return async (...args) => {
            const now = Number(nowFn()) || Date.now();
            if (meta.kind === 'heartbeat') {
              const [collectorId, , , hostname, version, metadataJson] = meta.binds || [];
              const key = String(collectorId || '');
              const signature = JSON.stringify([hostname ?? null, version ?? null, metadataJson ?? null]);
              const cached = heartbeatCache.get(key);
              if (cached && cached.expiresAt > now && cached.signature === signature) {
                return skippedResult('heartbeat-cadence');
              }
              const result = await target.run(...args);
              if (result?.success !== false) {
                heartbeatCache.set(key, { signature, expiresAt: now + HEARTBEAT_INTERVAL_MS });
              }
              return result;
            }
            if (meta.kind === 'failure-clear') {
              if (failureClearUntil > now) return skippedResult('failure-already-clear');
              const result = await target.run(...args);
              if (result?.success !== false) failureClearUntil = now + FAILURE_CLEAR_TTL_MS;
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
          return wrapStatement(target.prepare(rewritten), {
            sql: rewritten,
            kind: statementKind(rewritten),
            binds: [],
          });
        };
      }
      if (property === 'batch') {
        return async (statements) => {
          const list = Array.isArray(statements) ? statements : [];
          if (list.some((statement) => statement?.[STATEMENT_META]?.kind === 'failure-write')) {
            noteFailureWrite();
          }
          return target.batch(list.map((statement) => statement?.[RAW_STATEMENT] || statement));
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
