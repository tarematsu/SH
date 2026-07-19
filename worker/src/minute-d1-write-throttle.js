const ORIGINAL_D1_STATEMENT = Symbol('minute-original-d1-statement');
const REWRITE_CACHE_LIMIT = 24;
const CHECKPOINT_MS = 5 * 60_000;
const rewriteCache = new Map();

const TRACK_UPDATE = `UPDATE sh_tracks SET
      isrc=COALESCE(isrc,?1),spotify_id=COALESCE(spotify_id,?2),
      stationhead_track_id=COALESCE(stationhead_track_id,?3),
      title=COALESCE(title,?4),artist=COALESCE(artist,?5),last_seen_at=MAX(last_seen_at,?6)
    WHERE id=?7 AND (
      (?1 IS NOT NULL AND isrc IS NULL)
      OR (?2 IS NOT NULL AND spotify_id IS NULL)
      OR (?3 IS NOT NULL AND stationhead_track_id IS NULL)
      OR (?4 IS NOT NULL AND title IS NULL)
      OR (?5 IS NOT NULL AND artist IS NULL)
      OR ?6-COALESCE(last_seen_at,0)>=${CHECKPOINT_MS}
    )`;

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isTrackIdentityUpdate(sql) {
  const text = compact(sql);
  return text.startsWith('update sh_tracks set isrc=coalesce(isrc,?),spotify_id=coalesce(spotify_id,?),')
    && text.includes('stationhead_track_id=coalesce(stationhead_track_id,?)')
    && text.includes('title=coalesce(title,?),artist=coalesce(artist,?)')
    && text.includes('last_seen_at=max(last_seen_at,?) where id=?');
}

function throttleAliasUpsert(sql, table) {
  const text = String(sql || '');
  const normalized = compact(text);
  if (!normalized.startsWith(`insert into ${table}(`)
      || !normalized.includes('on conflict(alias_type,alias_value) do update set')
      || !normalized.includes(`last_seen_at=max(${table}.last_seen_at,excluded.last_seen_at)`)
      || normalized.includes('excluded.last_seen_at-coalesce')) {
    return text;
  }
  return `${text}\n      WHERE excluded.last_seen_at-COALESCE(${table}.last_seen_at,0)>=${CHECKPOINT_MS}`;
}

export function rewriteMinuteD1WriteSql(value) {
  const original = String(value || '');
  const cached = rewriteCache.get(original);
  if (cached !== undefined) return cached;

  let rewritten = original;
  if (isTrackIdentityUpdate(original)) rewritten = TRACK_UPDATE;
  else if (compact(original).startsWith('insert into sh_track_aliases(')) {
    rewritten = throttleAliasUpsert(original, 'sh_track_aliases');
  } else if (compact(original).startsWith('insert into sh_host_aliases(')) {
    rewritten = throttleAliasUpsert(original, 'sh_host_aliases');
  }

  if (rewriteCache.size >= REWRITE_CACHE_LIMIT) {
    const oldest = rewriteCache.keys().next().value;
    if (oldest !== undefined) rewriteCache.delete(oldest);
  }
  rewriteCache.set(original, rewritten);
  return rewritten;
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

function wrapDatabase(db) {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => {
          const original = String(sql || '');
          const rewritten = rewriteMinuteD1WriteSql(original);
          const statement = target.prepare(rewritten);
          return rewritten === original ? statement : wrapStatement(statement);
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
}

export function withMinuteD1WriteThrottling(env) {
  if (!env?.MINUTE_DB) return env;
  const db = wrapDatabase(env.MINUTE_DB);
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === 'MINUTE_DB') return db;
      return Reflect.get(target, property, receiver);
    },
  });
}

export function resetMinuteD1WriteRewriteCacheForTests() {
  rewriteCache.clear();
}
