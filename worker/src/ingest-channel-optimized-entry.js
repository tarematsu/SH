const EMPTY_DEPENDENCIES = Object.freeze({});

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

function logIngestResult(result, fallbackEvent) {
  console.log(JSON.stringify({
    event: result?.event || fallbackEvent,
    task: result?.task ?? null,
    stage: result?.stage ?? null,
    processed: result?.processed ?? result?.received ?? 0,
    failed: result?.failed ?? 0,
    pending: result?.pending === true,
    job_id: result?.job_id ?? result?.jobId ?? null,
  }));
}

export async function ingestRawCollection(env, message, dependencies = EMPTY_DEPENDENCIES) {
  const version = message?.message_version;
  if (version === 3 || Number(version) === 3) {
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

async function processIngestBatch(batch, env) {
  const messages = batch.messages;
  if (!messages?.length) return;
  const message = messages[0];
  const body = message.body;
  const type = body?.message_type;
  try {
    switch (type) {
      case 'stationhead-ingest-fact': {
        const stages = await loadIngestFactStages();
        const result = await stages.processIngestFactTask(env, body);
        logIngestResult(result, 'ingest_fact_completed');
        break;
      }
      case 'stationhead-ingest-fact-deliver': {
        const stages = await loadIngestFactStages();
        const result = await stages.processIngestFactDeliveryTask(env, body);
        logIngestResult(result, 'ingest_fact_delivery_completed');
        break;
      }
      case 'stationhead-ingest-finalize': {
        const stage = await loadIngestFinalize();
        const result = await stage.processIngestFinalizeTask(env, body);
        logIngestResult(result, 'ingest_finalize_completed');
        break;
      }
      case 'stationhead-raw-analysis': {
        const stages = await loadRawStages();
        await stages.processRawAnalysisStage(env, body);
        break;
      }
      case 'stationhead-raw-structural-analysis': {
        const stages = await loadRawStages();
        await stages.processRawStructuralStage(env, body);
        break;
      }
      case 'stationhead-raw-likes-analysis': {
        const stages = await loadRawStages();
        await stages.processRawLikesStage(env, body);
        break;
      }
      case 'stationhead-raw-materialize': {
        const stages = await loadRawStages();
        await stages.processRawMaterializeStage(env, body);
        break;
      }
      default:
        await ingestRawCollection(env, body, EMPTY_DEPENDENCIES);
        break;
    }
    message.ack();
  } catch (error) {
    let event = 'raw_collection_ingest_failed';
    if (type === 'stationhead-ingest-fact' || type === 'stationhead-ingest-fact-deliver') {
      event = 'ingest_fact_failed';
    } else if (type === 'stationhead-ingest-finalize') {
      event = 'ingest_finalize_failed';
    } else if (type === 'stationhead-raw-analysis'
        || type === 'stationhead-raw-structural-analysis'
        || type === 'stationhead-raw-likes-analysis') {
      event = 'raw_collection_analysis_failed';
    } else if (type === 'stationhead-raw-materialize') {
      event = 'raw_collection_materialization_failed';
    }
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

export default {
  queue: processIngestBatch,
};
