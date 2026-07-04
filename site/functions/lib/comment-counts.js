import { num } from './api-utils.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const initialized = new WeakSet();

function timestampOf(item, fallback) {
  const milliseconds = num(item?.chat_time_ms);
  if (milliseconds != null) return milliseconds;
  const seconds = num(item?.chat_time);
  return seconds != null ? seconds * 1000 : fallback;
}

function dayKey(timestamp) {
  return new Date(timestamp + 9 * 3_600_000).toISOString().slice(0, 10);
}

async function ensureTables(db, now) {
  if (initialized.has(db)) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS sh_activity_state_v2 (
      station_id INTEGER PRIMARY KEY,
      last_item_id INTEGER NOT NULL DEFAULT 0,
      total_count INTEGER NOT NULL DEFAULT 0,
      last_observed_at INTEGER NOT NULL DEFAULT 0,
      last_cleanup_at INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sh_activity_minutes_v2 (
      station_id INTEGER NOT NULL,
      bucket_start INTEGER NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(station_id,bucket_start)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sh_activity_days_v2 (
      station_id INTEGER NOT NULL,
      day_key TEXT NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(station_id,day_key)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sh_activity_migration_v2 (
      id INTEGER PRIMARY KEY CHECK(id=1),
      migrated_at INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare('INSERT OR IGNORE INTO sh_activity_migration_v2(id,migrated_at) VALUES(1,0)'),
  ]);
  const migration = await db.prepare(
    'SELECT migrated_at FROM sh_activity_migration_v2 WHERE id=1',
  ).first();
  if (!num(migration?.migrated_at)) {
    await db.batch([
      db.prepare(`INSERT INTO sh_activity_minutes_v2(station_id,bucket_start,item_count)
        SELECT station_id,
               CAST(COALESCE(chat_time_ms,chat_time*1000,observed_at)/60000 AS INTEGER)*60000,
               COUNT(*)
        FROM sh_comments WHERE station_id IS NOT NULL
        GROUP BY station_id,CAST(COALESCE(chat_time_ms,chat_time*1000,observed_at)/60000 AS INTEGER)
        ON CONFLICT(station_id,bucket_start) DO UPDATE SET item_count=excluded.item_count`),
      db.prepare(`INSERT INTO sh_activity_days_v2(station_id,day_key,item_count)
        SELECT station_id,
               date(COALESCE(chat_time_ms,chat_time*1000,observed_at)/1000,'unixepoch','+9 hours'),
               COUNT(*)
        FROM sh_comments WHERE station_id IS NOT NULL
        GROUP BY station_id,date(COALESCE(chat_time_ms,chat_time*1000,observed_at)/1000,'unixepoch','+9 hours')
        ON CONFLICT(station_id,day_key) DO UPDATE SET item_count=excluded.item_count`),
      db.prepare(`INSERT INTO sh_activity_state_v2(
          station_id,last_item_id,total_count,last_observed_at,last_cleanup_at
        )
        SELECT station_id,MAX(id),COUNT(*),MAX(observed_at),?
        FROM sh_comments WHERE station_id IS NOT NULL GROUP BY station_id
        ON CONFLICT(station_id) DO UPDATE SET
          last_item_id=MAX(sh_activity_state_v2.last_item_id,excluded.last_item_id),
          total_count=MAX(sh_activity_state_v2.total_count,excluded.total_count),
          last_observed_at=MAX(sh_activity_state_v2.last_observed_at,excluded.last_observed_at),
          last_cleanup_at=excluded.last_cleanup_at`).bind(now),
      db.prepare('DELETE FROM sh_comments'),
      db.prepare('UPDATE sh_activity_migration_v2 SET migrated_at=? WHERE id=1').bind(now),
    ]);
  }
  initialized.add(db);
}

export async function saveCommentCounts(db, observedAt, data) {
  await ensureTables(db, observedAt);
  const items = Array.isArray(data?.comments) ? data.comments : [];
  const stationId = num(data?.station_id ?? items.find((item) => num(item?.station_id) != null)?.station_id);
  if (stationId == null) return { accepted: 0, total: 0 };
  const state = await db.prepare(
    `SELECT last_item_id,total_count,last_cleanup_at
     FROM sh_activity_state_v2 WHERE station_id=?`,
  ).bind(stationId).first();
  const lastItemId = num(state?.last_item_id) ?? 0;
  const unique = new Map();
  for (const item of items) {
    const id = num(item?.id);
    if (id != null && id > lastItemId) unique.set(id, item);
  }
  const fresh = [...unique.entries()].sort((left, right) => left[0] - right[0]);
  const total = (num(state?.total_count) ?? 0) + fresh.length;
  if (!fresh.length) return { accepted: 0, total };

  const minutes = new Map();
  const days = new Map();
  for (const [, item] of fresh) {
    const timestamp = timestampOf(item, observedAt);
    const minute = Math.floor(timestamp / MINUTE_MS) * MINUTE_MS;
    minutes.set(minute, (minutes.get(minute) || 0) + 1);
    const day = dayKey(timestamp);
    days.set(day, (days.get(day) || 0) + 1);
  }
  const statements = [];
  for (const [minute, count] of minutes) {
    statements.push(db.prepare(`INSERT INTO sh_activity_minutes_v2(station_id,bucket_start,item_count)
      VALUES(?,?,?) ON CONFLICT(station_id,bucket_start) DO UPDATE SET
      item_count=sh_activity_minutes_v2.item_count+excluded.item_count`).bind(stationId, minute, count));
  }
  for (const [day, count] of days) {
    statements.push(db.prepare(`INSERT INTO sh_activity_days_v2(station_id,day_key,item_count)
      VALUES(?,?,?) ON CONFLICT(station_id,day_key) DO UPDATE SET
      item_count=sh_activity_days_v2.item_count+excluded.item_count`).bind(stationId, day, count));
  }
  const lastCleanupAt = num(state?.last_cleanup_at) ?? 0;
  const cleanupDue = observedAt - lastCleanupAt >= DAY_MS;
  statements.push(
    db.prepare(`INSERT INTO sh_activity_state_v2(
        station_id,last_item_id,total_count,last_observed_at,last_cleanup_at
      ) VALUES(?,?,?,?,?) ON CONFLICT(station_id) DO UPDATE SET
        last_item_id=MAX(sh_activity_state_v2.last_item_id,excluded.last_item_id),
        total_count=excluded.total_count,
        last_observed_at=MAX(sh_activity_state_v2.last_observed_at,excluded.last_observed_at),
        last_cleanup_at=MAX(sh_activity_state_v2.last_cleanup_at,excluded.last_cleanup_at)`)
      .bind(stationId, fresh.at(-1)[0], total, observedAt, cleanupDue ? observedAt : lastCleanupAt),
    db.prepare(`UPDATE sh_channel_snapshots SET comment_velocity=(
        SELECT COALESCE(SUM(item_count),0) FROM sh_activity_minutes_v2
        WHERE station_id=? AND bucket_start>=? AND bucket_start<=?
      ) WHERE id=(SELECT id FROM sh_channel_snapshots
        WHERE station_id=? AND observed_at<=? ORDER BY observed_at DESC,id DESC LIMIT 1)`)
      .bind(stationId, observedAt - 120_000, observedAt, stationId, observedAt),
  );
  if (cleanupDue) {
    statements.push(db.prepare(
      'DELETE FROM sh_activity_minutes_v2 WHERE bucket_start<?',
    ).bind(observedAt - 2 * DAY_MS));
  }
  await db.batch(statements);
  return { accepted: fresh.length, total };
}
