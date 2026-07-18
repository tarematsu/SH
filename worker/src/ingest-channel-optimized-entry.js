let preparedModulesPromise;
let rawStagesPromise;
let legacyIngestPromise;
let ingestFactStagesPromise;
let ingestFinalizePromise;

function loadPreparedModules() {
  return preparedModulesPromise ??= Promise.all([
    import('./ingest-prepared-channel.js'),
    import('./queue-analysis-transfer.js'),
    import('./snapshot-analysis-transfer.js'),
  ]);
}

function loadRawStages() {
  return rawStagesPromise ??= import('./raw-collection-preparation.js');
}

function loadLegacyIngest() {
  return legacyIngestPromise ??= import('./ingest-channel-entry.js');
}

function loadIngestFactStages() {
  return ingestFactStagesPromise ??= import('./ingest-fact-stage.js');
}

function loadIngestFinalize() {
  return ingestFinalizePromise ??= import('./ingest-finalize-entry.js');
}

export async function ingestRawCollection(env, message, dependencies = {}) {
  if (Number(message?.message_version) === 3) {
    const [prepared, queueAnalysis, snapshotAnalysis] = await loadPreparedModules();
    if (message.snapshot) {
      snapshotAnalysis.restoreSnapshotAnalysis(message.snapshot, message.snapshot_analysis);
    }
    if (message.queue) queueAnalysis.restoreQueueAnalysis(message.queue, message.queue_analysis);
    return prepared.ingestPreparedRawCollection(env, message);
  }
  if (env?.INGEST_FINALIZE_QUEUE?.send && dependencies.inline !== true) {
    const stages = await loadRawStages();
    return stages.processRawNormalizeStage(env, message, dependencies);
  }
  const legacy = await loadLegacyIngest();
  return legacy.ingestRawCollection(env, message);
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages || []) {
      const body = message.body;
      const type = body?.message_type;
      try {
        if (type === 'stationhead-ingest-fact') {
          const stages = await loadIngestFactStages();
          const result = await stages.processIngestFactTask(env, body);
          console.log(JSON.stringify(result));
        } else if (type === 'stationhead-ingest-fact-deliver') {
          const stages = await loadIngestFactStages();
          const result = await stages.processIngestFactDeliveryTask(env, body);
          console.log(JSON.stringify(result));
        } else if (type === 'stationhead-ingest-finalize') {
          const stage = await loadIngestFinalize();
          const result = await stage.processIngestFinalizeTask(env, body);
          console.log(JSON.stringify(result));
        } else if (type === 'stationhead-raw-analysis') {
          const stages = await loadRawStages();
          await stages.processRawAnalysisStage(env, body);
        } else if (type === 'stationhead-raw-materialize') {
          const stages = await loadRawStages();
          await stages.processRawMaterializeStage(env, body);
        } else {
          await ingestRawCollection(env, body);
        }
        message.ack();
      } catch (error) {
        const event = type === 'stationhead-ingest-fact'
          || type === 'stationhead-ingest-fact-deliver'
          ? 'ingest_fact_failed'
          : type === 'stationhead-ingest-finalize'
          ? 'ingest_finalize_failed'
          : type === 'stationhead-raw-analysis'
          ? 'raw_collection_analysis_failed'
          : type === 'stationhead-raw-materialize'
          ? 'raw_collection_materialization_failed'
          : 'raw_collection_ingest_failed';
        console.error(JSON.stringify({
          event,
          error: String(error?.message || error).slice(0, 800),
        }));
        const retryDelaySeconds = Number(error?.retryDelaySeconds);
        if (retryDelaySeconds > 0) {
          message.retry({ delaySeconds: Math.max(1, retryDelaySeconds) });
        } else {
          message.retry();
        }
      }
    }
  },
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
