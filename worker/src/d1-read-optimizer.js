const VELOCITY_SUM = `SELECT COALESCE(SUM(comment_count),0) FROM sh_comment_minute_counts
      WHERE station_id=? AND bucket_start>=? AND bucket_start<=?`;
const ZERO_VELOCITY = `SELECT 0 FROM (SELECT ? AS station_id, ? AS from_at, ? AS to_at)`;

export function rewriteDuplicateVelocityRead(sql, chatEnabled = true) {
  const text = String(sql || '');
  if (!chatEnabled || !text.includes('INSERT INTO sh_channel_snapshots')) return text;
  return text.includes(VELOCITY_SUM) ? text.replace(VELOCITY_SUM, ZERO_VELOCITY) : text;
}

export function withDuplicateVelocityReadRemoved(env) {
  if (!env?.DB || Number(env.CHAT_LIMIT ?? 50) <= 0) return env;
  const db = env.DB;
  const optimizedDb = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => target.prepare(rewriteDuplicateVelocityRead(sql, true));
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
