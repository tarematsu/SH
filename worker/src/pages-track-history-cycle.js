import { runTrackHistoryHourlyStep } from './pages-track-history-hourly.js';

const MINUTE_MS = 60_000;
const LEGACY_STAGE_KEY = 'track-history-hourly-stage';
export const TRACK_HISTORY_CYCLE_MS = 6 * 60 * 60_000;
export const TRACK_HISTORY_ACTIVE_MINUTES = 60;

const SHARD_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS sh_pages_payload_read_model (
    model_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sh_pages_track_history_read_model (
    row_key TEXT PRIMARY KEY,
    play_date TEXT NOT NULL,
    first_played_at INTEGER,
    row_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sh_pages_track_history_date
    ON sh_pages_track_history_read_model(play_date,first_played_at,row_key)`,
];

function parsedPayload(row) {
  try {
    return row?.payload_json ? JSON.parse(row.payload_json) : null;
  } catch {
    return null;
  }
}

async function ensureShardSchema(db) {
  await db.batch(SHARD_SCHEMA_SQL.map((sql) => db.prepare(sql)));
}

async function loadPayload(db, key) {
  try {
    const row = await db.prepare(`SELECT payload_json
      FROM sh_pages_payload_read_model
      WHERE model_key=?
      LIMIT 1`).bind(key).first();
    return parsedPayload(row);
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || error))) throw error;
    await ensureShardSchema(db);
    return null;
  }
}

function cycleAwareLoadPayload(baseLoad, cycleStart) {
  return async (db, key) => {
    const payload = await baseLoad(db, key);
    if (key !== LEGACY_STAGE_KEY || !payload?.published) return payload;

    const publishedAt = Number(payload.published_at);
    if (!Number.isFinite(publishedAt) || publishedAt < cycleStart) return payload;

    // A legacy hourly generation may finish after crossing into this cycle.
    // Treat that publication as the cycle's generation so the hourly core
    // cannot immediately create a second stage in the remaining active slots.
    return payload.generation === cycleStart
      ? payload
      : { ...payload, generation: cycleStart };
  };
}

export async function runTrackHistoryCycleStep(env, now = Date.now(), dependencies = {}) {
  const timestamp = Number(now);
  const cycleStart = Math.floor(timestamp / TRACK_HISTORY_CYCLE_MS) * TRACK_HISTORY_CYCLE_MS;
  const cycleMinute = Math.floor((timestamp - cycleStart) / MINUTE_MS);
  if (cycleMinute >= TRACK_HISTORY_ACTIVE_MINUTES) {
    return {
      skipped: true,
      reason: 'track-history-cycle-idle',
      generated_at: timestamp,
      task: {
        kind: 'track-history-idle',
        // The persisted key is retained for compatibility with in-flight stages.
        key: LEGACY_STAGE_KEY,
        cycle_start: cycleStart,
        cycle_minute: cycleMinute,
      },
      responses: [],
      failed: 0,
    };
  }

  const activeDependencies = {
    ...dependencies,
    loadPayload: cycleAwareLoadPayload(dependencies.loadPayload || loadPayload, cycleStart),
  };
  return runTrackHistoryHourlyStep(env, timestamp, activeDependencies);
}
