import { ingestPreparedRawCollection } from './ingest-prepared-channel.js';
import { restoreQueueAnalysis } from './queue-analysis-transfer.js';
import { restoreSnapshotAnalysis } from './snapshot-analysis-transfer.js';

export function ingestPreparedRuntime(env, message) {
  if (message.snapshot) {
    restoreSnapshotAnalysis(message.snapshot, message.snapshot_analysis);
  }
  if (message.queue) restoreQueueAnalysis(message.queue, message.queue_analysis);
  return ingestPreparedRawCollection(env, message);
}
