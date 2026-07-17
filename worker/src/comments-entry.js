import {
  collectOptionalComments,
  fetchOptionalComments,
  persistOptionalComments,
} from './collector-comments.js';
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

function metadataJob(forwarding) {
  const message = forwarding?.message;
  if (!forwarding?.forwarded
      || !message?.options?.enrichTrackMetadata
      || !message?.payload?.queue?.tracks?.length) return null;
  return {
    jobId: forwarding.job_id,
    payload: message.payload,
    options: message.options,
  };
}

async function enqueueMetadata(env, ctx, forwarding) {
  const job = metadataJob(forwarding);
  if (!job) return;
  if (env?.TRACK_METADATA_QUEUE?.send) {
    await env.TRACK_METADATA_QUEUE.send({
      message_type: 'stationhead-track-metadata',
      message_version: 1,
      task: 'committed-enrichment',
      job,
    }, { contentType: 'json' });
    return;
  }

  const { runCommittedMetadataEnrichment } = await import('./committed-metadata-enrichment.js');
  const task = runCommittedMetadataEnrichment(env, [job]);
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(task);
  else await task;
}

function forwardedMinuteFact(task, finalComments) {
  const source = task.minute_fact;
  const payload = source?.payload;
  const options = source?.options;
  if (source && payload && options
      && Object.isExtensible(source)
      && Object.isExtensible(payload)
      && Object.isExtensible(options)) {
    source.read_model = null;
    payload.comments = finalComments;
    options.collectComments = false;
    return source;
  }
  return {
    ...source,
    read_model: null,
    payload: {
      ...payload,
      comments: finalComments,
    },
    options: {
      ...(options || {}),
      collectComments: false,
    },
  };
}

export async function forwardMinuteFact(
  env,
  task,
  comments = {},
  dependencies = {},
  validatedMinuteFact = null,
) {
  if (!task?.minute_fact) return { forwarded: false };
  if (!env?.MINUTE_FACT_QUEUE?.send && !dependencies.sendMinuteFact) {
    throw new Error('MINUTE_FACT_QUEUE binding is missing');
  }

  const parse = dependencies.parseMinuteFact || parseMinuteFactQueueMessage;
  const parsed = validatedMinuteFact || parse(task.minute_fact);
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
  const message = forwardedMinuteFact(task, finalComments);
  const send = dependencies.sendMinuteFact
    || ((body) => env.MINUTE_FACT_QUEUE.send(body, { contentType: 'json' }));
  await send(message);
  return {
    forwarded: true,
    job_id: parsed.job_id,
    comments: finalComments,
    message,
  };
}

async function enqueuePersist(env, task, collected, dependencies = {}) {
  if (dependencies.enqueuePersist) {
    await dependencies.enqueuePersist(task, collected);
    return true;
  }
  if (!env?.COMMENTS_QUEUE?.send || !task?.minute_fact) return false;
  await env.COMMENTS_QUEUE.send({
    message_type: 'stationhead-comments-persist',
    message_version: 1,
    observed_at: task.observed_at,
    station_id: task.station_id,
    minute_fact: task.minute_fact,
    collected,
  }, { contentType: 'json' });
  return true;
}

async function enqueueForward(env, task, comments, dependencies = {}) {
  if (dependencies.enqueueForward) {
    await dependencies.enqueueForward(task, comments);
    return true;
  }
  if (!env?.COMMENTS_QUEUE?.send || !task?.minute_fact) return false;
  await env.COMMENTS_QUEUE.send({
    message_type: 'stationhead-comments-forward',
    message_version: 1,
    observed_at: task.observed_at,
    station_id: task.station_id,
    minute_fact: task.minute_fact,
    comments,
  }, { contentType: 'json' });
  return true;
}

export async function processCommentsForwardTask(env, task, dependencies = {}) {
  if (task?.message_type !== 'stationhead-comments-forward'
      || Number(task?.message_version) !== 1
      || !task.minute_fact) {
    throw new Error('unsupported comments forward task');
  }
  return forwardMinuteFact(env, task, task.comments || {}, dependencies);
}

export async function processCommentsPersistTask(env, task, dependencies = {}) {
  if (task?.message_type !== 'stationhead-comments-persist'
      || Number(task?.message_version) !== 1
      || !task.minute_fact) {
    throw new Error('unsupported comments persist task');
  }
  const parse = dependencies.parseMinuteFact || parseMinuteFactQueueMessage;
  const validatedMinuteFact = parse(task.minute_fact);
  const persist = dependencies.persistComments || persistOptionalComments;
  const result = await persist(
    env,
    Number(task.station_id) || null,
    task.collected || { comments: [], rawMeta: { next: null } },
    Number(task.observed_at) || Date.now(),
    dependencies.persistence || null,
  );
  const comments = { ...result, degraded: false };
  if (await enqueueForward(env, task, comments, dependencies)) {
    console.log(JSON.stringify({
      event: 'comments_persist_completed',
      comments_saved: Number(result?.commentsSaved || 0),
      minute_fact_forward_deferred: true,
    }));
    return { ...result, forwarded: false, forward_deferred: true };
  }
  const forwarding = await forwardMinuteFact(
    env,
    task,
    comments,
    dependencies,
    validatedMinuteFact,
  );
  return { ...result, ...forwarding };
}

export async function processCommentsTask(env, task, dependencies = {}) {
  const version = Number(task?.message_version);
  if (task?.message_type !== 'stationhead-comments-task' || ![1, 2].includes(version)) {
    throw new Error('unsupported comments task');
  }
  let validatedMinuteFact = null;
  if (version === 2) {
    if (!task.minute_fact) throw new Error('comments task minute_fact is missing');
    const parse = dependencies.parseMinuteFact || parseMinuteFactQueueMessage;
    validatedMinuteFact = parse(task.minute_fact);
  }

  const state = collectorStateFromAuthState(task.auth, env);
  state.stationId = Number(task.station_id || state.stationId) || null;
  const config = configFromEnv(env);
  if (task.minute_fact && (env?.COMMENTS_QUEUE?.send || dependencies.enqueuePersist)) {
    const fetchComments = dependencies.fetchComments || fetchOptionalComments;
    const collected = await fetchComments(state, config, dependencies.fetching || null);
    await enqueuePersist(env, task, collected, dependencies);
    console.log(JSON.stringify({
      event: 'comments_task_completed',
      comments_fetched: Number(collected?.comments?.length || 0),
      persistence_deferred: true,
    }));
    return {
      commentsSaved: 0,
      degraded: false,
      forwarded: false,
      persist_deferred: true,
    };
  }

  const collectComments = dependencies.collectComments || collectOptionalComments;
  const result = await collectComments(
    env,
    state,
    config,
    Number(task.observed_at) || Date.now(),
  );
  if (result?.degraded) {
    const stage = String(result.errorStage || 'unknown').slice(0, 120);
    const error = new Error(`comment collection degraded at ${stage}`);
    error.code = 'COMMENTS_DEGRADED';
    error.errorStage = stage;
    throw error;
  }

  const comments = { ...result, degraded: false };
  if (await enqueueForward(env, task, comments, dependencies)) {
    console.log(JSON.stringify({
      event: 'comments_task_completed',
      comments_saved: Number(result?.commentsSaved || 0),
      minute_fact_forward_deferred: true,
    }));
    return { ...result, forwarded: false, forward_deferred: true };
  }

  const forwarding = await forwardMinuteFact(env, task, comments, dependencies, validatedMinuteFact);
  console.log(JSON.stringify({
    event: 'comments_task_completed',
    comments_saved: Number(result?.commentsSaved || 0),
    minute_fact_forwarded: forwarding.forwarded,
  }));
  return { ...result, ...forwarding };
}

export default {
  async queue(batch, env, ctx) {
    for (const message of batch.messages || []) {
      try {
        const type = message.body?.message_type;
        if (type === 'stationhead-comments-forward') {
          const forwarding = await processCommentsForwardTask(env, message.body);
          await enqueueMetadata(env, ctx, forwarding);
          message.ack();
          continue;
        }
        if (type === 'stationhead-comments-persist') {
          const result = await processCommentsPersistTask(env, message.body);
          await enqueueMetadata(env, ctx, result);
          message.ack();
          continue;
        }

        const result = await processCommentsTask(env, message.body);
        await enqueueMetadata(env, ctx, result);
        message.ack();
      } catch (error) {
        if (error?.code === 'MINUTE_FACT_QUEUE_INVALID_MESSAGE') {
          console.error(JSON.stringify({
            event: 'comments_task_invalid_minute_fact',
            error: String(error?.message || error).slice(0, 800),
          }));
          message.ack();
          continue;
        }
        const attempts = positiveInteger(message.attempts, 1, 100);
        const maximum = positiveInteger(env.COMMENT_CHAIN_MAX_ATTEMPTS, 3, 8);
        const chained = Boolean(message.body?.minute_fact);
        const chainStage = ['stationhead-comments-task', 'stationhead-comments-persist']
          .includes(message.body?.message_type);
        if (chainStage && chained && attempts >= maximum) {
          try {
            const comments = {
              commentsSaved: 0,
              degraded: true,
              errorStage: String(error?.errorStage || error?.message || 'unknown').slice(0, 120),
            };
            if (await enqueueForward(env, message.body, comments)) {
              console.warn(JSON.stringify({
                event: 'comments_task_degraded_forward_deferred',
                attempts,
                error: String(error?.message || error).slice(0, 800),
              }));
              message.ack();
              continue;
            }
            const forwarding = await forwardMinuteFact(env, message.body, comments);
            await enqueueMetadata(env, ctx, forwarding);
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
