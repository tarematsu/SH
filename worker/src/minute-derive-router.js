import {
  processMinuteDeriveMessage as processLegacyMinuteDeriveMessage,
  processMinuteDeriveWriteStage,
} from './minute-derive-queue.js';
import {
  prepareSparseLiveRevision,
  shouldMaterializeLiveRevision,
  writeSparseLiveRevisionChunk,
} from './minute-revision-materializer.js';
import { integer } from './minute-facts-track-descriptor.js';

const SPARSE_STAGE = 'revision-materialize';

async function defaultWrite(env, payload) {
  if (payload?.rebuild) {
    const { saveReconstructedMinuteFactWithinBudget } = await import('./minute-facts-rebuild-store.js');
    return saveReconstructedMinuteFactWithinBudget(env, payload);
  }
  const { saveOptimizedMinuteFactWithinBudget } = await import('./minute-facts-fast-store.js');
  return saveOptimizedMinuteFactWithinBudget(env, payload);
}

function compactJob(job) {
  return {
    id: integer(job?.id),
    channel_id: integer(job?.channel_id),
    minute_at: integer(job?.minute_at),
    payload_version: integer(job?.payload_version) ?? 1,
    job_kind: String(job?.job_kind || 'live'),
    attempts: Math.max(1, integer(job?.attempts) ?? 1),
  };
}

async function sendStage(env, body, dependencies = {}, options = {}) {
  if (dependencies.sendStage) return dependencies.sendStage({
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    ...body,
  }, options);
  if (!env?.MINUTE_DERIVE_QUEUE?.send) throw new Error('MINUTE_DERIVE_QUEUE binding is missing');
  return env.MINUTE_DERIVE_QUEUE.send({
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    ...body,
  }, {
    contentType: 'json',
    ...options,
  });
}

function isSparseWrite(env, body) {
  return body?.message_type === 'minute-fact-derive-stage'
    && Number(body?.message_version) === 1
    && body?.stage === 'write'
    && shouldMaterializeLiveRevision(env, body?.payload);
}

function isSparseChunk(body) {
  return body?.message_type === 'minute-fact-derive-stage'
    && Number(body?.message_version) === 1
    && body?.stage === SPARSE_STAGE
    && body?.revision?.sparse === true;
}

async function processSparseWrite(env, body, dependencies = {}) {
  let preparedRevision = null;
  const write = dependencies.write || defaultWrite;
  const result = await processMinuteDeriveWriteStage(env, body, {
    ...dependencies,
    stageRevision: false,
    write: async (activeEnv, payload) => {
      preparedRevision = await prepareSparseLiveRevision(activeEnv, payload, {
        sourceJobId: body?.job?.id,
      }, dependencies.materializer || {});
      return write(activeEnv, preparedRevision?.revision_id == null
        ? payload
        : { ...payload, prepared_revision: preparedRevision });
    },
  });
  if (result?.failed || !preparedRevision?.staged) {
    return preparedRevision?.revision_id == null
      ? result
      : {
          ...result,
          revision_id: preparedRevision.revision_id,
          revision_pending: false,
          revision_complete: true,
        };
  }
  await sendStage(env, {
    stage: SPARSE_STAGE,
    job: compactJob(body.job),
    revision: preparedRevision,
    started_at: integer(body.started_at) ?? Date.now(),
  }, dependencies);
  return {
    ...result,
    revision_id: preparedRevision.revision_id,
    revision_pending: true,
    revision_complete: false,
  };
}

function compactPlaybackQueue(revision, result) {
  return {
    ...revision.queue_identity,
    materialized_track_count: result.materialized_item_count,
    tracks: (result.source_tracks || []).map((track) => ({
      position: integer(track?.position),
      queue_track_id: integer(track?.queue_track_id),
      stationhead_track_id: integer(track?.stationhead_track_id),
      spotify_id: track?.spotify_id ?? null,
      apple_music_id: track?.apple_music_id ?? null,
      deezer_id: track?.deezer_id ?? null,
      isrc: track?.isrc ?? null,
      duration_ms: integer(track?.duration_ms),
      bite_count: integer(track?.bite_count),
    })),
  };
}

async function refreshPreferredPlayback(env, revision, result, dependencies = {}) {
  if (!result?.preferred_resolved) return false;
  const send = dependencies.sendEnrichment
    || ((message) => env?.MINUTE_ENRICHMENT_QUEUE?.send(message, { contentType: 'json' }));
  if (!dependencies.sendEnrichment && !env?.MINUTE_ENRICHMENT_QUEUE?.send) return false;
  await send({
    message_type: 'minute-fact-enrichment',
    message_version: 1,
    stage: 'playback',
    ...revision.enrichment,
    revision_id: revision.revision_id,
    queue: compactPlaybackQueue(revision, result),
  });
  return true;
}

async function processSparseChunk(env, body, dependencies = {}) {
  const writeChunk = dependencies.writeSparseRevisionChunk || writeSparseLiveRevisionChunk;
  const result = await writeChunk(env, body.revision, dependencies.materializer || {});
  const playbackRefreshEnqueued = await refreshPreferredPlayback(
    env,
    body.revision,
    result,
    dependencies,
  );
  if (!result.complete) {
    const delaySeconds = Math.max(
      1,
      Math.min(3600, integer(env?.DERIVE_REVISION_INTERVAL_SECONDS) ?? 60),
    );
    await sendStage(env, {
      stage: SPARSE_STAGE,
      job: compactJob(body.job),
      revision: {
        ...body.revision,
        materialized_item_count: result.materialized_item_count,
      },
      started_at: integer(body.started_at) ?? Date.now(),
    }, dependencies, { delaySeconds });
  }
  return {
    event: 'minute_fact_revision_materialized',
    processed: result.complete ? 1 : 0,
    failed: 0,
    pending: !result.complete,
    job_id: integer(body?.job?.id),
    revision_id: result.revision_id,
    chunk_tracks: result.chunk_tracks,
    materialized_item_count: result.materialized_item_count,
    visible_item_count: result.visible_item_count,
    total_item_count: result.total_item_count,
    coverage_complete: result.coverage_complete,
    playback_refresh_enqueued: playbackRefreshEnqueued,
  };
}

export function processMinuteDeriveMessage(env, body, dependencies = {}) {
  if (isSparseWrite(env, body)) return processSparseWrite(env, body, dependencies);
  if (isSparseChunk(body)) return processSparseChunk(env, body, dependencies);
  return processLegacyMinuteDeriveMessage(env, body, dependencies);
}
