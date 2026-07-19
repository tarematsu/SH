let configModulePromise;
let ingestModulePromise;
let spotifyModulePromise;
let isrcModulePromise;

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

function loadConfigModule() {
  configModulePromise ||= import('./collector-config.js');
  return configModulePromise;
}

function loadIngestModule() {
  ingestModulePromise ||= import('./collector-ingest.js');
  return ingestModulePromise;
}

function loadSpotifyModule() {
  spotifyModulePromise ||= import('./track-metadata.js');
  return spotifyModulePromise;
}

function loadIsrcModule() {
  isrcModulePromise ||= import('./isrc-metadata.js');
  return isrcModulePromise;
}

async function enrichmentConfig(sourceEnv, dependencies) {
  if (dependencies.config) return dependencies.config;
  return (await loadConfigModule()).configFromEnv(sourceEnv);
}

function validEnvironment(env, sourceEnv, jobs) {
  if (env?.MINUTE_DB && sourceEnv?.DB) return true;
  console.warn(JSON.stringify({
    event: 'minute_track_metadata_enrichment_skipped',
    reason: 'minute-db-binding-missing',
    jobs: jobs.length,
  }));
  return false;
}

export async function runCommittedSpotifyMetadataEnrichment(env, jobs, dependencies = {}) {
  const sourceEnv = sourceDatabaseEnv(env);
  if (!validEnvironment(env, sourceEnv, jobs)) return;
  const config = await enrichmentConfig(sourceEnv, dependencies);
  const ingest = dependencies.ingest || (await loadIngestModule()).ingest;
  const enrichTracks = dependencies.enrichSpotifyTracks
    || dependencies.enrichTracks
    || (await loadSpotifyModule()).enrichTracks;

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
        stage: 'spotify',
        job_id: job.jobId,
        saved: Number(saved || 0),
      }));
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'minute_track_metadata_enrichment_failed',
        stage: 'spotify',
        job_id: job.jobId,
        error: failureDetail(error),
      }));
    }
  }
}

export async function runCommittedIsrcMetadataEnrichment(env, jobs, dependencies = {}) {
  const sourceEnv = sourceDatabaseEnv(env);
  if (!validEnvironment(env, sourceEnv, jobs)) return;
  const config = await enrichmentConfig(sourceEnv, dependencies);
  const enrichIsrcTracks = dependencies.enrichIsrcTracks
    || (await loadIsrcModule()).enrichIsrcTracks;

  for (const job of jobs) {
    try {
      const result = await enrichIsrcTracks(sourceEnv, job.payload.queue, config);
      console.log(JSON.stringify({
        event: 'isrc_track_metadata_enriched',
        stage: 'isrc',
        job_id: job.jobId,
        attempted: Number(result?.attempted || 0),
        saved: Number(result?.saved || 0),
      }));
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'minute_track_metadata_enrichment_failed',
        stage: 'isrc',
        job_id: job.jobId,
        error: failureDetail(error),
      }));
    }
  }
}

export async function runCommittedMetadataEnrichment(env, jobs, dependencies = {}) {
  await runCommittedSpotifyMetadataEnrichment(env, jobs, dependencies);
  await runCommittedIsrcMetadataEnrichment(env, jobs, dependencies);
}
