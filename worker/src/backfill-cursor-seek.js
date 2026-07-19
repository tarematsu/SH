const ORIGINAL_D1_STATEMENT = Symbol('backfill-original-d1-statement');
const wrappedDatabases = new WeakMap();

const CURSOR_SCAN_CLAUSE = `WHERE observed_at<? AND (
      observed_at>? OR (observed_at=? AND id>?)
    )
    ORDER BY observed_at ASC,id ASC LIMIT ?`;

const CURSOR_SEEK_CLAUSE = `WHERE (observed_at,id)>(?,?)
      AND observed_at<?
    ORDER BY observed_at ASC,id ASC LIMIT ?`;

export function rewriteBackfillCursorSql(value) {
  const sql = String(value || '');
  if (!sql.includes('FROM sh_channel_snapshots') || !sql.includes(CURSOR_SCAN_CLAUSE)) return sql;
  return sql.replace(CURSOR_SCAN_CLAUSE, CURSOR_SEEK_CLAUSE);
}

export function rewriteBackfillCursorBinds(values = []) {
  const [cutoff, cursorObservedAt, duplicateCursorObservedAt, cursorSnapshotId, limit] = values;
  if (cursorObservedAt !== duplicateCursorObservedAt) {
    throw new Error('backfill cursor bind pair is inconsistent');
  }
  return [cursorObservedAt, cursorSnapshotId, cutoff, limit];
}

function wrapStatement(statement, reorderBinds = false) {
  return new Proxy(statement, {
    get(target, property) {
      if (property === ORIGINAL_D1_STATEMENT) return target;
      if (property === 'bind') {
        return (...args) => {
          const binds = reorderBinds ? rewriteBackfillCursorBinds(args) : args;
          return wrapStatement(target.bind(...binds), false);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function wrapDatabase(db) {
  const cached = wrappedDatabases.get(db);
  if (cached) return cached;
  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => {
          const original = String(sql || '');
          const rewritten = rewriteBackfillCursorSql(original);
          const statement = target.prepare(rewritten);
          return rewritten === original ? statement : wrapStatement(statement, true);
        };
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
  wrappedDatabases.set(db, wrapped);
  return wrapped;
}

export function withBackfillCursorSeek(env) {
  if (!env?.BUDDIES_DB) return env;
  const db = wrapDatabase(env.BUDDIES_DB);
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === 'BUDDIES_DB') return db;
      return Reflect.get(target, property, receiver);
    },
  });
}

export function resetBackfillCursorSeekForTests(db) {
  if (db) wrappedDatabases.delete(db);
}
