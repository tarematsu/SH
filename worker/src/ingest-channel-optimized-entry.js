import { ingestPreparedRawCollection } from './ingest-prepared-channel.js';
import { restoreQueueAnalysis } from './queue-analysis-transfer.js';
import { restoreSnapshotAnalysis } from './snapshot-analysis-transfer.js';

export async function ingestRawCollection(env, message) {
  if (Number(message?.message_version) === 3) {
    if (message.snapshot) restoreSnapshotAnalysis(message.snapshot, message.snapshot_analysis);
    if (message.queue) restoreQueueAnalysis(message.queue, message.queue_analysis);
    return ingestPreparedRawCollection(env, message);
  }
  const legacy = await import('./ingest-channel-entry.js');
  return legacy.ingestRawCollection(env, message);
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages || []) {
      try {
        await ingestRawCollection(env, message.body);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({
          event: 'raw_collection_ingest_failed',
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
