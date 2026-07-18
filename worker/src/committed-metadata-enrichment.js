function sourceDatabaseEnv(env) {
  const source = env?.MINUTE_DB;
  if (!source) return env;
  const active = Object.create(env || null);
  Object.defineProperty(active, 'DB', { value: source, enumerable: false });
  return active;
}

function failureDetail(error) {
  return String(error?.message || error || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

export async function runCommittedMetadataEnrichment(env, jobs, dependencies = {}) {
  const sourceEnv = sourceDatabaseEnv(env);
  if (!env?.MINUTE_DB || !sourceEnv?.DB) {
    console.warn(JSON.stringify({
      event: 'minute_track_metadata_enrichment_skipped',
      reason: 'minute-db-binding-missing',
      jobs: jobs.length,
    }));
    return;
  }

  const [{ configFromEnv }, { ingest }, { enrichTracks }] = await Promise.all([
    dependencies.config ? Promise.resolve({ configFromEnv: () => dependencies.config }) : import('./collector-config.js'),
    dependencies.ingest ? Promise.resolve({ ingest: dependencies.ingest }) : import('./collector-ingest.js'),
    dependencies.enrichTracks ? Promise.resolve({ enrichTracks: dependencies.enrichTracks }) : import('./shared.js'),
  ]);
  const config = dependencies.config || configFromEnv(sourceEnv);

  for (const job of jobs) {
    try {
      const saved = await enrichTracks(
        sourceEnv,
        ingest,
        job.payload.queue,
        job.payload.observedAt,
        config,
      );
      console.log(JSON.stringify({
        event: 'minute_track_metadata_enriched',
        job_id: job.jobId,
        saved: Number(saved || 0),
      }));
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'minute_track_metadata_enrichment_failed',
        job_id: job.jobId,
        error: failureDetail(error),
      }));
    }
  }
}
