import {
  extractIds,
  extractQueue,
  normalizeSnapshot,
  validateChannelPayload,
} from './collector-payload.js';
import {
  attachCollectedTrackMetadata,
  compactCollectedQueue,
  metadataForCollectedQueue,
  persistCollectedTrackMetadata,
} from './collected-track-metadata.js';
import {
  prepareQueueLikesAnalysis,
  prepareQueueStructuralAnalysis,
  serializedQueueAnalysis,
} from './queue-analysis-transfer.js';
import { prepareMaterializedQueue } from './queue-materialization.js';
import { prepareSnapshotAnalysis } from './snapshot-analysis-transfer.js';

export const RAW_ANALYSIS_MESSAGE = 'stationhead-raw-analysis';
export const RAW_STRUCTURAL_MESSAGE = 'stationhead-raw-structural-analysis';
export const RAW_LIKES_MESSAGE = 'stationhead-raw-likes-analysis';
export const RAW_MATERIALIZE_MESSAGE = 'stationhead-raw-materialize';

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function commonTask(body) {
  return {
    observed_at: integer(body?.observed_at) ?? Date.now(),
    channel_alias: String(body?.channel_alias || '').trim() || 'buddies',
    persist_credentials: body?.persist_credentials !== false,
    auth: objectValue(body?.auth) || {},
  };
}

async function sendNext(env, body, dependencies = {}) {
  const send = dependencies.send
    || ((message) => env?.INGEST_FINALIZE_QUEUE?.send(message, { contentType: 'json' }));
  if (!dependencies.send && !env?.INGEST_FINALIZE_QUEUE?.send) {
    throw new Error('INGEST_FINALIZE_QUEUE binding is missing');
  }
  await send(body);
}

function channelPayload(body) {
  if (body?.message_type !== 'stationhead-raw-channel') {
    throw new Error('unsupported raw collection message');
  }
  const version = integer(body?.message_version);
  if (version === 2) {
    const channel = objectValue(body.channel);
    if (!channel) throw new Error('invalid structured raw channel payload');
    return channel;
  }
  if (version !== 1) throw new Error('unsupported raw collection message');
  try {
    return JSON.parse(String(body.body || ''));
  } catch (error) {
    throw new Error(`invalid raw channel JSON: ${error?.message || error}`);
  }
}

function validatePreparedStage(body, expectedType) {
  if (body?.message_type !== expectedType || integer(body?.message_version) !== 1) {
    throw new Error(`unsupported ${expectedType} task`);
  }
  const snapshot = objectValue(body.snapshot);
  const queue = body.queue == null ? null : objectValue(body.queue);
  const trackMetadata = Array.isArray(body.track_metadata) ? body.track_metadata : [];
  if (!snapshot || integer(snapshot.channel_id) == null || integer(snapshot.station_id) == null) {
    throw new Error('prepared raw collection snapshot is missing');
  }
  if (body.queue != null && !queue) throw new Error('prepared raw collection queue is invalid');
  if (queue && !Array.isArray(queue.tracks)) {
    throw new Error('prepared raw collection queue tracks are invalid');
  }
  return {
    snapshot,
    queue,
    trackMetadata,
    common: commonTask(body),
  };
}

function preparedMessage(type, common, snapshot, queue, details = null) {
  return {
    message_type: type,
    message_version: 1,
    ...common,
    snapshot,
    queue,
    ...(details || {}),
  };
}

export async function processRawNormalizeStage(env, body, dependencies = {}) {
  const channel = channelPayload(body);
  const common = commonTask(body);
  const config = {
    channelAlias: String(env?.CHANNEL_ALIAS || common.channel_alias || 'buddies').trim().toLowerCase(),
    collectorId: String(env?.COLLECTOR_ID || 'cloudflare-worker').trim(),
  };
  const state = {
    channelId: integer(common.auth.collectorChannelId),
    stationId: integer(common.auth.collectorStationId),
  };
  validateChannelPayload(channel, config.channelAlias);
  extractIds(channel, state);
  const snapshot = normalizeSnapshot(channel, state, config);
  if (integer(snapshot.channel_id) == null || integer(snapshot.station_id) == null) {
    throw new Error('normalized raw collection identity is missing');
  }
  const extractedQueue = extractQueue(channel, state.stationId);
  const compacted = compactCollectedQueue(extractedQueue);
  // The structural and like seed is serialized after compaction. Provider IDs,
  // preview URLs and repeated presentation fields therefore never cross the
  // raw-analysis Queue boundary unless they are required as a fallback.
  const queueAnalysisSeed = serializedQueueAnalysis(compacted.queue);
  await sendNext(env, preparedMessage(
    RAW_ANALYSIS_MESSAGE,
    common,
    snapshot,
    compacted.queue,
    {
      queue_analysis_seed: queueAnalysisSeed,
      track_metadata: compacted.metadata,
    },
  ), dependencies);
  const result = {
    event: 'raw_collection_normalized',
    observed_at: common.observed_at,
    channel_id: integer(snapshot.channel_id),
    station_id: integer(snapshot.station_id),
    queue_tracks: Array.isArray(compacted.queue?.tracks) ? compacted.queue.tracks.length : 0,
    track_metadata_rows: compacted.metadata.length,
  };
  console.log(JSON.stringify(result));
  return result;
}

export async function processRawAnalysisStage(env, body, dependencies = {}) {
  const {
    snapshot,
    queue,
    trackMetadata,
    common,
  } = validatePreparedStage(body, RAW_ANALYSIS_MESSAGE);
  const prepareSnapshot = dependencies.prepareSnapshot || prepareSnapshotAnalysis;
  const snapshotAnalysis = await prepareSnapshot(snapshot);
  await sendNext(env, preparedMessage(
    RAW_STRUCTURAL_MESSAGE,
    common,
    snapshot,
    queue,
    {
      snapshot_analysis: snapshotAnalysis,
      queue_analysis_seed: body.queue_analysis_seed || null,
      track_metadata: trackMetadata,
    },
  ), dependencies);
  const result = {
    event: 'raw_collection_snapshot_analyzed',
    observed_at: common.observed_at,
    channel_id: integer(snapshot.channel_id),
    queue_tracks: Array.isArray(queue?.tracks) ? queue.tracks.length : 0,
  };
  console.log(JSON.stringify(result));
  return result;
}

export async function processRawStructuralStage(env, body, dependencies = {}) {
  const {
    snapshot,
    queue,
    trackMetadata,
    common,
  } = validatePreparedStage(body, RAW_STRUCTURAL_MESSAGE);
  const prepareStructural = dependencies.prepareStructural || prepareQueueStructuralAnalysis;
  const queueAnalysis = await prepareStructural(queue, body.queue_analysis_seed || null);
  await sendNext(env, preparedMessage(
    RAW_LIKES_MESSAGE,
    common,
    snapshot,
    queue,
    {
      snapshot_analysis: body.snapshot_analysis || null,
      queue_analysis: queueAnalysis,
      track_metadata: trackMetadata,
    },
  ), dependencies);
  const result = {
    event: 'raw_collection_structural_analyzed',
    observed_at: common.observed_at,
    channel_id: integer(snapshot.channel_id),
    queue_tracks: Array.isArray(queue?.tracks) ? queue.tracks.length : 0,
  };
  console.log(JSON.stringify(result));
  return result;
}

export async function processRawLikesStage(env, body, dependencies = {}) {
  const {
    snapshot,
    queue,
    trackMetadata,
    common,
  } = validatePreparedStage(body, RAW_LIKES_MESSAGE);
  const prepareLikes = dependencies.prepareLikes || prepareQueueLikesAnalysis;
  const queueAnalysis = await prepareLikes(queue, body.queue_analysis || null);
  await sendNext(env, preparedMessage(
    RAW_MATERIALIZE_MESSAGE,
    common,
    snapshot,
    queue,
    {
      snapshot_analysis: body.snapshot_analysis || null,
      queue_analysis: queueAnalysis,
      track_metadata: trackMetadata,
    },
  ), dependencies);
  const result = {
    event: 'raw_collection_likes_analyzed',
    observed_at: common.observed_at,
    channel_id: integer(snapshot.channel_id),
    queue_tracks: Array.isArray(queue?.tracks) ? queue.tracks.length : 0,
  };
  console.log(JSON.stringify(result));
  return result;
}

export async function processRawMaterializeStage(env, body, dependencies = {}) {
  const {
    snapshot,
    queue,
    trackMetadata,
    common,
  } = validatePreparedStage(body, RAW_MATERIALIZE_MESSAGE);
  const materialize = dependencies.materialize || prepareMaterializedQueue;
  const materialized = await materialize(env?.DB, queue, body.queue_analysis || null, env);
  const visibleMetadata = metadataForCollectedQueue(trackMetadata, materialized.queue);
  const persistMetadata = dependencies.persistTrackMetadata || persistCollectedTrackMetadata;
  const metadataResult = await persistMetadata(env?.MINUTE_DB, visibleMetadata, common.observed_at);
  const hydratedQueue = attachCollectedTrackMetadata(materialized.queue, visibleMetadata);
  const next = {
    message_type: 'stationhead-raw-channel',
    message_version: 3,
    ...common,
    snapshot,
    queue: hydratedQueue,
    ...(body.snapshot_analysis ? { snapshot_analysis: body.snapshot_analysis } : {}),
    ...(materialized.analysis ? { queue_analysis: materialized.analysis } : {}),
  };
  await sendNext(env, next, dependencies);
  const result = {
    event: 'raw_collection_materialized',
    observed_at: common.observed_at,
    channel_id: integer(snapshot.channel_id),
    queue_total_tracks: Number(next.queue?.total_track_count || next.queue?.tracks?.length || 0),
    queue_materialized_tracks: Number(next.queue?.materialized_track_count || next.queue?.tracks?.length || 0),
    track_metadata_rows: visibleMetadata.length,
    track_dictionary_changed: Number(metadataResult?.changed || 0),
    track_dictionary_skipped: metadataResult?.skipped || null,
  };
  console.log(JSON.stringify(result));
  return result;
}
