function taskKind(body) {
  if (body?.message_type !== 'stationhead-track-metadata'
      || Number(body?.message_version) !== 1) {
    throw new Error('unsupported track metadata task');
  }
  return String(body.task || '');
}

export async function processTrackMetadataTask(env, body, dependencies = {}) {
  const kind = taskKind(body);
  if (kind === 'committed-enrichment') {
    const job = body.job;
    if (!job?.jobId || !job?.payload) throw new Error('committed metadata job is invalid');
    const runner = dependencies.runCommittedMetadataEnrichment
      || (await import('./committed-metadata-enrichment.js')).runCommittedMetadataEnrichment;
    await runner(env, [job], dependencies.enrichment || {});
    return { task: kind, job_id: job.jobId };
  }

  if (kind === 'read-model-hydration') {
    if (!body.read_model || !body.job_id) throw new Error('read-model hydration task is invalid');
    const save = dependencies.saveMinuteFactReadModels
      || (await import('./minute-facts-read-model.js')).saveMinuteFactReadModels;
    await save(env, body.read_model, body.job_id);
    return { task: kind, job_id: body.job_id };
  }

  throw new Error(`unsupported track metadata task: ${kind || 'missing'}`);
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages || []) {
      try {
        const result = await processTrackMetadataTask(env, message.body);
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
  },
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
