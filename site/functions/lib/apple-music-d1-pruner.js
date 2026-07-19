import { stripAppleMusicFields } from './api-utils.js';

const wrappedDatabases = new WeakMap();
const wrappedQueues = new WeakMap();
const CURRENT_BITE_APPLE_BIND_INDEX = 10;
const APPLE_FREE_QUEUE_BINDINGS = new Set([
  'MINUTE_DERIVE_QUEUE',
  'MINUTE_ENRICHMENT_QUEUE',
  'PERSIST_QUEUE',
  'TRACK_METADATA_QUEUE',
]);

function normalizedSql(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function removeQuestionMarkAt(value, ordinal) {
  let seen = 0;
  const marker = '__DROP_APPLE_MUSIC_BIND__';
  const marked = String(value).replace(/\?/g, (token) => {
    seen += 1;
    return seen === ordinal ? marker : token;
  });
  if (seen < ordinal) return String(value);
  return marked
    .replace(new RegExp(`,\\s*${marker}`), '')
    .replace(new RegExp(`${marker}\\s*,`), '')
    .replace(marker, 'NULL');
}

function currentBiteInsertPlan(value) {
  const original = String(value || '');
  const normalized = normalizedSql(original);
  if (!normalized.startsWith('insert or ignore into sh_track_counter_changes(')
      || !normalized.includes('queue_position,queue_track_id,stationhead_track_id,spotify_id,apple_music_id,isrc,')) {
    return null;
  }
  const withoutColumn = original.replace(/,\s*apple_music_id(?=\s*,\s*isrc)/i, '');
  const sql = removeQuestionMarkAt(withoutColumn, CURRENT_BITE_APPLE_BIND_INDEX + 1);
  if (sql === original || /apple_music_id/i.test(sql)) return null;
  return { sql, dropBindIndex: CURRENT_BITE_APPLE_BIND_INDEX };
}

export function withoutAppleMusicHotPathSql(value) {
  return String(value || '')
    .replace(/\s*json_extract\(track\.value\s*,\s*'\$\.apple_music_id'\)\s+AS\s+apple_music_id\s*,/gi, '')
    .replace(/,\s*apple_music_id\s*=\s*NULL/gi, '')
    .replace(/apple_music_id\s*=\s*NULL\s*,/gi, '')
    .replace(/,\s*apple_music_id\s*=\s*excluded\.apple_music_id/gi, '')
    .replace(/apple_music_id\s*=\s*excluded\.apple_music_id\s*,/gi, '');
}

export function appleMusicStatementPlan(value) {
  const insertPlan = currentBiteInsertPlan(value);
  if (insertPlan) return insertPlan;
  return { sql: withoutAppleMusicHotPathSql(value), dropBindIndex: null };
}

function wrapStatement(statement, dropBindIndex) {
  if (dropBindIndex == null) return statement;
  return new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') {
        return (...values) => target.bind(...values.filter((_value, index) => index !== dropBindIndex));
      }
      const result = Reflect.get(target, property, target);
      return typeof result === 'function' ? result.bind(target) : result;
    },
  });
}

export function appleMusicFreeD1(db) {
  if (!db?.prepare) return db;
  const cached = wrappedDatabases.get(db);
  if (cached) return cached;
  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => {
          const plan = appleMusicStatementPlan(sql);
          return wrapStatement(target.prepare(plan.sql), plan.dropBindIndex);
        };
      }
      const result = Reflect.get(target, property, target);
      return typeof result === 'function' ? result.bind(target) : result;
    },
  });
  wrappedDatabases.set(db, wrapped);
  return wrapped;
}

export function appleMusicFreeQueue(queue) {
  if (!queue?.send) return queue;
  const cached = wrappedQueues.get(queue);
  if (cached) return cached;
  const wrapped = new Proxy(queue, {
    get(target, property) {
      if (property === 'send') {
        return (message, options) => target.send(stripAppleMusicFields(message), options);
      }
      const result = Reflect.get(target, property, target);
      return typeof result === 'function' ? result.bind(target) : result;
    },
  });
  wrappedQueues.set(queue, wrapped);
  return wrapped;
}

export function withAppleMusicFreeD1(env) {
  if (!env) return env;
  const db = appleMusicFreeD1(env.DB);
  const minuteDb = appleMusicFreeD1(env.MINUTE_DB);
  const buddiesDb = appleMusicFreeD1(env.BUDDIES_DB);
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === 'DB') return db;
      if (property === 'MINUTE_DB') return minuteDb;
      if (property === 'BUDDIES_DB') return buddiesDb;
      return Reflect.get(target, property, receiver);
    },
  });
}

export function withAppleMusicFreeRuntime(env) {
  const d1Env = withAppleMusicFreeD1(env);
  if (!d1Env) return d1Env;
  return new Proxy(d1Env, {
    get(target, property, receiver) {
      if (APPLE_FREE_QUEUE_BINDINGS.has(property)) {
        return appleMusicFreeQueue(Reflect.get(target, property, receiver));
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
