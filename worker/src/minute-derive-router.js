import {
  processMinuteDeriveMessage as processLegacyMinuteDeriveMessage,
  processMinuteDeriveWriteStage,
} from './minute-derive-queue.js';
import {
  prepareSparseLiveRevision,
  shouldMaterializeLiveRevision,
  writeSparseLiveRevisionChunk,
} from './minute-revision-materializer.js';
import {
  prepareSparseRebuildRevision,
  shouldMaterializeRebuildRevision,
} from './minute-rebuild-revision.js';
import { integer } from './minute-facts-track-descriptor.js';

const SPARSE_STAGE = 'revision-materialize';
const REBUILD_PREFERRED_STAGE = 'rebuild-preferred';
const REBUILD_WRITE_STAGE = 'rebuild-write';
const EMPTY_DEPENDENCIES = Object.freeze({});
const EMPTY_OPTIONS = Object.freeze({});
const EMPTY_TRACKS = Object.freeze([]);
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });

let sparseRebuildStorePromise;
let rebuildStorePromise;
let fastStorePromise;

function loadSparseRebuildStore() {
  sparseRebuildStorePromise ||= import('./minute-facts-sparse-rebuild-store.js');
  return sparseRebuildStorePromise;
}

function loadRebuildStore() {
  rebuildStorePromise ||= import('./minute-facts-rebuild-store.js');
  return rebuildStorePromise;
}

function loadFastStore() {
  fastStorePromise ||= import('./minute-facts-fast-store.js');
  return fastStorePromise;
}

async function defaultWrite(env, payload) {
  if (payload?.rebuild && payload?.prepared_revision?.rebuild === true) {
    const module = await loadSparseRebuildStore();
    return module.saveSparseReconstructedMinuteFactWithinBudget(env, payload);
  }
  if (payload?.rebuild) {
    const module = await loadRebuildStore();
    return module.saveReconstructedMinuteFactWithinBudget(env, payload);
  }
  const module = await loadFastStore();
  return module.saveOptimizedMinuteFactWithinBudget(env, payload);
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

async function sendStage(env, body, dependencies = EMPTY_DEPENDENCIES, options = EMPTY_OPTIONS) {
  const message = {
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    ...body,
  };
  if (dependencies.sendStage) return dependencies.sendStage(message, options);
  const queue = env?.MINUTE_DERIVE_QUEUE;
  if (!queue?.send) throw new Error('MINUTE_DERIVE_QUEUE binding is missing');
  return options === EMPTY_OPTIONS
    ? queue.send(message, JSON_QUEUE_SEND_OPTIONS)
    : queue.send(message, { contentType: 'json', ...options });
}

async function loadDurablePayload(env, job, dependencies = EMPTY_DEPENDENCIES) {
  if (dependencies.loadPayload) return dependencies.loadPayload(env, job);
  if (!env?.MINUTE_DB?.prepare) throw new Error('minute derive MINUTE_DB binding is missing');
  const row = await env.MINUTE_DB.prepare(`SELECT payload_json,payload_version
    FROM sh_minute_fact_jobs WHERE id=? LIMIT 1`).bind(job.id).first();
  if (!row) throw new Error(`minute fact job ${job.id} source payload is missing`);
  let payload;
  try {
    payload = JSON.parse(row.payload_json || '');
  } catch (error) {
    throw new Error(`invalid minute fact job payload: ${error?.message || error}`);
  }
  if (Number(payload?.payload_version || row.payload_version || job.payload_version || 0) !== 1) {
    throw new Error(`unsupported minute fact payload version: ${payload?.payload_version || row.payload_version}`);
  }
  return payload;
}

async function preferredPositionExists(env, revision, dependencies = EMPTY_DEPENDENCIES) {
  if (dependencies.preferredPositionExists) {
    return dependencies.preferredPositionExists(env, revision);
  }
  const position = integer(revision?.fact_position);
  const revisionId = integer(revision?.revision_id);
  if (position == null || revisionId == null) return true;
  const row = await env?.MINUTE_DB?.prepare(`SELECT 1 AS present FROM sh_queue_revision_items
    WHERE revision_id=? AND position=? LIMIT 1`).bind(revisionId, position).first();
  return Boolean(row);
}

async function processSparseLiveWrite(env, body, dependencies = EMPTY_DEPENDENCIES) {
  let preparedRevision = null;
  const write = dependencies.write || defaultWrite;
  const writeStageDependencies = dependencies === EMPTY_DEPENDENCIES
    ? {
        stageRevision: false,
        write: async (activeEnv, payload) => {
          preparedRevision = await prepareSparseLiveRevision(activeEnv, payload, {
            sourceJobId: body?.job?.id,
          }, EMPTY_DEPENDENCIES);
          return write(activeEnv, preparedRevision?.revision_id == null
            ? payload
            : { ...payload, prepared_revision: preparedRevision });
        },
      }
    : {
        ...dependencies,
        stageRevision: false,
        write: async (activeEnv, payload) => {
          preparedRevision = await prepareSparseLiveRevision(activeEnv, payload, {
            sourceJobId: body?.job?.id,
          }, dependencies.materializer || EMPTY_DEPENDENCIES);
          return write(activeEnv, preparedRevision?.revision_id == null
            ? payload
            : { ...payload, prepared_revision: preparedRevision });
        },
      };
  const result = await processMinuteDeriveWriteStage(env, body, writeStageDependencies);
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

async function processSparseRebuildStart(env, body, dependencies = EMPTY_DEPENDENCIES) {
  const prepare = dependencies.prepareSparseRebuildRevision || prepareSparseRebuildRevision;
  const revision = await prepare(env, body.payload, {
    sourceJobId: body?.job?.id,
  }, dependencies.materializer || EMPTY_DEPENDENCIES);
  if (integer(revision?.revision_id) == null) {
    throw new Error('sparse rebuild revision preparation failed');
  }
  const needsPreferred = integer(revision.fact_position) != null
    && revision.preferred_materialized !== true;
  await sendStage(env, {
    stage: needsPreferred ? REBUILD_PREFERRED_STAGE : REBUILD_WRITE_STAGE,
    job: compactJob(body.job),
    revision,
    started_at: integer(body.started_at) ?? Date.now(),
  }, dependencies);
  return {
    event: 'minute_fact_rebuild_revision_prepared',
    processed: 0,
    failed: 0,
    pending: true,
    job_id: integer(body?.job?.id),
    revision_id: revision.revision_id,
    preferred_pending: needsPreferred,
    materialized_item_count: revision.materialized_item_count,
    visible_item_count: revision.visible_item_count,
  };
}

async function processSparseRebuildPreferred(env, body, dependencies = EMPTY_DEPENDENCIES) {
  const writeChunk = dependencies.writeSparseRevisionChunk || writeSparseLiveRevisionChunk;
  const result = await writeChunk(env, body.revision, dependencies.materializer || EMPTY_DEPENDENCIES);
  if (integer(body.revision.fact_position) != null && !result.preferred_resolved) {
    if (!await preferredPositionExists(env, body.revision, dependencies)) {
      throw new Error(`rebuild revision ${body.revision.revision_id} preferred position is unavailable`);
    }
  }
  const revision = {
    ...body.revision,
    materialized_item_count: result.materialized_item_count,
    preferred_materialized: true,
  };
  await sendStage(env, {
    stage: REBUILD_WRITE_STAGE,
    job: compactJob(body.job),
    revision,
    started_at: integer(body.started_at) ?? Date.now(),
  }, dependencies);
  return {
    event: 'minute_fact_rebuild_preferred_materialized',
    processed: 0,
    failed: 0,
    pending: true,
    job_id: integer(body?.job?.id),
    revision_id: result.revision_id,
    chunk_tracks: result.chunk_tracks,
    materialized_item_count: result.materialized_item_count,
  };
}

async function processSparseRebuildWrite(env, body, dependencies = EMPTY_DEPENDENCIES) {
  const job = compactJob(body.job);
  const payload = await loadDurablePayload(env, job, dependencies);
  const write = dependencies.write || defaultWrite;
  const writeStageDependencies = dependencies === EMPTY_DEPENDENCIES
    ? {
        stageRevision: false,
        write: (activeEnv, value) => write(activeEnv, {
          ...value,
          prepared_revision: body.revision,
        }),
      }
    : {
        ...dependencies,
        stageRevision: false,
        write: (activeEnv, value) => write(activeEnv, {
          ...value,
          prepared_revision: body.revision,
        }),
      };
  const result = await processMinuteDeriveWriteStage(env, {
    ...body,
    stage: 'write',
    job,
    payload,
  }, writeStageDependencies);
  if (result?.failed) return result;

  const materialized = Math.max(0, integer(body.revision.materialized_item_count) ?? 0);
  const visible = Math.max(0, integer(body.revision.visible_item_count) ?? 0);
  const revisionPending = materialized < visible;
  if (revisionPending) {
    await sendStage(env, {
      stage: SPARSE_STAGE,
      job,
      revision: body.revision,
      started_at: integer(body.started_at) ?? Date.now(),
    }, dependencies);
  }
  return {
    ...result,
    revision_id: body.revision.revision_id,
    revision_pending: revisionPending,
    revision_complete: !revisionPending,
  };
}

function compactPlaybackQueue(revision, result) {
  const sourceTracks = result.source_tracks || EMPTY_TRACKS;
  const trackCount = sourceTracks.length;
  const tracks = new Array(trackCount);
  for (let index = 0; index < trackCount; index += 1) {
    const track = sourceTracks[index];
    tracks[index] = {
      position: integer(track?.position),
      queue_track_id: integer(track?.queue_track_id),
      stationhead_track_id: integer(track?.stationhead_track_id),
      spotify_id: track?.spotify_id ?? null,
      apple_music_id: track?.apple_music_id ?? null,
      deezer_id: track?.deezer_id ?? null,
      isrc: track?.isrc ?? null,
      duration_ms: integer(track?.duration_ms),
      bite_count: integer(track?.bite_count),
    };
  }
  return {
    ...revision.queue_identity,
    materialized_track_count: result.materialized_item_count,
    tracks,
  };
}

async function refreshPreferredPlayback(env, revision, result, dependencies = EMPTY_DEPENDENCIES) {
  if (!result?.preferred_resolved || revision?.rebuild === true) return false;
  const message = {
    message_type: 'minute-fact-enrichment',
    message_version: 1,
    stage: 'playback',
    ...revision.enrichment,
    revision_id: revision.revision_id,
    queue: compactPlaybackQueue(revision, result),
  };
  if (dependencies.sendEnrichment) {
    await dependencies.sendEnrichment(message);
    return true;
  }
  const queue = env?.MINUTE_ENRICHMENT_QUEUE;
  if (!queue?.send) return false;
  await queue.send(message, JSON_QUEUE_SEND_OPTIONS);
  return true;
}

async function processSparseChunk(env, body, dependencies = EMPTY_DEPENDENCIES) {
  const writeChunk = dependencies.writeSparseRevisionChunk || writeSparseLiveRevisionChunk;
  const result = await writeChunk(env, body.revision, dependencies.materializer || EMPTY_DEPENDENCIES);
  const playbackRefreshEnqueued = await refreshPreferredPlayback(
    env,
    body.revision,
    result,
    dependencies,
  );
  if (!result.complete) {
    const configured = body.revision?.rebuild === true
      ? integer(env?.DERIVE_REBUILD_REVISION_INTERVAL_SECONDS) ?? 1
      : integer(env?.DERIVE_REVISION_INTERVAL_SECONDS) ?? 60;
    const delaySeconds = Math.max(1, Math.min(3600, configured));
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

export function processMinuteDeriveMessage(env, body, dependencies = EMPTY_DEPENDENCIES) {
  if (body?.message_type !== 'minute-fact-derive-stage') {
    return processLegacyMinuteDeriveMessage(env, body, dependencies);
  }
  const version = body.message_version;
  if (version !== 1 && Number(version) !== 1) {
    return processLegacyMinuteDeriveMessage(env, body, dependencies);
  }
  const stage = body.stage;
  if (stage === 'write') {
    if (shouldMaterializeRebuildRevision(env, body.payload)) {
      return processSparseRebuildStart(env, body, dependencies);
    }
    if (shouldMaterializeLiveRevision(env, body.payload)) {
      return processSparseLiveWrite(env, body, dependencies);
    }
    return processLegacyMinuteDeriveMessage(env, body, dependencies);
  }
  const revision = body.revision;
  if (revision?.sparse !== true) return processLegacyMinuteDeriveMessage(env, body, dependencies);
  if (stage === REBUILD_PREFERRED_STAGE && revision.rebuild === true) {
    return processSparseRebuildPreferred(env, body, dependencies);
  }
  if (stage === REBUILD_WRITE_STAGE && revision.rebuild === true) {
    return processSparseRebuildWrite(env, body, dependencies);
  }
  if (stage === SPARSE_STAGE) return processSparseChunk(env, body, dependencies);
  return processLegacyMinuteDeriveMessage(env, body, dependencies);
}
