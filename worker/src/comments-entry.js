import { collectOptionalComments } from './collector-comments.js';
import { configFromEnv } from './collector-config.js';
import { collectorStateFromAuthState } from './collector-state.js';
import { parseMinuteFactQueueMessage } from './minute-facts-queue.js';
import { loadMinuteCommentFacts } from './minute-facts-source.js';

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function retryDelaySeconds(attempts) {
  const exponent = Math.max(0, Math.min(5, positiveInteger(attempts, 1) - 1));
  return Math.min(60, 5 * (2 ** exponent));
}

export async function forwardMinuteFact(env, task, comments = {}, dependencies = {}) {
  if (!task?.minute_fact) return { forwarded: false };
  if (!env?.MINUTE_FACT_QUEUE?.send && !dependencies.sendMinuteFact) {
    throw new Error('MINUTE_FACT_QUEUE binding is missing');
  }

  const parse = dependencies.parseMinuteFact || parseMinuteFactQueueMessage;
  const parsed = parse(task.minute_fact);
  const loadFacts = dependencies.loadCommentFacts || loadMinuteCommentFacts;
  const facts = await loadFacts(
    env?.DB,
    task.station_id,
    task.observed_at,
    comments,
  );
  const finalComments = {
    ...comments,
    commentCount: facts?.commentCount ?? comments?.commentCount ?? null,
    commentTotal: facts?.commentTotal ?? comments?.commentTotal ?? null,
    commentTotalKnown: (facts?.commentTotal ?? comments?.commentTotal) != null,
  };
  const message = {
    ...task.minute_fact,
    read_model: null,
    payload: {
      ...task.minute_fact.payload,
      comments: finalComments,
    },
    options: {
      ...(task.minute_fact.options || {}),
      collectComments: false,
    },
  };
  parse(message);
  const send = dependencies.sendMinuteFact
    || ((body) => env.MINUTE_FACT_QUEUE.send(body, { contentType: 'json' }));
  await send(message);
  return { forwarded: true, job_id: parsed.job_id, comments: finalComments };
}

export async function processCommentsTask(env, task, dependencies = {}) {
  const version = Number(task?.message_version);
  if (task?.message_type !== 'stationhead-comments-task' || ![1, 2].includes(version)) {
    throw new Error('unsupported comments task');
  }
  if (version === 2 && !task.minute_fact) throw new Error('comments task minute_fact is missing');

  const state = collectorStateFromAuthState(task.auth, env);
  state.stationId = Number(task.station_id || state.stationId) || null;
  const collectComments = dependencies.collectComments || collectOptionalComments;
  const result = await collectComments(
    env,
    state,
    configFromEnv(env),
    Number(task.observed_at) || Date.now(),
  );
  if (result?.degraded) {
    const stage = String(result.errorStage || 'unknown').slice(0, 120);
    const error = new Error(`comment collection degraded at ${stage}`);
    error.code = 'COMMENTS_DEGRADED';
    error.errorStage = stage;
    throw error;
  }

  const forwarding = await forwardMinuteFact(env, task, {
    ...result,
    degraded: false,
  }, dependencies);
  console.log(JSON.stringify({
    event: 'comments_task_completed',
    comments_saved: Number(result?.commentsSaved || 0),
    minute_fact_forwarded: forwarding.forwarded,
  }));
  return { ...result, ...forwarding };
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages || []) {
      try {
        await processCommentsTask(env, message.body);
        message.ack();
      } catch (error) {
        const attempts = positiveInteger(message.attempts, 1, 100);
        const maximum = positiveInteger(env.COMMENT_CHAIN_MAX_ATTEMPTS, 3, 8);
        const chained = Boolean(message.body?.minute_fact);
        if (chained && attempts >= maximum) {
          try {
            await forwardMinuteFact(env, message.body, {
              commentsSaved: 0,
              degraded: true,
              errorStage: String(error?.errorStage || error?.message || 'unknown').slice(0, 120),
            });
            console.warn(JSON.stringify({
              event: 'comments_task_degraded_forward',
              attempts,
              error: String(error?.message || error).slice(0, 800),
            }));
            message.ack();
            continue;
          } catch (forwardError) {
            console.error(JSON.stringify({
              event: 'comments_task_degraded_forward_failed',
              attempts,
              error: String(forwardError?.message || forwardError).slice(0, 800),
            }));
          }
        }
        console.error(JSON.stringify({
          event: 'comments_task_failed',
          attempts,
          error: String(error?.message || error).slice(0, 800),
        }));
        message.retry({ delaySeconds: retryDelaySeconds(attempts) });
      }
    }
  },
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
