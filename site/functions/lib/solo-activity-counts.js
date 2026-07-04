import { num } from './api-utils.js';

const MINUTE_MS = 60_000;

function eventTime(item, fallback) {
  const milliseconds = num(item?.chat_time_ms);
  if (milliseconds != null) return milliseconds;
  const seconds = num(item?.chat_time);
  return seconds != null ? seconds * 1000 : fallback;
}

function dayKey(timestamp) {
  return new Date(timestamp + 9 * 3_600_000).toISOString().slice(0, 10);
}

async function currentVelocity(db, sessionId, observedAt, lastObservedAt) {
  if (!lastObservedAt || observedAt - lastObservedAt > 120_000) return 0;
  const row = await db.prepare(`SELECT COALESCE(SUM(item_count),0) AS value
    FROM sh_solo_activity_minutes
    WHERE session_id=? AND bucket_start>=? AND bucket_start<=?`)
    .bind(sessionId, observedAt - 120_000, observedAt)
    .first();
  return num(row?.value) ?? 0;
}

async function updateVelocityIfChanged(db, sessionId, observedAt, velocity) {
  const result = await db.prepare(`UPDATE sh_host_station_snapshots SET comment_velocity=?
    WHERE id=(SELECT id FROM sh_host_station_snapshots
      WHERE session_id=? AND observed_at<=?
      ORDER BY observed_at DESC,id DESC LIMIT 1)
      AND COALESCE(comment_velocity,-1)<>?`)
    .bind(velocity, sessionId, observedAt, velocity)
    .run();
  return Number(result?.meta?.changes || 0) > 0;
}

export async function saveSoloActivityCounts(db, observedAt, data) {
  const sessionId = num(data?.session_id);
  if (sessionId == null) return { accepted: 0, total: 0, velocityUpdated: false };

  const items = Array.isArray(data?.comments) ? data.comments : [];
  const state = await db.prepare(`SELECT last_item_id,total_count,last_observed_at
    FROM sh_solo_activity_state WHERE session_id=?`).bind(sessionId).first();
  const lastItemId = num(state?.last_item_id) ?? 0;
  const unique = new Map();
  for (const item of items) {
    const id = num(item?.comment_id);
    if (id != null && id > lastItemId) unique.set(id, item);
  }
  const fresh = [...unique.entries()].sort((left, right) => left[0] - right[0]);
  const total = (num(state?.total_count) ?? 0) + fresh.length;
  let lastObservedAt = num(state?.last_observed_at) ?? 0;

  if (fresh.length) {
    const minutes = new Map();
    const days = new Map();
    for (const [, item] of fresh) {
      const timestamp = eventTime(item, observedAt);
      const minute = Math.floor(timestamp / MINUTE_MS) * MINUTE_MS;
      minutes.set(minute, (minutes.get(minute) || 0) + 1);
      const day = dayKey(timestamp);
      days.set(day, (days.get(day) || 0) + 1);
      lastObservedAt = Math.max(lastObservedAt, timestamp);
    }

    const stationId = num(data?.station_id ?? fresh[0]?.[1]?.station_id);
    const latestId = fresh.at(-1)[0];
    const statements = [];
    for (const [minute, count] of minutes) {
      statements.push(db.prepare(`INSERT INTO sh_solo_activity_minutes(
          session_id,bucket_start,item_count
        ) VALUES(?,?,?) ON CONFLICT(session_id,bucket_start) DO UPDATE SET
          item_count=sh_solo_activity_minutes.item_count+excluded.item_count`)
        .bind(sessionId, minute, count));
    }
    for (const [day, count] of days) {
      statements.push(db.prepare(`INSERT INTO sh_solo_activity_days(
          session_id,day_key,item_count
        ) VALUES(?,?,?) ON CONFLICT(session_id,day_key) DO UPDATE SET
          item_count=sh_solo_activity_days.item_count+excluded.item_count`)
        .bind(sessionId, day, count));
    }
    statements.push(
      db.prepare(`INSERT INTO sh_solo_activity_state(
          session_id,station_id,last_item_id,total_count,last_observed_at
        ) VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
          station_id=COALESCE(excluded.station_id,sh_solo_activity_state.station_id),
          last_item_id=MAX(sh_solo_activity_state.last_item_id,excluded.last_item_id),
          total_count=excluded.total_count,
          last_observed_at=MAX(sh_solo_activity_state.last_observed_at,excluded.last_observed_at)`)
        .bind(sessionId, stationId, latestId, total, lastObservedAt),
      db.prepare(`UPDATE sh_host_broadcast_sessions SET comment_count=?
        WHERE id=? AND COALESCE(comment_count,-1)<>?`).bind(total, sessionId, total),
    );
    await db.batch(statements);
  }

  const velocity = await currentVelocity(db, sessionId, observedAt, lastObservedAt);
  const velocityUpdated = await updateVelocityIfChanged(db, sessionId, observedAt, velocity);
  if (fresh.length) {
    const stationId = num(data?.station_id ?? fresh[0]?.[1]?.station_id) || 0;
    const latestId = fresh.at(-1)[0];
    try {
      await db.prepare(`INSERT OR IGNORE INTO sh_comment_velocity_samples(
        source_scope,station_id,session_id,observed_at,comment_velocity,latest_comment_id
      ) VALUES('solo',?,?,?,?,?)`).bind(
        stationId, sessionId, observedAt, velocity, latestId,
      ).run();
    } catch (error) {
      if (!/no such table/i.test(String(error?.message || ''))) throw error;
    }
  }
  return { accepted: fresh.length, total, velocity, velocityUpdated };
}
