import {
  minuteBucket,
  queueStructuralHash,
  queueStructurePayload,
  timestampMs,
} from './minute-facts-store.js';
import { integer } from './minute-facts-track-descriptor.js';
import {
  batchRun,
  missingRevisionPositions,
  resolveTracksBulk,
  timedStage,
} from './minute-facts-track-resolution.js';

async function findReusableRevision(db, input) {
  return db.prepare(`SELECT id,status,effective_at,item_count FROM sh_queue_revisions
    WHERE channel_id=? AND structural_hash=? AND session_id IS ? AND queue_start_time IS ?
      AND status IN ('complete','pending')
    ORDER BY CASE status WHEN 'complete' THEN 0 ELSE 1 END,effective_at DESC,id DESC
    LIMIT 1`)
    .bind(input.channelId, input.structuralHash, input.sessionId, input.queueStart)
    .first();
}

async function updateRevisionCoverage(db, revisionId, materializedCount, totalCount) {
  const complete = materializedCount >= totalCount ? 1 : 0;
  try {
    await db.prepare(`UPDATE sh_queue_revisions SET
        item_count=?,total_item_count=?,coverage_complete=?,status='complete'
      WHERE id=?`)
      .bind(materializedCount, totalCount, complete, revisionId)
      .run();
  } catch (error) {
    if (!/no such column/i.test(String(error?.message || ''))) throw error;
    await db.prepare("UPDATE sh_queue_revisions SET item_count=?,status='complete' WHERE id=?")
      .bind(materializedCount, revisionId)
      .run();
  }
}

export async function createPartialRevision(db, oldDb, input) {
  const { channelId, stationId, sessionId, queue, observedAt, receivedAt } = input;
  const payload = queueStructurePayload(queue);
  const structuralHash = await queueStructuralHash(queue, payload);
  const queueStart = timestampMs(queue?.start_time);
  const visibleCount = payload.tracks.length;
  const totalCount = Math.max(
    visibleCount,
    integer(queue?.total_track_count) ?? visibleCount,
  );
  const context = {
    channelId,
    minuteAt: minuteBucket(observedAt),
    queueTracks: visibleCount,
    revisionId: null,
  };

  let revision = await timedStage('find_queue_revision', context, () => findReusableRevision(db, {
    channelId,
    sessionId,
    queueStart,
    structuralHash,
  }));
  const created = !revision;
  if (revision?.status === 'complete' && Number(revision.item_count || 0) >= visibleCount) {
    return {
      revisionId: Number(revision.id),
      created: false,
      resumed: false,
      materializedCount: Number(revision.item_count || 0),
      totalCount,
      coverageComplete: Number(revision.item_count || 0) >= totalCount,
    };
  }

  if (!revision) {
    await timedStage('insert_queue_revision', context, () => db.prepare(`INSERT OR IGNORE INTO sh_queue_revisions(
        session_id,channel_id,station_id,queue_id,queue_start_time,effective_at,received_at,
        structural_hash,item_count,status,source,source_priority
      ) VALUES(?,?,?,?,?,?,?,?,?,'pending','live_collector',100)`)
      .bind(
        sessionId,
        channelId,
        stationId,
        integer(queue?.queue_id),
        queueStart,
        observedAt,
        receivedAt,
        structuralHash,
        visibleCount,
      )
      .run());
    revision = await db.prepare(`SELECT id,status,effective_at,item_count FROM sh_queue_revisions
      WHERE channel_id=? AND effective_at=? AND structural_hash=?`)
      .bind(channelId, observedAt, structuralHash)
      .first();
  }

  const revisionId = Number(revision?.id);
  if (!Number.isFinite(revisionId)) throw new Error('failed to create or resume partial queue revision');
  context.revisionId = revisionId;

  const existingResult = await timedStage('load_revision_progress', context, () => db.prepare(
    'SELECT position FROM sh_queue_revision_items WHERE revision_id=?',
  ).bind(revisionId).all());
  const existingRows = existingResult.results || [];
  const resolved = await resolveTracksBulk(db, oldDb, payload.tracks, observedAt, context);
  let offset = 0;
  let scheduleValid = true;
  const scheduled = resolved.map((track) => {
    const duration = integer(track.duration_ms);
    const validItem = scheduleValid && duration != null && duration > 0;
    const result = {
      ...track,
      playbackOffset: scheduleValid ? offset : null,
      scheduleValid: validItem,
    };
    if (validItem) offset += duration;
    else scheduleValid = false;
    return result;
  });

  const missing = missingRevisionPositions(scheduled, existingRows);
  const byPosition = new Map((queue?.tracks || []).map((track, index) => [
    integer(track?.position) ?? index,
    track,
  ]));
  const statements = missing.map((track) => db.prepare(`INSERT INTO sh_queue_revision_items(
      revision_id,position,track_id,queue_track_id,stationhead_track_id,isrc,spotify_id,
      deezer_id,duration_ms,playback_offset_ms,schedule_valid,bite_count
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(revision_id,position) DO UPDATE SET
      track_id=excluded.track_id,queue_track_id=excluded.queue_track_id,
      stationhead_track_id=excluded.stationhead_track_id,isrc=excluded.isrc,
      spotify_id=excluded.spotify_id,deezer_id=excluded.deezer_id,
      duration_ms=excluded.duration_ms,playback_offset_ms=excluded.playback_offset_ms,
      schedule_valid=excluded.schedule_valid,bite_count=excluded.bite_count`).bind(
    revisionId,
    track.position,
    track.trackId,
    track.queue_track_id,
    track.stationhead_track_id,
    track.isrc,
    track.spotify_id,
    track.deezer_id,
    track.duration_ms,
    track.playbackOffset,
    track.scheduleValid ? 1 : 0,
    integer(byPosition.get(track.position)?.bite_count),
  ));
  if (statements.length) {
    await timedStage('write_revision_items', context, () => batchRun(db, statements));
  }

  const count = await db.prepare('SELECT COUNT(*) AS item_count FROM sh_queue_revision_items WHERE revision_id=?')
    .bind(revisionId)
    .first();
  const materializedCount = Number(count?.item_count || 0);
  if (materializedCount < visibleCount) {
    throw new Error(`partial queue revision ${revisionId} incomplete: ${materializedCount}/${visibleCount}`);
  }
  await timedStage('complete_queue_revision', context, () => updateRevisionCoverage(
    db,
    revisionId,
    materializedCount,
    totalCount,
  ));
  return {
    revisionId,
    created,
    resumed: existingRows.length > 0,
    materializedCount,
    totalCount,
    coverageComplete: materializedCount >= totalCount,
  };
}
