const RAW_STATEMENT = Symbol('scheduled-optimizer-raw-statement');
const STATEMENT_META = Symbol('scheduled-optimizer-statement-meta');
const EMPTY_CLEANUP_BACKOFF_MS = 6 * 60 * 60_000;

export const OFFICIAL_NEWS_CLAIM_SQL = `INSERT INTO sh_official_news_monitor_state
  (id,last_check_at,last_success_at,last_error,updated_at)
VALUES (?,?,NULL,NULL,?)
ON CONFLICT(id) DO UPDATE SET
  last_check_at=excluded.last_check_at,
  last_error=NULL,
  updated_at=excluded.updated_at
WHERE COALESCE(sh_official_news_monitor_state.last_check_at,0)<=?
RETURNING last_success_at,last_error`;

function compactSql(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function scheduledStatementKind(sql) {
  const compact = compactSql(sql);
  if (compact.startsWith('select last_check_at,last_success_at,last_error from sh_official_news_monitor_state')) {
    return 'official-news-state-read';
  }
  if (compact.startsWith('insert into sh_official_news_monitor_state')) {
    return 'official-news-state-write';
  }
  if (compact.startsWith('delete from sh_channel_snapshots where id in (')
      || compact.startsWith('delete from sh_raw_events where id in (')
      || compact.startsWith('delete from sh_realtime_metrics where id in (')
      || compact.startsWith('delete from sh_queue_snapshots where id in (')) {
    return 'retention-cleanup';
  }
  if (compact.startsWith('insert into sh_data_maintenance_state')
      && compact.includes('last_rollup_key=case')) {
    return 'maintenance-final-state';
  }
  return null;
}

function skippedResult(reason) {
  return {
    success: true,
    meta: { changes: 0, skipped_by_optimizer: true, skip_reason: reason },
  };
}

function changedRows(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

export function withScheduledD1Optimizations(env, nowFn = Date.now) {
  if (!env?.DB) return env;
  const db = env.DB;
  const state = {
    officialClaimAt: 0,
    officialLastSuccessAt: null,
    emptyCleanupBackoffUntil: 0,
  };

  function wrapStatement(statement, meta) {
    return new Proxy(statement, {
      get(target, property) {
        if (property === RAW_STATEMENT) return target;
        if (property === STATEMENT_META) return meta;
        if (property === 'bind') {
          return (...inputArgs) => {
            let args = inputArgs;
            if (meta.kind === 'maintenance-final-state'
                && state.emptyCleanupBackoffUntil > Number(inputArgs[2] || 0)) {
              args = [...inputArgs];
              args[2] = state.emptyCleanupBackoffUntil;
            }
            return wrapStatement(target.bind(...args), { ...meta, binds: args });
          };
        }
        if (property === 'first' && meta.kind === 'official-news-state-read') {
          return async () => {
            const now = Number(nowFn()) || Date.now();
            const intervalMs = Math.max(1, Number(env.OFFICIAL_NEWS_CHECK_INTERVAL_MS || 30 * 60_000));
            const id = meta.binds?.[0] || 'official-news';
            const claimed = await db.prepare(OFFICIAL_NEWS_CLAIM_SQL)
              .bind(id, now, now, now - intervalMs)
              .first();
            if (!claimed) {
              state.officialClaimAt = 0;
              state.officialLastSuccessAt = null;
              return { last_check_at: now, last_success_at: null, last_error: null };
            }
            state.officialClaimAt = now;
            state.officialLastSuccessAt = claimed.last_success_at ?? null;
            return {
              last_check_at: 0,
              last_success_at: state.officialLastSuccessAt,
              last_error: claimed.last_error ?? null,
            };
          };
        }
        if (property === 'run' && meta.kind === 'official-news-state-write') {
          return async (...args) => {
            const [, lastCheckAt, lastSuccessAt, lastError] = meta.binds || [];
            const isRedundantClaimWrite = state.officialClaimAt > 0
              && Number(lastCheckAt) === state.officialClaimAt
              && (lastSuccessAt ?? null) === state.officialLastSuccessAt
              && (lastError ?? null) == null;
            if (isRedundantClaimWrite) return skippedResult('official-news-claim-already-persisted');
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
        return (sql) => wrapStatement(target.prepare(sql), {
          sql: String(sql || ''),
          kind: scheduledStatementKind(sql),
          binds: [],
        });
      }
      if (property === 'batch') {
        return async (statements) => {
          const list = Array.isArray(statements) ? statements : [];
          const cleanupIndexes = [];
          list.forEach((statement, index) => {
            if (statement?.[STATEMENT_META]?.kind === 'retention-cleanup') cleanupIndexes.push(index);
          });
          const results = await target.batch(list.map((statement) => statement?.[RAW_STATEMENT] || statement));
          if (cleanupIndexes.length) {
            const totalChanges = cleanupIndexes.reduce(
              (sum, index) => sum + changedRows(results?.[index]),
              0,
            );
            state.emptyCleanupBackoffUntil = totalChanges === 0
              ? (Number(nowFn()) || Date.now()) + EMPTY_CLEANUP_BACKOFF_MS
              : 0;
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

export { EMPTY_CLEANUP_BACKOFF_MS };
