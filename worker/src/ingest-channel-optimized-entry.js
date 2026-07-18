export async function ingestRawCollection(env, message) {
  if (Number(message?.message_version) === 3) {
    const [prepared, queueAnalysis, snapshotAnalysis] = await Promise.all([
      import('./ingest-prepared-channel.js'),
      import('./queue-analysis-transfer.js'),
      import('./snapshot-analysis-transfer.js'),
    ]);
    if (message.snapshot) {
      snapshotAnalysis.restoreSnapshotAnalysis(message.snapshot, message.snapshot_analysis);
    }
    if (message.queue) queueAnalysis.restoreQueueAnalysis(message.queue, message.queue_analysis);
    return prepared.ingestPreparedRawCollection(env, message);
  }
  const legacy = await import('./ingest-channel-entry.js');
  return legacy.ingestRawCollection(env, message);
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages || []) {
      const type = message.body?.message_type;
      try {
        if (type === 'stationhead-ingest-fact') {
          const { processIngestFactTask } = await import('./ingest-fact-stage.js');
          const result = await processIngestFactTask(env, message.body);
          console.log(JSON.stringify(result));
        } else if (type === 'stationhead-ingest-finalize') {
          const { processIngestFinalizeTask } = await import('./ingest-finalize-entry.js');
          const result = await processIngestFinalizeTask(env, message.body);
          console.log(JSON.stringify(result));
        } else {
          await ingestRawCollection(env, message.body);
        }
        message.ack();
      } catch (error) {
        const event = type === 'stationhead-ingest-fact'
          ? 'ingest_fact_failed'
          : type === 'stationhead-ingest-finalize'
          ? 'ingest_finalize_failed'
          : 'raw_collection_ingest_failed';
        console.error(JSON.stringify({
          event,
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
