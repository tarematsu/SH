import { integer } from './minute-facts-track-descriptor.js';
import { resolveSparseTracks } from './minute-sparse-track-resolution.js';

const VERSION = 1;
const KEY_PREFIX = 'minute-revision-progress/v1/';
const DEFAULT_CHUNK_TRACKS = 1;
const D1_BATCH_SIZE = 35;

function enabled(value) {
  return value === true || value === 1 || /^(1|true|yes|on)$/i.test(String(value || ''));
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = integer(value);
  if (parsed == null || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function chunkTracks(env) {
  return positiveInteger(env?.DERIVE_REVISION_CHUNK_TRACKS, DEFAULT_CHUNK_TRACKS, 20);
}

export function revisionProgressObjectKey(revisionId) {
  const id = integer(revisionId);
  if (id == null || id <= 0) throw new Error('invalid revision progress identity');
  return `${KEY_PREFIX}${id}.json`;
}

export function revisionR2ProgressEnabled(env) {
  return enabled(env?.REVISION_PROGRESS_R2_ENABLED)
    && typeof env?.PAGES_RESPONSE_R2?.get === 'function'
    && typeof env?.PAGES_RESPONSE_R2?.put === 'function';
}

function scheduledSourceTracks(tracks) {
  let playbackOffset = 0;
  let scheduleValid = true;
  return (Array.isArray(tracks) ? tracks : []).map((track, index) => {
    const duration = integer(track?.duration_ms);
    const validItem = scheduleValid && duration != null && duration > 0;
    const result = {
      position: integer(track?.position) ?? index,
      queue_track_id: integer(track?.queue_track_id),
      stationhead_track_id: integer(track?.stationhead_track_id),
      spotify_id: track?.spotify_id ?? null,
      apple_music_id: track?.apple_music_id ?? null,
      deezer_id: track?.deezer_id ?? null,
      isrc: track?.isrc ?? null,
      title: track?.title ?? null,
      artist: track?.artist ?? null,
      duration_ms: duration,
      bite_count: integer(track?.bite_count),
      playback_offset_ms: scheduleValid ? playbackOffset : null,
      schedule_valid: validItem ? 1 : 0,
    };
    if (validItem) playbackOffset += duration;
    else scheduleValid = false;
    return result;
  });
}

async function loadProgressObject(r2, revisionId) {
  const key = revisionProgressObjectKey(revisionId);
  const object = await r2.get(key);
  if (!object) return null;
  const payload = typeof object.json === 'function'
    ? await object.json()
    : JSON.parse(await object.text());
  if (Number(payload?.version) !== VERSION
      || integer(payload?.revision_id) !== integer(revisionId)
      || !Array.isArray(payload?.source_tracks)
      || !Array.isArray(payload?.items)) {
    throw new Error(`invalid revision progress object: ${key}`);
  }
  return payload;
}

async function saveProgressObject(r2, payload) {
  const key = revisionProgressObjectKey(payload.revision_id);
  await r2.put(key, JSON.stringify(payload), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  return key;
}

export async function ensureRevisionR2Progress(env, revision, sourceTracks, options = {}) {
  if (!revisionR2ProgressEnabled(env)) return { enabled: false, reason: 'disabled' };
  const revisionId = integer(revision?.revision_id);
  if (revisionId == null) return { enabled: false, reason: 'revision-missing' };
  const r2 = env.PAGES_RESPONSE_R2;
  const existing = await loadProgressObject(r2, revisionId);
  if (existing) {
    return {
      enabled: true,
      key: revisionProgressObjectKey(revisionId),
      materialized_item_count: existing.items.length,
      committed: integer(existing.committed_at) != null,
    };
  }
  const materialized = Math.max(0, integer(options.materializedItemCount) ?? 0);
  if (materialized > 0) {
    // A rollout-era partially committed revision stays on the D1 fallback path.
    return { enabled: false, reason: 'd1-progress-exists' };
  }
  const now = integer(options.now) ?? Date.now();
  const payload = {
    version: VERSION,
    revision_id: revisionId,
    source_job_id: integer(revision?.source_job_id),
    visible_item_count: Math.max(0, integer(revision?.visible_item_count) ?? 0),
    total_item_count: Math.max(0, integer(revision?.total_item_count) ?? 0),
    preferred_position: Math.max(0, integer(revision?.preferred_position) ?? 0),
    source_tracks: scheduledSourceTracks(sourceTracks),
    items: [],
    created_at: now,
    updated_at: now,
    committed_at: null,
  };
  await saveProgressObject(r2, payload);
  return {
    enabled: true,
    key: revisionProgressObjectKey(revisionId),
    materialized_item_count: 0,
    committed: false,
  };
}

function priority(position, preferred) {
  if (position === preferred) return 0;
  if (position === preferred + 1) return 1;
  if (position === preferred + 2) return 2;
  return 3;
}

function nextSourceTracks(progress, limit) {
  const materialized = new Set(progress.items.map((item) => integer(item.position)));
  return progress.source_tracks
    .filter((track) => !materialized.has(integer(track.position)))
    .sort((left, right) => (
      priority(integer(left.position), progress.preferred_position)
        - priority(integer(right.position), progress.preferred_position)
      || integer(left.position) - integer(right.position)
    ))
    .slice(0, limit);
}

function resolvedItem(track, source) {
  return {
    position: integer(track?.position),
    track_id: integer(track?.trackId),
    queue_track_id: integer(track?.queue_track_id),
    stationhead_track_id: integer(track?.stationhead_track_id),
    isrc: track?.isrc ?? null,
    spotify_id: track?.spotify_id ?? null,
    deezer_id: track?.deezer_id ?? null,
    duration_ms: integer(track?.duration_ms),
    playback_offset_ms: integer(source?.playback_offset_ms),
    schedule_valid: Number(source?.schedule_valid || 0) === 1 ? 1 : 0,
    bite_count: integer(source?.bite_count),
  };
}

function itemStatement(db, revisionId, item) {
  return db.prepare(`INSERT INTO sh_queue_revision_items(
      revision_id,position,track_id,queue_track_id,stationhead_track_id,isrc,spotify_id,
      deezer_id,duration_ms,playback_offset_ms,schedule_valid,bite_count
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(revision_id,position) DO UPDATE SET
      track_id=excluded.track_id,queue_track_id=excluded.queue_track_id,
      stationhead_track_id=excluded.stationhead_track_id,isrc=excluded.isrc,
      spotify_id=excluded.spotify_id,deezer_id=excluded.deezer_id,
      duration_ms=excluded.duration_ms,playback_offset_ms=excluded.playback_offset_ms,
      schedule_valid=excluded.schedule_valid,bite_count=excluded.bite_count
    WHERE track_id IS NOT excluded.track_id
      OR queue_track_id IS NOT excluded.queue_track_id
      OR stationhead_track_id IS NOT excluded.stationhead_track_id
      OR isrc IS NOT excluded.isrc
      OR spotify_id IS NOT excluded.spotify_id
      OR deezer_id IS NOT excluded.deezer_id
      OR duration_ms IS NOT excluded.duration_ms
      OR playback_offset_ms IS NOT excluded.playback_offset_ms
      OR schedule_valid IS NOT excluded.schedule_valid
      OR bite_count IS NOT excluded.bite_count`)
    .bind(
      revisionId,
      item.position,
      item.track_id,
      item.queue_track_id,
      item.stationhead_track_id,
      item.isrc,
      item.spotify_id,
      item.deezer_id,
      item.duration_ms,
      item.playback_offset_ms,
      item.schedule_valid,
      item.bite_count,
    );
}

async function commitProgress(db, state, progress, now) {
  const statements = progress.items
    .slice()
    .sort((left, right) => integer(left.position) - integer(right.position))
    .map((item) => itemStatement(db, state.revision_id, item));
  for (let offset = 0; offset < statements.length; offset += D1_BATCH_SIZE) {
    await db.batch(statements.slice(offset, offset + D1_BATCH_SIZE));
  }
  const materializedCount = progress.items.length;
  const coverageComplete = materializedCount >= state.total_item_count;
  await db.prepare(`UPDATE sh_queue_revisions SET
      materialized_item_count=?,coverage_complete=?,last_materialized_at=?,
      status=CASE WHEN ?>=COALESCE(source_visible_count,?) THEN 'complete' ELSE 'pending' END
    WHERE id=?`)
    .bind(
      materializedCount,
      coverageComplete ? 1 : 0,
      now,
      materializedCount,
      state.visible_item_count,
      state.revision_id,
    )
    .run();
}

function resultFromProgress(state, progress, selected, storage) {
  const materializedCount = progress.items.length;
  const complete = materializedCount >= state.visible_item_count;
  const coverageComplete = materializedCount >= state.total_item_count;
  const preferredResolved = progress.items.some(
    (item) => integer(item.position) === state.preferred_position,
  );
  const playbackTracks = complete && preferredResolved
    ? progress.source_tracks.filter(
        (track) => integer(track.position) === state.preferred_position,
      )
    : selected;
  return {
    ...state,
    complete,
    coverage_complete: coverageComplete,
    materialized_item_count: materializedCount,
    chunk_tracks: selected.length,
    preferred_resolved: complete && preferredResolved,
    source_tracks: playbackTracks,
    storage,
  };
}

export async function writeRevisionR2ProgressChunk(env, revisionState, dependencies = {}) {
  if (!revisionR2ProgressEnabled(env)) throw new Error('revision R2 progress binding is missing');
  const db = env?.MINUTE_DB;
  if (!db?.prepare) throw new Error('revision R2 progress MINUTE_DB binding is missing');
  const revisionId = integer(revisionState?.revision_id);
  if (revisionId == null) throw new Error('invalid revision R2 progress state');
  const state = {
    ...revisionState,
    revision_id: revisionId,
    visible_item_count: Math.max(0, integer(revisionState?.visible_item_count) ?? 0),
    total_item_count: Math.max(
      0,
      integer(revisionState?.total_item_count)
        ?? integer(revisionState?.visible_item_count)
        ?? 0,
    ),
    preferred_position: Math.max(0, integer(revisionState?.preferred_position) ?? 0),
  };
  const progress = await loadProgressObject(env.PAGES_RESPONSE_R2, revisionId);
  if (!progress) throw new Error(`revision progress object is missing: ${revisionId}`);
  if (integer(progress.committed_at) != null) {
    return resultFromProgress(state, progress, [], 'r2-committed');
  }

  const selected = nextSourceTracks(progress, chunkTracks(env));
  const observedAt = integer(state?.enrichment?.observed_at) ?? Date.now();
  const context = {
    channelId: integer(state?.enrichment?.channel_id),
    minuteAt: integer(state?.enrichment?.minute_at),
    queueTracks: state.visible_item_count,
    revisionId,
  };
  const resolve = dependencies.resolveTracksBulk || resolveSparseTracks;
  const resolved = selected.length
    ? await resolve(db, env?.DB, selected, observedAt, context)
    : [];
  const sources = new Map(selected.map((track) => [integer(track.position), track]));
  const items = new Map(progress.items.map((item) => [integer(item.position), item]));
  for (const track of resolved) {
    const position = integer(track?.position);
    if (position == null) continue;
    items.set(position, resolvedItem(track, sources.get(position)));
  }
  progress.items = [...items.values()].sort((left, right) => left.position - right.position);
  progress.updated_at = Date.now();
  await saveProgressObject(env.PAGES_RESPONSE_R2, progress);

  const materializedCount = progress.items.length;
  if (!selected.length && materializedCount < state.visible_item_count) {
    throw new Error(`revision ${revisionId} R2 source is incomplete: ${materializedCount}/${state.visible_item_count}`);
  }
  if (materializedCount >= state.visible_item_count) {
    await commitProgress(db, state, progress, progress.updated_at);
    progress.committed_at = progress.updated_at;
    await saveProgressObject(env.PAGES_RESPONSE_R2, progress);
    return resultFromProgress(state, progress, selected, 'd1-final');
  }
  return resultFromProgress(state, progress, selected, 'r2-progress');
}
