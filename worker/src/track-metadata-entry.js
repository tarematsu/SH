const EMPTY_DEPENDENCIES = Object.freeze({});
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
let committedEnrichmentModulePromise;
let readModelStagesModulePromise;

function loadCommittedEnrichmentModule() {
  committedEnrichmentModulePromise ||= import('./committed-metadata-enrichment.js');
  return committedEnrichmentModulePromise;
}

function loadReadModelStagesModule() {
  readModelStagesModulePromise ||= import('./read-model-stages.js');
  return readModelStagesModulePromise;
}

function taskKind(body) {
  if (body?.message_type !== 'stationhead-track-metadata'
      || Number(body?.message_version) !== 1) {
    throw new Error('unsupported track metadata task');
  }
  return String(body.task || '');
}

async function enqueueReadModelStage(env, body, readModel, task, dependencies) {
  if (dependencies.enqueueReadModelStage) {
    await dependencies.enqueueReadModelStage(task, readModel, body);
    return;
  }
  if (task === 'read-model-write' && dependencies.enqueueReadModelWrite) {
    await dependencies.enqueueReadModelWrite(readModel, body);
    return;
  }
  if (!env?.TRACK_METADATA_QUEUE?.send) throw new Error('TRACK_METADATA_QUEUE binding is missing');
  await env.TRACK_METADATA_QUEUE.send({
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task,
    job_id: body.job_id,
    observed_at: body.observed_at ?? null,
    read_model: readModel,
  }, JSON_QUEUE_SEND_OPTIONS);
}

export async function processTrackMetadataTask(env, body, dependencies = EMPTY_DEPENDENCIES) {
  const kind = taskKind(body);
  if (kind === 'committed-enrichment') {
    const job = body.job;
    if (!job?.jobId || !job?.payload) throw new Error('committed metadata job is invalid');
    const runner = dependencies.runCommittedMetadataEnrichment
      || (await loadCommittedEnrichmentModule()).runCommittedMetadataEnrichment;
    await runner(env, [job], dependencies.enrichment || EMPTY_DEPENDENCIES);
    return { task: kind, job_id: job.jobId };
  }

  if (kind === 'read-model-hydration') {
    if (!body.read_model || !body.job_id) throw new Error('read-model hydration task is invalid');
    if (dependencies.saveMinuteFactReadModels) {
      await dependencies.saveMinuteFactReadModels(env, body.read_model, body.job_id);
      return { task: kind, job_id: body.job_id };
    }
    if (dependencies.prepareReadModelForWrite) {
      const readModel = await dependencies.prepareReadModelForWrite(env, body.read_model);
      await enqueueReadModelStage(env, body, readModel, 'read-model-write', dependencies);
      return { task: kind, job_id: body.job_id, pending: true, next_task: 'read-model-write' };
    }
    const hydrate = dependencies.hydrateReadModelMetadata
      || (await loadReadModelStagesModule()).hydrateReadModelMetadata;
    const readModel = await hydrate(env, body.read_model);
    await enqueueReadModelStage(env, body, readModel, 'read-model-preserve', dependencies);
    return { task: kind, job_id: body.job_id, pending: true, next_task: 'read-model-preserve' };
  }

  if (kind === 'read-model-preserve') {
    if (!body.read_model || !body.job_id) throw new Error('read-model preserve task is invalid');
    const preserve = dependencies.preserveReadModelForWrite
      || (await loadReadModelStagesModule()).preserveReadModelForWrite;
    const readModel = await preserve(env, body.read_model);
    await enqueueReadModelStage(env, body, readModel, 'read-model-write', dependencies);
    return { task: kind, job_id: body.job_id, pending: true, next_task: 'read-model-write' };
  }

  if (kind === 'read-model-write') {
    if (!body.read_model || !body.job_id) throw new Error('read-model write task is invalid');
    const write = dependencies.writePreparedReadModel
      || (await loadReadModelStagesModule()).writePreparedReadModel;
    await write(env, body.read_model);
    return { task: kind, job_id: body.job_id, pending: false };
  }

  throw new Error(`unsupported track metadata task: ${kind || 'missing'}`);
}

async function processTrackMetadataBatch(batch, env) {
  const messages = batch.messages;
  if (!messages?.length) return;
  const message = messages[0];
  try {
    const result = await processTrackMetadataTask(env, message.body, EMPTY_DEPENDENCIES);
    console.log(JSON.stringify({ event: 'track_metadata_task_completed', ...result }));
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'track_metadata_task_failed',
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry();
  }
}

export default {
  queue: processTrackMetadataBatch,
};
