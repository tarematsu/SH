import { sanitizeFailureDetail } from './collector-failure.js';
import { collectOptionalComments } from './collector-comments.js';
import { configFromEnv } from './collector-config.js';
import { loadCollectorState } from './collector-state.js';
import { enqueueMinuteFactJob, minuteFactJobPayload } from './minute-facts-inbox.js';
import { loadMinuteCommentFacts } from './minute-facts-source.js';
import { minuteBucket } from './minute-facts-store.js';

export const MINUTE_COMMENT_TASK_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sh_minute_comment_tasks (
  task_id TEXT PRIMARY KEY,
  source_job_id TEXT NOT NULL UNIQUE,
  channel_id INTEGER NOT NULL,
  station_id INTEGER,
  minute_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
)`;

export const MINUTE_COMMENT_TASK_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_sh_minute_comment_tasks_pending
  ON sh_minute_comment_tasks(status, next_attempt_at, minute_at)`;

let schemaReady = new WeakSet();
const DEFAULT_TASK_LIMIT = 1;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 4;

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function withSourceDatabase(env, binding) {
  const source = env?.[binding];
  if (!source) return env;
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === 'DB') return source;
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      return property === 'DB' || Reflect.has(target, property);
    },
  });
}

async function ensureMinuteCommentTaskSchema(env) {
  if (!env?.MINUTE_DB) throw new Error('minute comment task MINUTE_DB binding is missing');
  if (schemaReady.has(env.MINUTE_DB)) return false;
  await env.MINUTE_DB.batch([
    env.MINUTE_DB.prepare(MINUTE_COMMENT_TASK_SCHEMA_SQL),
    env.MINUTE_DB.prepare(MINUTE_COMMENT_TASK_INDEX_SQL),
  ]);
  schemaReady.add(env.MINUTE_DB);
  return true;
}

export function minuteCommentTaskId(sourceJobId) {
  return `minute-comments:${String(sourceJobId || '').trim()}`;
}

export async function saveMinuteCommentTask(env, job) {
  if (!job?.options?.collectComments) return { created: false, skipped: true };
  await ensureMinuteCommentTaskSchema(env);
  const payload = minuteFactJobPayload(job.payload);
  const sourceJobId = String(job.jobId || '').trim();
  const channelId = integer(payload.snapshot?.channel_id);
  if (!sourceJobId || channelId == null) return { created: false, skipped: true };
  const observedAt = integer(payload.observedAt) ?? Date.now();
  const stationId = integer(payload.snapshot?.station_id);
  const now = Date.now();
  const result = await env.MINUTE_DB.prepare(`INSERT OR IGNORE INTO sh_minute_comment_tasks(
      task_id,source_job_id,channel_id,station_id,minute_at,observed_at,payload_json,
      status,attempts,next_attempt_at,lease_until,last_error,created_at,updated_at,completed_at
    ) VALUES(?,?,?,?,?,?,?,'pending',0,0,NULL,NULL,?,?,NULL)`)
    .bind(
      minuteCommentTaskId(sourceJobId),
      sourceJobId,
      channelId,
      stationId,
      minuteBucket(observedAt),
      observedAt,
      JSON.stringify(payload),
      now,
      now,
    )
    .run();
  return { created: Number(result?.meta?.changes || 0) > 0, skipped: false };
}

function positive(value, fallback, maximum) {
  const parsed = integer(value);
  if (parsed == null || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

export async function claimMinuteCommentTasks(env, options = {}) {
  await ensureMinuteCommentTaskSchema(env);
  const now = integer(options.now) ?? Date.now();
  const limit = positive(options.limit, DEFAULT_TASK_LIMIT, 5);
  const leaseMs = positive(options.leaseMs, DEFAULT_LEASE_MS, 10 * 60_000);
  await env.MINUTE_DB.prepare(`UPDATE sh_minute_comment_tasks SET
      status='pending',lease_until=NULL,updated_at=?
    WHERE status='processing' AND COALESCE(lease_until,0)<?`)
    .bind(now, now)
    .run();
  const result = await env.MINUTE_DB.prepare(`UPDATE sh_minute_comment_tasks SET
      status='processing',attempts=attempts+1,lease_until=?,updated_at=?
    WHERE task_id IN (
      SELECT task_id FROM sh_minute_comment_tasks
      WHERE status='pending' AND next_attempt_at<=?
      ORDER BY minute_at ASC,task_id ASC
      LIMIT ?
    )
    RETURNING *`)
    .bind(now + leaseMs, now, now, limit)
    .all();
  return result.results || [];
}

export async function completeMinuteCommentTask(env, taskId, now = Date.now()) {
  await env.MINUTE_DB.prepare(`UPDATE sh_minute_comment_tasks SET
      status='done',lease_until=NULL,completed_at=?,updated_at=?,last_error=NULL
    WHERE task_id=? AND status='processing'`)
    .bind(now, now, taskId)
    .run();
}

function retryDelayMs(attempts) {
  const exponent = Math.max(0, Math.min(4, (integer(attempts) || 1) - 1));
  return Math.min(15 * 60_000, 60_000 * (2 ** exponent));
}

export async function failMinuteCommentTask(env, task, error, options = {}) {
  const now = integer(options.now) ?? Date.now();
  const maxAttempts = positive(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, 20);
  const attempts = integer(task?.attempts) || 1;
  const terminal = attempts >= maxAttempts;
  await env.MINUTE_DB.prepare(`UPDATE sh_minute_comment_tasks SET
      status=?,next_attempt_at=?,lease_until=NULL,last_error=?,updated_at=?
    WHERE task_id=? AND status='processing'`)
    .bind(
      terminal ? 'dead' : 'pending',
      terminal ? 0 : now + retryDelayMs(attempts),
      sanitizeFailureDetail(error?.message || error),
      now,
      task.task_id,
    )
    .run();
  return { terminal };
}

function parsePayload(task) {
  try {
    return minuteFactJobPayload(JSON.parse(String(task?.payload_json || '')));
  } catch (error) {
    throw new Error(`invalid minute comment task payload: ${error?.message || error}`);
  }
}

export async function runMinuteCommentTasks(env, options = {}) {
  if (!env?.MINUTE_DB || !env?.BUDDIES_DB) {
    return { skipped: true, reason: 'binding-missing', claimed: 0, completed: 0, failed: 0 };
  }
  const nowFn = options.now || Date.now;
  const claim = options.claim || claimMinuteCommentTasks;
  const complete = options.complete || completeMinuteCommentTask;
  const fail = options.fail || failMinuteCommentTask;
  const collect = options.collect || collectOptionalComments;
  const loadState = options.loadState || loadCollectorState;
  const loadFacts = options.loadFacts || loadMinuteCommentFacts;
  const enqueue = options.enqueue || enqueueMinuteFactJob;
  const tasks = await claim(env, { now: nowFn(), limit: options.limit });
  const summary = { skipped: false, claimed: tasks.length, completed: 0, failed: 0, dead: 0 };
  const sourceEnv = withSourceDatabase(env, 'BUDDIES_DB');
  const config = options.config || configFromEnv(sourceEnv);

  for (const task of tasks) {
    try {
      const payload = parsePayload(task);
      const state = await loadState(sourceEnv);
      state.stationId = integer(task.station_id) ?? state.stationId;
      const comments = await collect(sourceEnv, state, config, task.observed_at);
      if (comments?.degraded) {
        throw new Error(`comment collection degraded at ${comments.errorStage || 'unknown'}`);
      }
      const facts = await loadFacts(
        env.BUDDIES_DB,
        task.station_id,
        task.observed_at,
        comments,
      );
      const correctedPayload = {
        ...payload,
        comments: {
          ...comments,
          commentCount: facts.commentCount,
          commentTotal: facts.commentTotal,
          commentTotalKnown: facts.commentTotal != null,
          degraded: false,
        },
      };
      const result = await enqueue(env, correctedPayload, {
        jobKind: 'comment-correction',
        jobPriority: 10,
        requeueCompleted: true,
      });
      if (!result?.enqueued) throw new Error('minute fact correction was not accepted');
      await complete(env, task.task_id, nowFn());
      summary.completed += 1;
    } catch (error) {
      const result = await fail(env, task, error, {
        now: nowFn(),
        maxAttempts: options.maxAttempts ?? env.MINUTE_COMMENT_MAX_ATTEMPTS,
      });
      summary.failed += 1;
      if (result?.terminal) summary.dead += 1;
      console.warn(JSON.stringify({
        event: 'minute_comment_task_failed',
        task_id: String(task.task_id || ''),
        attempts: integer(task.attempts) || 1,
        terminal: Boolean(result?.terminal),
        error: sanitizeFailureDetail(error?.message || error),
      }));
    }
  }
  console.log(JSON.stringify({ event: 'minute_comment_task_summary', ...summary }));
  return summary;
}

export function resetMinuteCommentTaskSchemaForTests() {
  schemaReady = new WeakSet();
}
