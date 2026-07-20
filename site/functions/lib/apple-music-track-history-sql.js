import { environmentView } from '../../../packages/sh-shared/environment-view.mjs';

const wrappedDatabases = new WeakMap();

export function withoutAppleMusicTrackHistorySql(value) {
  return String(value || '')
    .replace(/\s+OR \(current_first\.apple_music_id IS NOT NULL\s+AND current_first\.apple_music_id=previous_item\.apple_music_id\)/g, '')
    .replace(/,p\.apple_music_id(?=,p\.isrc)/g, '')
    .replace(/,plays\.apple_music_id(?=,plays\.isrc)/g, '')
    .replace(/,plays\.apple_music_id(?=,plays\.isrc|\s*,plays\.isrc)/g, '')
    .replace(/\s+AND plays\.apple_music_id IS NULL/g, '');
}

export function appleMusicFreeTrackHistoryDatabase(db) {
  if (!db?.prepare) return db;
  const cached = wrappedDatabases.get(db);
  if (cached) return cached;
  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => target.prepare(withoutAppleMusicTrackHistorySql(sql));
      }
      const result = Reflect.get(target, property, target);
      return typeof result === 'function' ? result.bind(target) : result;
    },
  });
  wrappedDatabases.set(db, wrapped);
  return wrapped;
}

export function withAppleMusicFreeTrackHistoryEnv(env) {
  if (!env) return env;
  const overrides = {};
  for (const binding of ['BUDDIES_DB', 'MINUTE_DB', 'DB']) {
    const database = env[binding];
    if (database?.prepare) overrides[binding] = appleMusicFreeTrackHistoryDatabase(database);
  }
  return environmentView(env, overrides);
}
