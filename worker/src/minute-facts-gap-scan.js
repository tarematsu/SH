import { enqueueMinuteFactJob } from './minute-facts-inbox.js';
import { minuteBucket, timestampMs } from './minute-facts-store.js';

const MINUTE_MS = 60_000;
const DEFAULT_WINDOW_MINUTES = 360;
const DEFAULT_MAX_JOBS = 4;
const DEFAULT_RECENT_GUARD_MS = 5 * MINUTE_MS;
const DEFAULT_MAX_CARRY_MINUTES = 360;
const MAX_WINDOW_MINUTES = 1_440;

export const GAP_SCAN_STATE_KEY = 'minute-facts-gap-scan-v1';
export const GAP_SCAN_STATE_SQL = `CREATE TABLE IF NOT EXISTS sh_minute_fact_gap_scan_state (
  scan_key TEXT PRIMARY KEY,
  next_to INTEGER NOT NULL DEFAULT 0,
  earliest_source_minute INTEGER,
  last_from INTEGER,
  last_to INTEGER,
  expected_minutes INTEGER NOT NULL DEFAULT 0,
  missing_minutes INTEGER NOT NULL DEFAULT 0,
  source_gap_minutes INTEGER NOT NULL DEFAULT 0,
  enqueued_jobs INTEGER NOT NULL DEFAULT 0,
  skipped_existing INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
)`;

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function positiveInteger(value, fallback, maximum) {
  const parsed = integer(value);
  if (parsed == null || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function compactSnapshot(row = {}) {
  return {
    id: integer(row.id),
    observed_at: integer(row.observed_at),
    channel_id: integer(row.channel_id),
    channel_alias: row.channel_alias || null,
    channel_name: row.channel_name || null,
    station_id: integer(row.station_id),
    is_launched: integer(row.is_launched),
    is_broadcasting: integer(row.is_broadcasting),
    chat_status: row.chat_status || null,
    listener_count: integer(row.listener_count),
    online_member_count: integer(row.online_member_count),
    total_member_count: integer(row.total_member_count),
    guest_count: integer(row.guest_count),
    total_listens: integer(row.total_listens),
    stream_goal: integer(row.stream_goal),
    current_stream_count: integer(row.current_stream_count),
    host_account_id: integer(row.host_account_id),
    host_handle: row.host_handle || null,
    broadcast_start_time: integer(row.broadcast_start_time),
  };
}

function snapshotPayload(row) {
  const snapshot = compactSnapshot(row);
  delete snapshot.id;
  delete snapshot.observed_at;
  return snapshot;
}

function sameBroadcast(left, right) {
  return left?.channel_id === right?.channel_id
    && left?.station_id === right?.station_id
    && left?.is_broadcasting === right?.is_broadcasting
    && (left?.broadcast_start_time ?? null) === (right?.broadcast_start_time ?? null);
}

function candidate(row, minuteAt, mode) {
  return {
    minuteAt,
    observedAt: mode === 'exact' ? row.observed_at : minuteAt + 30_000,
    snapshot: snapshotPayload(row),
    rebuild: {
      source: 'minute_gap_scan',
      mode,
      source_snapshot_id: row.id,
      source_observed_at: row.observed_at,
    },
  };
}

export function buildExpectedMinuteCandidates(rows = [], options = {}) {
  const from = integer(options.from);
  const to = integer(options.to);
  const maxCarryMinutes = positiveInteger(
    options.maxCarryMinutes,
    DEFAULT_MAX_CARRY_MINUTES,
    MAX_WINDOW_MINUTES,
  );
  if (from == null || to == null || from >= to) return { candidates: [], sourceGapMinutes: 0 };

  const sorted = rows.map(compactSnapshot)
    .filter((row) => row.observed_at != null && row.channel_id != null)
    .sort((a, b) => a.observed_at - b.observed_at || a.id - b.id);
  const byKey = new Map();
  let sourceGapMinutes = 0;
  let previous = null;

  for (const row of sorted) {
    const currentMinute = minuteBucket(row.observed_at);
    if (previous && sameBroadcast(previous, row)) {
      const previousMinute = minuteBucket(previous.observed_at);
      const gapMinutes = Math.max(0, Math.round((currentMinute - previousMinute) / MINUTE_MS) - 1);
      if (gapMinutes > 0) {
        sourceGapMinutes += gapMinutes;
        if (gapMinutes <= maxCarryMinutes) {
          for (let minute = previousMinute + MINUTE_MS; minute < currentMinute; minute += MINUTE_MS) {
            if (minute >= from && minute < to) {
              byKey.set(`${previous.channel_id}:${minute}`, candidate(previous, minute, 'carry_forward'));
            }
          }
        }
      }
    }
    if (currentMinute >= from && currentMinute < to) {
      byKey.set(`${row.channel_id}:${currentMinute}`, candidate(row, currentMinute, 'exact'));
    }
    previous = row;
  }

  return {
    candidates: [...byKey.values()].sort((a, b) => a.minuteAt - b.minuteAt),
    sourceGapMinutes,
  };
}

export function nextGapScanCursor({ from, to, earliest, cutoff, missingCount }) {
  if (Number(missingCount) > 0) return to;
  return from <= earliest ? cutoff : from;
}

async function ensureState(env) {
  await env.MINUTE_DB.prepare(GAP_SCAN_STATE_SQL).run();
  await env.MINUTE_DB.prepare(`INSERT OR IGNORE INTO sh_minute_fact_gap_scan_state(scan_key,updated_at)
    VALUES(?,?)`).bind(GAP_SCAN_STATE_KEY, Date.now()).run();
  return env.MINUTE_DB.prepare(`SELECT * FROM sh_minute_fact_gap_scan_state WHERE scan_key=?`)
    .bind(GAP_SCAN_STATE_KEY).first();
}

async function sourceBounds(env, cutoff) {
  return env.DB.prepare(`SELECT MIN(observed_at) AS earliest_observed_at
    FROM sh_channel_snapshots WHERE observed_at<?`).bind(cutoff).first();
}

async function loadSnapshots(env, from, to) {
  const previous = await env.DB.prepare(`SELECT id,observed_at,channel_id,channel_alias,channel_name,station_id,
      is_launched,is_broadcasting,chat_status,listener_count,online_member_count,total_member_count,
      guest_count,total_listens,stream_goal,current_stream_count,host_account_id,host_handle,broadcast_start_time
    FROM sh_channel_snapshots WHERE observed_at<? ORDER BY observed_at DESC,id DESC LIMIT 1`)
    .bind(from).first();
  const result = await env.DB.prepare(`SELECT id,observed_at,channel_id,channel_alias,channel_name,station_id,
      is_launched,is_broadcasting,chat_status,listener_count,online_member_count,total_member_count,
      guest_count,total_listens,stream_goal,current_stream_count,host_account_id,host_handle,broadcast_start_time
    FROM sh_channel_snapshots WHERE observed_at>=? AND observed_at<?
    ORDER BY observed_at ASC,id ASC LIMIT 2001`).bind(from, to).all();
  const rows = result.results || [];
  if (rows.length > 2000) throw new Error('minute fact gap scan snapshot window exceeded 2000 rows');
  return previous ? [previous, ...rows] : rows;
}

async function existingKeys(env, candidates) {
  const keys = new Set();
  const byChannel = new Map();
  for (const item of candidates) {
    const channelId = integer(item.snapshot?.channel_id);
    if (channelId == null) continue;
    if (!byChannel.has(channelId)) byChannel.set(channelId, []);
    byChannel.get(channelId).push(item.minuteAt);
  }
  for (const [channelId, minutes] of byChannel) {
    const unique = [...new Set(minutes)];
    for (let offset = 0; offset < unique.length; offset += 70) {
      const part = unique.slice(offset, offset + 70);
      const result = await env.MINUTE_DB.prepare(`SELECT channel_id,minute_at FROM sh_minute_facts
        WHERE channel_id=? AND minute_at IN (${part.map(() => '?').join(',')})`)
        .bind(channelId, ...part).all();
      for (const row of result.results || []) keys.add(`${row.channel_id}:${row.minute_at}`);
    }
  }
  return keys;
}

async function loadHistoricalQueue(env, item) {
  if (Number(item.snapshot?.is_broadcasting) === 0 || item.snapshot?.station_id == null) return null;
  const row = await env.DB.prepare(`SELECT observed_at,station_id,queue_id,start_time,is_paused,raw_json
    FROM sh_queue_snapshots WHERE station_id IS ? AND observed_at<=?
    ORDER BY observed_at DESC,id DESC LIMIT 1`)
    .bind(item.snapshot.station_id, item.observedAt).first();
  if (!row) return null;
  let queue;
  try { queue = JSON.parse(String(row.raw_json || 'null')); } catch { return null; }
  if (!queue || !Array.isArray(queue.tracks)) return null;
  const queueStart = timestampMs(queue.start_time ?? row.start_time);
  const broadcastStart = timestampMs(item.snapshot.broadcast_start_time);
  if (broadcastStart != null && queueStart != null && queueStart < broadcastStart - 5 * MINUTE_MS) return null;
  return {
    ...queue,
    station_id: integer(queue.station_id ?? row.station_id),
    queue_id: integer(queue.queue_id ?? row.queue_id),
    start_time: integer(queue.start_time ?? row.start_time),
    is_paused: integer(queue.is_paused ?? row.is_paused),
  };
}

async function commentCounts(env, candidates) {
  const result = new Map();
  const pairs = candidates.filter((item) => item.snapshot?.station_id != null);
  if (!pairs.length) return result;
  const stationIds = [...new Set(pairs.map((item) => item.snapshot.station_id))];
  const minutes = [...new Set(pairs.map((item) => item.minuteAt))];
  const rows = await env.DB.prepare(`SELECT station_id,bucket_start,comment_count FROM sh_comment_minute_counts
    WHERE station_id IN (${stationIds.map(() => '?').join(',')})
      AND bucket_start IN (${minutes.map(() => '?').join(',')})`)
    .bind(...stationIds, ...minutes).all();
  for (const row of rows.results || []) result.set(`${row.station_id}:${row.bucket_start}`, Number(row.comment_count));
  return result;
}

export async function runMinuteFactsGapScan(env, dependencies = {}) {
  if (!env?.DB || !env?.MINUTE_DB) throw new Error('minute fact gap scan DB binding is missing');
  const now = dependencies.now ? dependencies.now() : Date.now();
  const windowMinutes = positiveInteger(env.GAP_SCAN_WINDOW_MINUTES, DEFAULT_WINDOW_MINUTES, MAX_WINDOW_MINUTES);
  const maxJobs = positiveInteger(env.GAP_SCAN_MAX_JOBS, DEFAULT_MAX_JOBS, 20);
  const guardMs = positiveInteger(env.GAP_SCAN_RECENT_GUARD_MS, DEFAULT_RECENT_GUARD_MS, 24 * 60 * MINUTE_MS);
  const maxCarryMinutes = positiveInteger(env.GAP_SCAN_MAX_CARRY_MINUTES, DEFAULT_MAX_CARRY_MINUTES, MAX_WINDOW_MINUTES);
  const cutoff = minuteBucket(now - guardMs);
  const state = await ensureState(env);
  const bounds = await sourceBounds(env, cutoff);
  const earliest = minuteBucket(bounds?.earliest_observed_at);
  if (earliest == null) return { event: 'minute_fact_gap_scan_summary', skipped: true, reason: 'no-source-data' };

  let to = integer(state?.next_to);
  if (to == null || to <= earliest || to > cutoff) to = cutoff;
  const from = Math.max(earliest, to - windowMinutes * MINUTE_MS);

  try {
    const rows = await loadSnapshots(env, from, to);
    const built = buildExpectedMinuteCandidates(rows, { from, to, maxCarryMinutes });
    const existing = await existingKeys(env, built.candidates);
    const missing = built.candidates.filter((item) => !existing.has(`${item.snapshot.channel_id}:${item.minuteAt}`));
    const attempted = missing.slice(0, maxJobs);
    const comments = await commentCounts(env, attempted);
    let enqueued = 0;
    for (const item of attempted) {
      const queue = await loadHistoricalQueue(env, item);
      const commentCount = comments.get(`${item.snapshot.station_id}:${item.minuteAt}`);
      const accepted = await enqueueMinuteFactJob(env, {
        observedAt: item.observedAt,
        snapshot: item.snapshot,
        queue,
        comments: item.snapshot.station_id == null
          ? { commentCount: null, commentTotal: null, degraded: true }
          : { commentCount: commentCount ?? null, commentTotal: null, degraded: commentCount == null },
        rebuild: item.rebuild,
      }, {
        jobKind: 'rebuild',
        jobPriority: item.rebuild.mode === 'exact' ? 30 : 15,
        requeueCompleted: true,
      });
      if (accepted?.enqueued) enqueued += 1;
    }

    const nextTo = nextGapScanCursor({
      from,
      to,
      earliest,
      cutoff,
      missingCount: missing.length,
    });
    await env.MINUTE_DB.prepare(`UPDATE sh_minute_fact_gap_scan_state SET
      next_to=?,earliest_source_minute=?,last_from=?,last_to=?,expected_minutes=?,
      missing_minutes=?,source_gap_minutes=?,enqueued_jobs=enqueued_jobs+?,
      skipped_existing=skipped_existing+?,last_error=NULL,updated_at=? WHERE scan_key=?`)
      .bind(
        nextTo, earliest, from, to, built.candidates.length, missing.length,
        built.sourceGapMinutes, enqueued, existing.size, now, GAP_SCAN_STATE_KEY,
      ).run();

    const summary = {
      event: 'minute_fact_gap_scan_summary',
      from,
      to,
      expected_minutes: built.candidates.length,
      missing_minutes: missing.length,
      source_gap_minutes: built.sourceGapMinutes,
      attempted_jobs: attempted.length,
      enqueued,
      remaining_missing: Math.max(0, missing.length - enqueued),
      window_blocked: missing.length > 0,
      next_to: nextTo,
    };
    console.log(JSON.stringify(summary));
    return summary;
  } catch (error) {
    await env.MINUTE_DB.prepare(`UPDATE sh_minute_fact_gap_scan_state SET last_error=?,updated_at=? WHERE scan_key=?`)
      .bind(String(error?.message || error).slice(0, 1000), now, GAP_SCAN_STATE_KEY).run().catch(() => {});
    throw error;
  }
}
