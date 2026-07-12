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
  const current = await db.prepare(`SELECT p.*,r.structural_hash,r.session_id AS revision_session_id
    FROM sh_playback_current p LEFT JOIN sh_queue_revisions r ON r.id=p.revision_id
    WHERE p.channel_id=?`).bind(channelId).first();
  const queueStart = timestampMs(queue?.start_time);
  const sameRevision = current?.revision_id != null
    && current.structural_hash === structuralHash
    && Number(current.revision_session_id || 0) === Number(sessionId || 0)
    && Number(current.queue_start_time || 0) === Number(queueStart || 0);
  if (sameRevision) return { revisionId: Number(current.revision_id), created: false, current };

  const tracks = payload.tracks;
  await db.prepare(`INSERT OR IGNORE INTO sh_queue_revisions(
      session_id,channel_id,station_id,queue_id,queue_start_time,effective_at,received_at,
      structural_hash,item_count,status,source,source_priority
    ) VALUES(?,?,?,?,?,?,?,?,?,'pending','live_collector',100)`)
    .bind(
      sessionId, channelId, stationId, integer(queue?.queue_id), queueStart,
      observedAt, receivedAt, structuralHash, tracks.length,
    ).run();
  const revision = await db.prepare(`SELECT id,status FROM sh_queue_revisions
    WHERE channel_id=? AND effective_at=? AND structural_hash=?`)
    .bind(channelId, observedAt, structuralHash).first();
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
  if (delayed) return { ...previous, delayed: true };

  const revisionChanged = Number(previous?.revision_id || 0) !== Number(revisionId || 0);
  let pausedTotal = revisionChanged ? 0 : Number(previous?.paused_total_ms || 0);
  let pauseStartedAt = revisionChanged ? (paused ? observedAt : null) : integer(previous?.pause_started_at);
  const wasPaused = revisionChanged ? false : Number(previous?.is_paused || 0) === 1;

  if (!revisionChanged && !wasPaused && paused) pauseStartedAt = observedAt;
  if (!revisionChanged && wasPaused && !paused) {
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
  if (trackId == null) return biteCount;
  const latest = await db.prepare(`SELECT bite_count FROM sh_track_bite_observations
    WHERE channel_id=? AND track_id=? ORDER BY observed_at DESC,id DESC LIMIT 1`)
    .bind(channelId, trackId).first();
  if (integer(latest?.bite_count) !== biteCount) {
    await db.prepare(`INSERT OR IGNORE INTO sh_track_bite_observations(
        observed_at,channel_id,station_id,revision_id,track_id,queue_position,bite_count,source
      ) VALUES(?,?,?,?,?,?,?,'live_collector')`).bind(
      observedAt, channelId, stationId, revisionId, trackId, position, biteCount,
    ).run();
  }
  await db.prepare(`UPDATE sh_queue_revision_items SET bite_count=?
    WHERE revision_id=? AND position=?`).bind(biteCount, revisionId, position).run();
  return biteCount;
}
