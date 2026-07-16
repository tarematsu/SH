import {
  batchRun,
  bool,
  findScheduledPosition,
  integer,
  queueRevisionItemStatement,
  queueStructuralHash,
  queueStructurePayload,
  scheduleQueueTracks,
  text,
  timestampMs,
} from './minute-facts-normalize.js';
import { resolveTrack } from './minute-facts-legacy-resolve.js';

async function loadTrackMetadata(oldDb, tracks) {
  if (!oldDb) return new Map();
  const ids = [...new Set((tracks || []).map((track) => text(track?.spotify_id)).filter(Boolean))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  try {
    const result = await oldDb.prepare(`SELECT spotify_id,title,artist FROM sh_track_metadata
      WHERE spotify_id IN (${placeholders})`).bind(...ids).all();
    return new Map((result.results || []).map((row) => [String(row.spotify_id), row]));
  } catch {
    return new Map();
  }
}

export async function createRevision(db, oldDb, input) {
  const { channelId, stationId, sessionId, queue, observedAt, receivedAt } = input;
  const payload = queueStructurePayload(queue);
  const structuralHash = await queueStructuralHash(queue);
  const revisionKey = [
    channelId, sessionId || 0, integer(queue?.queue_id) || 0,
    timestampMs(queue?.start_time) || 0, structuralHash,
  ].join(':');
  const current = await db.prepare(`SELECT p.*,r.structural_hash,r.session_id AS revision_session_id
    FROM sh_playback_current p LEFT JOIN sh_queue_revisions r ON r.id=p.revision_id
    WHERE p.channel_id=?`).bind(channelId).first();
  const queueStart = timestampMs(queue?.start_time);
  const sameRevision = current?.revision_id != null
    && current.structural_hash === structuralHash
    && Number(current.revision_session_id || 0) === Number(sessionId || 0)
    && Number(current.queue_start_time || 0) === Number(queueStart || 0);
  if (sameRevision) return { revisionId: Number(current.revision_id), created: false, current };

  const existing = await db.prepare(`SELECT id,status FROM sh_queue_revisions
    WHERE revision_key=? LIMIT 1`).bind(revisionKey).first();
  if (existing?.id != null && existing.status === 'complete') {
    return { revisionId: Number(existing.id), created: false, current: null };
  }

  const tracks = payload.tracks;
  if (existing?.id == null) await db.prepare(`INSERT OR IGNORE INTO sh_queue_revisions(
      session_id,channel_id,station_id,queue_id,queue_start_time,effective_at,received_at,
      structural_hash,revision_key,item_count,status,source,source_priority
    ) VALUES(?,?,?,?,?,?,?,?,? ,?,'pending','live_collector',100)`)
    .bind(
      sessionId, channelId, stationId, integer(queue?.queue_id), queueStart,
      observedAt, receivedAt, structuralHash, revisionKey, tracks.length,
    ).run();
  const revision = existing || await db.prepare(`SELECT id,status FROM sh_queue_revisions
    WHERE revision_key=? LIMIT 1`).bind(revisionKey).first();
  const revisionId = Number(revision?.id);
  if (!Number.isFinite(revisionId)) throw new Error('failed to create queue revision');

  const metadata = await loadTrackMetadata(oldDb, tracks);
  const withTrackIds = [];
  for (const track of tracks) {
    const details = metadata.get(String(track.spotify_id || '')) || {};
    const trackId = await resolveTrack(db, { ...track, title: details.title, artist: details.artist }, observedAt);
    withTrackIds.push({ ...track, trackId });
  }
  const resolved = scheduleQueueTracks(withTrackIds);

  const byPosition = new Map((queue?.tracks || []).map((track, index) => [integer(track?.position) ?? index, track]));
  const statements = resolved.map((track) => queueRevisionItemStatement(
    db, revisionId, track, integer(byPosition.get(track.position)?.bite_count),
  ));
  await batchRun(db, statements);
  const count = await db.prepare('SELECT COUNT(*) AS item_count FROM sh_queue_revision_items WHERE revision_id=?')
    .bind(revisionId).first();
  if (Number(count?.item_count || 0) !== tracks.length) {
    await db.prepare("UPDATE sh_queue_revisions SET status='invalid' WHERE id=?")
      .bind(revisionId).run();
    throw new Error(`queue revision ${revisionId} item count mismatch`);
  }
  await db.prepare("UPDATE sh_queue_revisions SET status='complete' WHERE id=?").bind(revisionId).run();
  return { revisionId, created: revision?.status !== 'complete', current: null };
}

export async function updatePlaybackState(db, input) {
  const { channelId, sessionId, revisionId, queueStartTime, observedAt, isPaused } = input;
  const previous = await db.prepare('SELECT * FROM sh_playback_current WHERE channel_id=?')
    .bind(channelId).first();
  const paused = bool(isPaused) === 1;
  const delayed = previous && observedAt < Number(previous.last_observed_at || 0);
  // A delayed payload cannot safely reuse a position calculated for a later
  // observation. The caller may also be resolving a different revision, which
  // would turn that stale position into a confidently wrong track.
  if (delayed) return { ...previous, current_position: null, delayed: true };

  const revisionChanged = Number(previous?.revision_id || 0) !== Number(revisionId || 0);
  const sameQueueInstance = Boolean(previous)
    && Number(previous.session_id || 0) === Number(sessionId || 0)
    && Number(previous.queue_start_time || 0) === Number(queueStartTime || 0);
  const resetPauseState = revisionChanged && !sameQueueInstance;
  let pausedTotal = resetPauseState ? 0 : Number(previous?.paused_total_ms || 0);
  let pauseStartedAt = resetPauseState ? (paused ? observedAt : null) : integer(previous?.pause_started_at);
  const wasPaused = resetPauseState ? false : Number(previous?.is_paused || 0) === 1;

  if (!resetPauseState && !wasPaused && paused) pauseStartedAt = observedAt;
  if (!resetPauseState && wasPaused && !paused) {
    if (pauseStartedAt != null) pausedTotal += Math.max(0, observedAt - pauseStartedAt);
    pauseStartedAt = null;
  }
  if (revisionChanged || wasPaused !== paused) {
    await db.prepare(`INSERT OR IGNORE INTO sh_queue_state_events(
      revision_id,observed_at,is_paused,source
    ) VALUES(?,?,?,'live_collector')`).bind(revisionId, observedAt, paused ? 1 : 0).run();
  }

  const activePause = paused && pauseStartedAt != null ? Math.max(0, observedAt - pauseStartedAt) : 0;
  const elapsed = queueStartTime == null
    ? null
    : Math.max(0, observedAt - queueStartTime - pausedTotal - activePause);
  let currentPosition = null;
  if (elapsed != null) {
    const items = await db.prepare(`SELECT position,duration_ms,playback_offset_ms,schedule_valid
      FROM sh_queue_revision_items WHERE revision_id=? ORDER BY position ASC`).bind(revisionId).all();
    currentPosition = findScheduledPosition(items.results || [], elapsed);
  }

  await db.prepare(`INSERT INTO sh_playback_current(
      channel_id,session_id,revision_id,queue_start_time,is_paused,paused_total_ms,
      pause_started_at,last_observed_at,current_position
    ) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET
      session_id=excluded.session_id,revision_id=excluded.revision_id,
      queue_start_time=excluded.queue_start_time,is_paused=excluded.is_paused,
      paused_total_ms=excluded.paused_total_ms,pause_started_at=excluded.pause_started_at,
      last_observed_at=excluded.last_observed_at,current_position=excluded.current_position
    WHERE excluded.last_observed_at>=sh_playback_current.last_observed_at`).bind(
      channelId, sessionId, revisionId, queueStartTime, paused ? 1 : 0, pausedTotal,
      pauseStartedAt, observedAt, currentPosition,
    ).run();
  return {
    revision_id: revisionId,
    is_paused: paused ? 1 : 0,
    current_position: currentPosition,
    delayed: false,
  };
}

export async function writeCurrentBite(db, input) {
  const { channelId, stationId, revisionId, position, observedAt, queue } = input;
  if (position == null) return null;
  const sourceTrack = (queue?.tracks || []).find((track, index) => (integer(track?.position) ?? index) === position);
  const biteCount = integer(sourceTrack?.bite_count);
  if (biteCount == null) return null;
  const item = await db.prepare(`SELECT track_id FROM sh_queue_revision_items
    WHERE revision_id=? AND position=?`).bind(revisionId, position).first();
  const trackId = integer(item?.track_id);
  const occurrenceKey = `revision:${revisionId}:${position}`;
  const trackKey = String(
    sourceTrack?.queue_track_id
      ?? sourceTrack?.stationhead_track_id
      ?? sourceTrack?.spotify_id
      ?? sourceTrack?.isrc
      ?? `track:${revisionId}:${position}`,
  );
  const latest = await db.prepare(`SELECT count_value FROM sh_track_counter_changes
    WHERE occurrence_key=? ORDER BY observed_at DESC,id DESC LIMIT 1`)
    .bind(occurrenceKey).first();
  if (integer(latest?.count_value) !== biteCount) {
    await db.prepare(`INSERT OR IGNORE INTO sh_track_counter_changes(
      observed_at,occurrence_key,channel_id,station_id,queue_id,queue_start_time,
        queue_position,queue_track_id,stationhead_track_id,spotify_id,apple_music_id,isrc,
        queue_revision_id,track_id,track_key,count_value,source,source_record_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      integer(observedAt), occurrenceKey, integer(channelId), integer(stationId), integer(queue?.queue_id),
      timestampMs(queue?.start_time), integer(position), integer(sourceTrack?.queue_track_id),
      integer(sourceTrack?.stationhead_track_id), text(sourceTrack?.spotify_id), text(sourceTrack?.apple_music_id),
      text(sourceTrack?.isrc), integer(revisionId), trackId, trackKey,
      biteCount, 'live_collector', `live:${channelId}:${revisionId}:${position}:${observedAt}:${biteCount}`,
    ).run();
  }
  return biteCount;
}