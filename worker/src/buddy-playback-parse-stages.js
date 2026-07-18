import { normalizeBuddyQueuePayload } from './buddy-fetch-guard.js';
import { buddyPlaybackConfig } from './buddy-playback.js';
import {
  extractBuddyPlayback,
  validateBuddyChannelPayload,
} from './buddy-playback-queue.js';

export const BUDDY_PARSE_COMPUTE_STAGE = 'parse-compute';
export const BUDDY_PARSE_STORE_STAGE = 'parse-store';

const PIPELINE_ROW_SQL = `SELECT channel_alias,cycle_at,observed_at,stage,raw_json
  FROM sh_buddy_playback_pipeline WHERE channel_alias=? LIMIT 1`;
const PIPELINE_PARSED_DIRECT_SQL = `UPDATE sh_buddy_playback_pipeline SET
  stage='metadata',raw_json=NULL,parsed_queue_json=?,state_json=?,final_queue_json=NULL,
  station_id=?,queue_id=?,start_time=?,is_paused=?,is_broadcasting=?,
  host_account_id=?,host_handle=?,track_count=?,metadata_attempts=0,
  next_attempt_at=0,lease_until=0,last_error=NULL,updated_at=?
  WHERE channel_alias=? AND cycle_at=? AND stage IN ('parse','parse-store')`;

function finiteNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function changedRows(result) {
  return Number(result?.meta?.changes || 0);
}

function rowMatchesTask(row, task) {
  return row
    && String(row.channel_alias || '') === String(task.channelAlias || '')
    && finiteNumber(row.cycle_at) === task.cycleAt;
}

function preparedParsePayload(row, queue) {
  return {
    channel_alias: row.channel_alias,
    cycle_at: finiteNumber(row.cycle_at),
    observed_at: finiteNumber(row.observed_at),
    queue,
  };
}

function validPreparedParse(value, task) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && String(value.channel_alias || '') === String(task.channelAlias || '')
    && finiteNumber(value.cycle_at) === task.cycleAt
    && value.queue
    && typeof value.queue === 'object'
    && !Array.isArray(value.queue)
    && Array.isArray(value.queue.tracks);
}

function parseQueue(rawJson, config) {
  const normalized = normalizeBuddyQueuePayload(JSON.parse(rawJson), config.alias);
  validateBuddyChannelPayload(normalized, config.alias);
  return extractBuddyPlayback(normalized, config.alias, config.maxTracks);
}

function serializedQueue(queue) {
  return {
    parsedQueueJson: JSON.stringify(queue),
    stateJson: JSON.stringify({
      station_id: queue.station_id,
      queue_id: queue.queue_id,
      start_time: queue.start_time,
      is_paused: queue.is_paused,
      tracks: queue.tracks,
    }),
  };
}

async function loadPipelineRow(env, channelAlias) {
  return env.OTHER_DB.prepare(PIPELINE_ROW_SQL).bind(channelAlias).first();
}

export async function processBuddyParseCompute(env, task) {
  if (!env?.OTHER_DB?.prepare) throw new Error('OTHER_DB binding is missing');
  const config = buddyPlaybackConfig(env);
  const channelAlias = task.channelAlias || config.alias;
  const row = await loadPipelineRow(env, channelAlias);
  if (!rowMatchesTask(row, { ...task, channelAlias })) {
    return { skipped: true, reason: 'stale-cycle', pending: false, cycle_at: task.cycleAt };
  }
  if (row.stage !== 'parse') {
    return { skipped: true, reason: 'stage-advanced', pending: false, stage: row.stage, cycle_at: task.cycleAt };
  }
  if (typeof row.raw_json !== 'string' || !row.raw_json) {
    throw new Error('buddy playback parse stage is missing raw JSON');
  }
  const queue = parseQueue(row.raw_json, config);
  return {
    skipped: false,
    pending: true,
    stage: BUDDY_PARSE_STORE_STAGE,
    direct_stage: BUDDY_PARSE_STORE_STAGE,
    cycle_at: task.cycleAt,
    tracks: queue.tracks.length,
    checked_at: finiteNumber(row.observed_at),
    prepared_parse: preparedParsePayload(row, queue),
  };
}

export async function processBuddyParseStore(env, task) {
  if (!env?.OTHER_DB?.prepare) throw new Error('OTHER_DB binding is missing');
  if (!validPreparedParse(task.preparedParse, task)) {
    throw new Error('buddy playback parse-store payload is invalid');
  }
  const queue = task.preparedParse.queue;
  const serialized = serializedQueue(queue);
  const observedAt = finiteNumber(task.observedAt, Date.now());
  const result = await env.OTHER_DB.prepare(PIPELINE_PARSED_DIRECT_SQL).bind(
    serialized.parsedQueueJson,
    serialized.stateJson,
    queue.station_id,
    queue.queue_id,
    queue.start_time,
    queue.is_paused ? 1 : 0,
    queue.is_broadcasting ? 1 : 0,
    queue.host_account_id,
    queue.host_handle,
    queue.tracks.length,
    observedAt,
    task.channelAlias,
    task.cycleAt,
  ).run();
  if (changedRows(result) <= 0) {
    const row = await loadPipelineRow(env, task.channelAlias);
    if (!rowMatchesTask(row, task)) {
      return { skipped: true, reason: 'stale-cycle', pending: false, cycle_at: task.cycleAt };
    }
    if (row.stage === 'metadata') {
      return {
        skipped: false,
        pending: true,
        stage: 'metadata',
        cycle_at: task.cycleAt,
        tracks: queue.tracks.length,
        checked_at: finiteNumber(task.preparedParse.observed_at),
        replayed_handoff: true,
      };
    }
    if (row.stage === 'commit') {
      return { skipped: true, reason: 'stage-advanced', pending: false, stage: row.stage, cycle_at: task.cycleAt };
    }
    throw new Error(`buddy playback parse-store lost its durable transition at stage ${String(row.stage || 'missing')}`);
  }
  return {
    skipped: false,
    pending: true,
    stage: 'metadata',
    cycle_at: task.cycleAt,
    tracks: queue.tracks.length,
    checked_at: finiteNumber(task.preparedParse.observed_at),
  };
}
