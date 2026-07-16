import { collectOptionalComments } from './collector-comments.js';
import { configFromEnv } from './collector-config.js';
import { collectorStateFromAuthState } from './collector-state.js';

export async function processCommentsTask(env, task, dependencies = {}) {
  if (task?.message_type !== 'stationhead-comments-task' || Number(task?.message_version) !== 1) {
    throw new Error('unsupported comments task');
  }
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
    throw new Error(`comment collection degraded at ${stage}`);
  }
  console.log(JSON.stringify({
    event: 'comments_task_completed',
    comments_saved: Number(result?.commentsSaved || 0),
  }));
  return result;
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages || []) {
      try {
        await processCommentsTask(env, message.body);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({
          event: 'comments_task_failed',
          error: String(error?.message || error).slice(0, 800),
        }));
        message.retry();
      }
    }
  },
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};