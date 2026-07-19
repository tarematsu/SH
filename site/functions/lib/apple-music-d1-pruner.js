const wrappedDatabases = new WeakMap();

export function withoutAppleMusicHotPathSql(value) {
  return String(value || '')
    .replace(/\s*json_extract\(track\.value\s*,\s*'\$\.apple_music_id'\)\s+AS\s+apple_music_id\s*,/gi, '')
    .replace(/,\s*apple_music_id\s*=\s*NULL/gi, '')
    .replace(/apple_music_id\s*=\s*NULL\s*,/gi, '')
    .replace(/,\s*apple_music_id\s*=\s*excluded\.apple_music_id/gi, '')
    .replace(/apple_music_id\s*=\s*excluded\.apple_music_id\s*,/gi, '');
}

export function appleMusicFreeD1(db) {
  if (!db?.prepare) return db;
  const cached = wrappedDatabases.get(db);
  if (cached) return cached;
  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => target.prepare(withoutAppleMusicHotPathSql(sql));
      }
      const result = Reflect.get(target, property, target);
      return typeof result === 'function' ? result.bind(target) : result;
    },
  });
  wrappedDatabases.set(db, wrapped);
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
