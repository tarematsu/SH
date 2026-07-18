import { buddyPlaybackConfig, shouldRunBuddyPlayback } from './buddy-playback.js';
import { BUDDY_PARSE_COMPUTE_STAGE } from './buddy-playback-parse-stages.js';
import {
  BUDDY_PLAYBACK_PIPELINE_SCHEMA_SQL,
  buddyPlaybackPipelineSlot,
  fetchBuddyPlaybackText,
} from './buddy-playback-pipeline.js';
import { collectBuddyPlaybackReady } from './buddy-runtime.js';

export const BUDDY_FETCH_COMPUTE_STAGE = 'fetch-compute';

const PIPELINE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_sh_buddy_playback_pipeline_due
  ON sh_buddy_playback_pipeline(next_attempt_at, lease_until, updated_at)`;
const PIPELINE_RESET_STALE_SQL = `UPDATE sh_buddy_playback_pipeline SET
    cycle_at=?,observed_at=NULL,stage='fetch',raw_json=NULL,parsed_queue_json=NULL,
    state_json=NULL,final_queue_json=NULL,station_id=NULL,queue_id=NULL,start_time=NULL,
    is_paused=NULL,is_broadcasting=NULL,host_account_id=NULL,host_handle=NULL,
    track_count=0,metadata_attempts=0,attempts=0,next_attempt_at=0,lease_until=0,last_error=NULL,updated_at=?
  WHERE channel_alias=? AND cycle_at<=? AND lease_until<=?`;
const PIPELINE_PLAN_SELECT_SQL = `SELECT channel_alias,cycle_at,observed_at,stage,
    next_attempt_at,lease_until,updated_at
  FROM sh_buddy_playback_pipeline WHERE channel_alias=? LIMIT 1`;
const PIPELINE_INSERT_SQL = `INSERT OR IGNORE INTO sh_buddy_playback_pipeline (
    channel_alias,cycle_at,stage,updated_at
  ) VALUES (?,?,'fetch',?)`;
const PIPELINE_CLAIM_SQL = `UPDATE sh_buddy_playback_pipeline SET
    lease_until=?,attempts=attempts+1,updated_at=?
  WHERE channel_alias=? AND lease_until<=? AND next_attempt_at<=?
  RETURNING channel_alias,cycle_at,observed_at,stage,next_attempt_at,lease_until,updated_at`;
const PIPELINE_FETCHED_SQL = `UPDATE sh_buddy_playback_pipeline SET
    observed_at=?,stage='parse',raw_json=?,next_attempt_at=0,lease_until=0,
    last_error=NULL,updated_at=?
  WHERE channel_alias=? AND cycle_at=? AND stage='fetch'`;
const PIPELINE_FAILURE_SQL = `UPDATE sh_buddy_playback_pipeline SET
    next_attempt_at=?,lease_until=0,last_error=?,updated_at=?
  WHERE channel_alias=? AND cycle_at=? AND stage='fetch'`;

const PIPELINE_LEASE_MS = 90_000;
const PIPELINE_RETRY_MS = 5 * 60_000;
const PIPELINE_MAX_AGE_MS = 2 * 60 * 60_000;
let pipelineSchemaReady = false;

function finiteNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cycleStart(scheduledAt, intervalMs) {
  return Math.floor(scheduledAt / intervalMs) * intervalMs;
}

function pipelineTableMissing(error) {
  return /no such table:\s*sh_buddy_playback_pipeline/i.test(String(error?.message || error));
}

function changedRows(result) {
  return Number(result?.meta?.changes || 0);
}

async function ensurePipelineSchema(env) {
  if (pipelineSchemaReady) return false;
  await env.OTHER_DB.batch([
    env.OTHER_DB.prepare(BUDDY_PLAYBACK_PIPELINE_SCHEMA_SQL),
    env.OTHER_DB.prepare(PIPELINE_INDEX_SQL),
  ]);
  pipelineSchemaReady = true;
  return true;
}

async function loadPlanRow(env, alias) {
  return env.OTHER_DB.prepare(PIPELINE_PLAN_SELECT_SQL).bind(alias).first();
}

function stageHandoff(row, options = {}) {
  const stage = String(row?.stage || '');
  const result = {
    skipped: false,
    pending: true,
    stage,
    cycle_at: finiteNumber(row?.cycle_at),
    channel_alias: String(row?.channel_alias || ''),
    ...(options.replayed ? { replayed_handoff: true } : {}),
  };
  if (stage === 'fetch') result.direct_stage = BUDDY_FETCH_COMPUTE_STAGE;
  else if (stage === 'parse') result.direct_stage = BUDDY_PARSE_COMPUTE_STAGE;
  return result;
}

async function prepareFetchPlan(env, config, scheduledAt, observedAt) {
  const cycleAt = cycleStart(scheduledAt, config.intervalMs);
  await env.OTHER_DB.prepare(PIPELINE_RESET_STALE_SQL)
    .bind(cycleAt, observedAt, config.alias, observedAt - PIPELINE_MAX_AGE_MS, observedAt)
    .run();
  let row = await loadPlanRow(env, config.alias);
  if (!row && shouldRunBuddyPlayback(scheduledAt, config.intervalMs)) {
    await env.OTHER_DB.prepare(PIPELINE_INSERT_SQL)
      .bind(config.alias, cycleAt, observedAt)
      .run();
    row = await loadPlanRow(env, config.alias);
  }
  if (!row) return { skipped: true, reason: 'not-due' };
  if (finiteNumber(row.next_attempt_at, 0) > observedAt) {
    return { skipped: true, reason: 'retry-not-due', stage: row.stage, cycle_at: row.cycle_at };
  }
  if (String(row.stage || '') !== 'fetch') return stageHandoff(row, { replayed: true });
  if (finiteNumber(row.cycle_at) === cycleAt && finiteNumber(row.lease_until, 0) > observedAt) {
    return stageHandoff(row, { replayed: true });
  }
  const claimed = await env.OTHER_DB.prepare(PIPELINE_CLAIM_SQL)
    .bind(observedAt + PIPELINE_LEASE_MS, observedAt, config.alias, observedAt, observedAt)
    .first();
  return claimed
    ? stageHandoff(claimed)
    : { skipped: true, reason: 'pipeline-busy', stage: row.stage, cycle_at: row.cycle_at };
}

export async function processBuddyFetchPlan(env, task) {
  if (!env?.OTHER_DB?.prepare) return { skipped: true, reason: 'db-binding-missing' };
  const config = buddyPlaybackConfig(env);
  if (!config.enabled) return { skipped: true, reason: 'disabled' };
  if (!buddyPlaybackPipelineSlot(task.scheduledAt)) return { skipped: true, reason: 'not-due' };
  try {
    return await prepareFetchPlan(env, config, task.scheduledAt, task.observedAt);
  } catch (error) {
    if (!pipelineTableMissing(error)) throw error;
    await ensurePipelineSchema(env);
    return prepareFetchPlan(env, config, task.scheduledAt, task.observedAt);
  }
}

function rowMatchesTask(row, task) {
  return row
    && String(row.channel_alias || '') === String(task.channelAlias || '')
    && finiteNumber(row.cycle_at) === task.cycleAt;
}

async function recordFetchFailure(env, task, error) {
  const detail = String(error?.message || error).replace(/\s+/g, ' ').trim().slice(0, 1000);
  await env.OTHER_DB.prepare(PIPELINE_FAILURE_SQL).bind(
    task.observedAt + PIPELINE_RETRY_MS,
    detail,
    task.observedAt,
    task.channelAlias,
    task.cycleAt,
  ).run();
}

export async function processBuddyFetchCompute(env, task, dependencies = {}) {
  if (!env?.OTHER_DB?.prepare) throw new Error('OTHER_DB binding is missing');
  const row = await loadPlanRow(env, task.channelAlias);
  if (!rowMatchesTask(row, task)) {
    return { skipped: true, reason: 'stale-cycle', pending: false, cycle_at: task.cycleAt };
  }
  if (finiteNumber(row.next_attempt_at, 0) > task.observedAt) {
    return { skipped: true, reason: 'retry-not-due', pending: false, stage: row.stage, cycle_at: task.cycleAt };
  }
  if (row.stage === 'parse') return stageHandoff(row, { replayed: true });
  if (row.stage !== 'fetch') return stageHandoff(row, { replayed: true });

  const ready = dependencies.collectReady || collectBuddyPlaybackReady;
  const fetchText = dependencies.fetchText || fetchBuddyPlaybackText;
  try {
    return await ready(env, task.observedAt, {
      ...dependencies,
      collect: async (runtimeEnv, stageObservedAt, runtimeDependencies = {}) => {
        const config = buddyPlaybackConfig(runtimeEnv);
        const rawJson = await fetchText(runtimeEnv, config, runtimeDependencies.fetch);
        const result = await env.OTHER_DB.prepare(PIPELINE_FETCHED_SQL)
          .bind(stageObservedAt, rawJson, stageObservedAt, task.channelAlias, task.cycleAt)
          .run();
        if (changedRows(result) <= 0) {
          const advanced = await loadPlanRow(env, task.channelAlias);
          if (!rowMatchesTask(advanced, task)) {
            return { skipped: true, reason: 'stale-cycle', pending: false, cycle_at: task.cycleAt };
          }
          return stageHandoff(advanced, { replayed: true });
        }
        return {
          skipped: false,
          pending: true,
          stage: 'parse',
          direct_stage: BUDDY_PARSE_COMPUTE_STAGE,
          cycle_at: task.cycleAt,
          channel_alias: task.channelAlias,
          checked_at: stageObservedAt,
        };
      },
    });
  } catch (error) {
    await recordFetchFailure(env, task, error).catch(() => {});
    throw error;
  }
}

export function resetBuddyFetchStagesForTests() {
  pipelineSchemaReady = false;
}
