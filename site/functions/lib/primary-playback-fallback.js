import { FACTS_FRESH_MS } from './dashboard-facts.js';
import {
  LATEST_QUEUE_WITH_ITEMS_SQL,
  parseLatestQueueRows,
  parseLatestSnapshotRow,
} from './latest-queue.js';
import { computePlayback, normalizePlaybackTrack } from './playback.js';
import { hostIdentity, queueRevision, stateFromQueue } from './queue-state.js';

// Retained for rollback callers that import the legacy query directly. The
// production fallback now receives these columns from LATEST_QUEUE_WITH_ITEMS_SQL.
export const CANONICAL_PLAYBACK_SNAPSHOT_SQL = `SELECT
  observed_at,channel_id,station_id,is_broadcasting,host_account_id,host_handle
FROM sh_channel_snapshots
ORDER BY observed_at DESC,id DESC
LIMIT 1`;

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function storedBoolean(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null || value === '') return false;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function text(value) {
  const parsed = String(value ?? '').trim();
  return parsed || null;
}

export async function loadCanonicalPlaybackPayload(db, generatedAt = Date.now()) {
  if (!db) return null;
  const queueResult = await db.prepare(LATEST_QUEUE_WITH_ITEMS_SQL).all();
  const rows = queueResult.results || [];
  const snapshot = parseLatestSnapshotRow(rows[0]);
  const { latestQueue, queue } = parseLatestQueueRows(rows);
  if (!snapshot || !latestQueue || !queue.length) return null;

  const playback = computePlayback(queue, generatedAt);
  const paused = storedBoolean(latestQueue.is_paused);
  const broadcasting = storedBoolean(snapshot.is_broadcasting);
  const queueEndAt = integer(playback.queueEndAt);
  const ended = queueEndAt != null && generatedAt >= queueEndAt;
  const currentIndex = ended ? -1 : playback.currentIndex;
  const playing = broadcasting && !paused && !ended && currentIndex >= 0;
  const latestObservedAt = integer(snapshot.observed_at);
  const queueObservedAt = integer(latestQueue.observed_at);
  const freshestAt = Math.max(latestObservedAt || 0, queueObservedAt || 0) || null;
  const stale = freshestAt == null || generatedAt - freshestAt > FACTS_FRESH_MS;
  const host = {
    host_account_id: snapshot.host_account_id,
    host_handle: snapshot.host_handle,
  };
  const state = stateFromQueue(latestQueue, queue);
  const normalizedQueue = queue.map((track, index) => normalizePlaybackTrack(
    track,
    index,
    { ...playback, currentIndex },
  ));

  return {
    ok: true,
    channel_alias: 'buddies',
    generated_at: generatedAt,
    latest_observed_at: latestObservedAt,
    queue_observed_at: queueObservedAt,
    changed_at: null,
    station_id: integer(latestQueue.station_id ?? snapshot.station_id),
    is_broadcasting: broadcasting,
    host_account_id: integer(host.host_account_id),
    host_handle: text(host.host_handle),
    playing,
    stale,
    setup_required: false,
    queue_revision: queueRevision(state, hostIdentity(host)),
    queue_status: {
      is_paused: paused,
      playing,
      current_index: currentIndex,
      progress_ms: ended ? 0 : playback.progressMs,
      anchor_at: ended ? null : playback.anchorAt,
      total_items: normalizedQueue.length,
      ...(ended ? { ended: true } : {}),
      ...(queueEndAt != null ? { queue_end_at: queueEndAt } : {}),
    },
    queue: normalizedQueue,
  };
}
