import {
  extractIds,
  extractQueue,
  normalizeSnapshot,
  validateChannelPayload,
} from './collector-payload.js';
import {
  prepareQueueAnalysis,
  serializedQueueAnalysis,
} from './queue-analysis-transfer.js';
import { prepareMaterializedQueue } from './queue-materialization.js';
import { prepareSnapshotAnalysis } from './snapshot-analysis-transfer.js';

export const RAW_ANALYSIS_MESSAGE = 'stationhead-raw-analysis';
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
  if (!snapshot || integer(snapshot.channel_id) == null || integer(snapshot.station_id) == null) {
    throw new Error('prepared raw collection snapshot is missing');
  }
  if (body.queue != null && !queue) throw new Error('prepared raw collection queue is invalid');
  if (queue && !Array.isArray(queue.tracks)) {
    throw new Error('prepared raw collection queue tracks are invalid');
  }
  return { snapshot, queue, common: commonTask(body) };
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
  const queue = extractQueue(channel, state.stationId);
  // extractQueue caches structural/like payloads on non-enumerable Symbols.
  // Serialize that seed before the Queue boundary; hashes stay in the next
  // invocation, but the structural walk is not repeated and the seed is not lost.
  const queueAnalysisSeed = serializedQueueAnalysis(queue);
  const next = {
    message_type: RAW_ANALYSIS_MESSAGE,
    message_version: 1,
    ...common,
    snapshot,
    queue,
    queue_analysis_seed: queueAnalysisSeed,
  };
  await sendNext(env, next, dependencies);
  const result = {
    event: 'raw_collection_normalized',
    observed_at: common.observed_at,
    channel_id: integer(snapshot.channel_id),
    station_id: integer(snapshot.station_id),
    queue_tracks: Array.isArray(queue?.tracks) ? queue.tracks.length : 0,
  };
  console.log(JSON.stringify(result));
  return result;
}

export async function processRawAnalysisStage(env, body, dependencies = {}) {
  const { snapshot, queue, common } = validatePreparedStage(body, RAW_ANALYSIS_MESSAGE);
  const prepareSnapshot = dependencies.prepareSnapshot || prepareSnapshotAnalysis;
  const prepareQueue = dependencies.prepareQueue || prepareQueueAnalysis;
  const [snapshotAnalysis, queueAnalysis] = await Promise.all([
    prepareSnapshot(snapshot),
    prepareQueue(queue, body.queue_analysis_seed || null),
  ]);
  const next = {
    message_type: RAW_MATERIALIZE_MESSAGE,
    message_version: 1,
    ...common,
    snapshot,
    queue,
    snapshot_analysis: snapshotAnalysis,
    queue_analysis: queueAnalysis,
  };
  await sendNext(env, next, dependencies);
  const result = {
    event: 'raw_collection_analyzed',
    observed_at: common.observed_at,
    channel_id: integer(snapshot.channel_id),
    queue_tracks: Array.isArray(queue?.tracks) ? queue.tracks.length : 0,
  };
  console.log(JSON.stringify(result));
  return result;
}

export async function processRawMaterializeStage(env, body, dependencies = {}) {
  const { snapshot, queue, common } = validatePreparedStage(body, RAW_MATERIALIZE_MESSAGE);
  const materialize = dependencies.materialize || prepareMaterializedQueue;
  const materialized = await materialize(env?.DB, queue, body.queue_analysis || null, env);
  const next = {
    message_type: 'stationhead-raw-channel',
    message_version: 3,
    ...common,
    snapshot,
    queue: materialized.queue,
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
  };
  console.log(JSON.stringify(result));
  return result;
}
