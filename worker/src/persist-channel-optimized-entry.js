import { processPersistenceTask } from './persist-channel-entry.js';

async function processPersistenceBatch(batch, env) {
  const messages = batch.messages;
  if (!messages?.length) return;
  const message = messages[0];
  try {
    const result = await processPersistenceTask(env, message.body);
    console.log(JSON.stringify({ event: 'persistence_task_completed', ...result }));
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'persistence_task_failed',
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry({ delaySeconds: 30 });
  }
}

export default {
  queue: processPersistenceBatch,
};
