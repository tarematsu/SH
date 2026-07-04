import { num } from './api-utils.js';

const MINUTE_MS = 60_000;
const initialized = new WeakSet();

function eventTime(item, fallback) {
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
    db.prepare(`CREATE TABLE IF NOT EXISTS sh_solo_activity_state (
      session_id INTEGER PRIMARY KEY,
      station_id INTEGER,
      last_item_id INTEGER NOT NULL DEFAULT 0,
      total_count INTEGER NOT NULL DEFAULT 0,
      last_observed_at INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sh_solo_activity_minutes (
      session_id INTEGER NOT NULL,
      bucket_start INTEGER NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(session_id,bucket_start)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sh_solo_activity_days (
      session_id INTEGER NOT NULL,
      day_key TEXT NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(session_id,day_key)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sh_solo_activity_migration (
      id INTEGER PRIMARY KEY CHECK(id=1),
      migrated_at INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare('INSERT OR IGNORE INTO sh_solo_activity_migration(id,migrated_at) VALUES(1,0)'),
  ]);

  const migration = await db.prepare(
    'SELECT migrated_at FROM sh_solo_activity_migration WHERE id=1',
  ).first();
  if (!num(migration?.migrated_at)) {
    await db.batch([
      db.prepare(`INSERT INTO sh_solo_activity_minutes(session_id,bucket_start,item_count)
        SELECT session_id,
               CAST(COALESCE(chat_time_ms,chat_time*1000,observed_at)/60000 AS INTEGER)*60000,
               COUNT(*)
        FROM sh_host_comments
        GROUP BY session_id,CAST(COALESCE(chat_time_ms,chat_time*1000,observed_at)/60000 AS INTEGER)
        ON CONFLICT(session_id,bucket_start) DO UPDATE SET item_count=excluded.item_count`),
      db.prepare(`INSERT INTO sh_solo_activity_days(session_id,day_key,item_count)
        SELECT session_id,
               date(COALESCE(chat_time_ms,chat_time*1000,observed_at)/1000,'unixepoch','+9 hours'),
               COUNT(*)
        FROM sh_host_comments
        GROUP BY session_id,date(COALESCE(chat_time_ms,chat_time*1000,observed_at)/1000,'unixepoch','+9 hours')
        ON CONFLICT(session_id,day_key) DO UPDATE SET item_count=excluded.item_count`),
      db.prepare(`INSERT INTO sh_solo_activity_state(
          session_id,station_id,last_item_id,total_count,last_observed_at
        )
        SELECT comments.session_id,MAX(comments.station_id),MAX(comments.comment_id),
               MAX(COALESCE(sessions.comment_count,0)),MAX(comments.observed_at)
        FROM sh_host_comments comments
        LEFT JOIN sh_host_broadcast_sessions sessions ON sessions.id=comments.session_id
        GROUP BY comments.session_id
        ON CONFLICT(session_id) DO UPDATE SET
          station_id=COALESCE(excluded.station_id,sh_solo_activity_state.station_id),
          last_item_id=MAX(sh_solo_activity_state.last_item_id,excluded.last_item_id),
          total_count=MAX(sh_solo_activity_state.total_count,excluded.total_count),
          last_observed_at=MAX(sh_solo_activity_state.last_observed_at,excluded.last_observed_at)`),
      db.prepare(`UPDATE sh_host_broadcast_sessions
        SET comment_count=COALESCE((
          SELECT total_count FROM sh_solo_activity_state WHERE session_id=sh_host_broadcast_sessions.id
        ),comment_count,0)`),
      db.prepare('DELETE FROM sh_host_comments'),
      db.prepare('UPDATE sh_solo_activity_migration SET migrated_at=? WHERE id=1').bind(now),
    ]);
  }
  initialized.add(db);
}

export async function saveSoloActivityCounts(db, observedAt, data) {
  await ensureTables(db, observedAt);
  const sessionId = num(data?.session_id);
  if (sessionId == null) return { accepted: 0, total: 0 };
  const items = Array.isArray(data?.comments) ? data.comments : [];
  const state = await db.prepare(
    'SELECT last_item_id,total_count FROM sh_solo_activity_state WHERE session_id=?',
  ).bind(sessionId).first();
  const lastItemId = num(state?.last_item_id) ?? 0;
  const unique = new Map();
  for (const item of items) {
    const id = num(item?.comment_id);
    if (id != null && id > lastItemId) unique.set(id, item);
  }
  const fresh = [...unique.entries()].sort((left, right) => left[0] - right[0]);
  const total = (num(state?.total_count) ?? 0) + fresh.length;
  if (!fresh.length) return { accepted: 0, total };

  const minutes = new Map();
  const days = new Map();
  for (const [, item] of fresh) {
    const timestamp = eventTime(item, observedAt);
    const minute = Math.floor(timestamp / MINUTE_MS) * MINUTE_MS;
    minutes.set(minute, (minutes.get(minute) || 0) + 1);
    const day = dayKey(timestamp);
    days.set(day, (days.get(day) || 0) + 1);
  }

  const stationId = num(data?.station_id ?? fresh[0]?.[1]?.station_id);
  const latestId = fresh.at(-1)[0];
  const statements = [];
  for (const [minute, count] of minutes) {
    statements.push(db.prepare(`INSERT INTO sh_solo_activity_minutes(session_id,bucket_start,item_count)
      VALUES(?,?,?) ON CONFLICT(session_id,bucket_start) DO UPDATE SET
      item_count=sh_solo_activity_minutes.item_count+excluded.item_count`).bind(sessionId, minute, count));
  }
  for (const [day, count] of days) {
    statements.push(db.prepare(`INSERT INTO sh_solo_activity_days(session_id,day_key,item_count)
      VALUES(?,?,?) ON CONFLICT(session_id,day_key) DO UPDATE SET
      item_count=sh_solo_activity_days.item_count+excluded.item_count`).bind(sessionId, day, count));
  }
  statements.push(
    db.prepare(`INSERT INTO sh_solo_activity_state(
        session_id,station_id,last_item_id,total_count,last_observed_at
      ) VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
        station_id=COALESCE(excluded.station_id,sh_solo_activity_state.station_id),
        last_item_id=MAX(sh_solo_activity_state.last_item_id,excluded.last_item_id),
        total_count=excluded.total_count,
        last_observed_at=MAX(sh_solo_activity_state.last_observed_at,excluded.last_observed_at)`)
      .bind(sessionId, stationId, latestId, total, observedAt),
    db.prepare('UPDATE sh_host_broadcast_sessions SET comment_count=? WHERE id=?').bind(total, sessionId),
    db.prepare(`UPDATE sh_host_station_snapshots SET comment_velocity=(
        SELECT COALESCE(SUM(item_count),0) FROM sh_solo_activity_minutes
        WHERE session_id=? AND bucket_start>=? AND bucket_start<=?
      ) WHERE id=(SELECT id FROM sh_host_station_snapshots
        WHERE session_id=? AND observed_at<=? ORDER BY observed_at DESC,id DESC LIMIT 1)`)
      .bind(sessionId, observedAt - 120_000, observedAt, sessionId, observedAt),
  );
  await db.batch(statements);
  const velocity = await db.prepare(`SELECT COALESCE(SUM(item_count),0) AS value
    FROM sh_solo_activity_minutes WHERE session_id=? AND bucket_start>=? AND bucket_start<=?`)
    .bind(sessionId, observedAt - 120_000, observedAt).first();
  try {
    await db.prepare(`INSERT OR REPLACE INTO sh_comment_velocity_samples(
      source_scope,station_id,session_id,observed_at,comment_velocity,latest_comment_id
    ) VALUES('solo',?,?,?,?,?)`).bind(
      stationId || 0, sessionId, observedAt, num(velocity?.value) ?? 0, latestId,
    ).run();
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || ''))) throw error;
  }
  return { accepted: fresh.length, total };
}
