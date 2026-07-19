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

function normalizeIsrc(value) {
  const normalized = String(value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalized) ? normalized : null;
}

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
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

async function dictionaryRows(db, queue) {
  const isrcs = [...new Set((queue?.tracks || []).map((track) => normalizeIsrc(track?.isrc)).filter(Boolean))];
  if (!db?.prepare || !isrcs.length) return new Map();
  const placeholders = isrcs.map(() => '?').join(',');
  try {
    const result = await db.prepare(`SELECT isrc,title,artist,thumbnail_url
      FROM sh_track_dictionary WHERE isrc IN (${placeholders})`).bind(...isrcs).all();
    return new Map((result.results || []).map((row) => [normalizeIsrc(row?.isrc), row]));
  } catch (error) {
    if (/no such table|no such column/i.test(String(error?.message || ''))) return null;
    throw error;
  }
}

function filteredQueue(queue, rows, stage) {
  if (!queue?.tracks?.length || rows == null) return queue;
  const tracks = queue.tracks.filter((track) => {
    const isrc = normalizeIsrc(track?.isrc);
    const spotifyId = text(track?.spotify_id);
    const row = isrc ? rows.get(isrc) : null;
    const hasTitleArtist = Boolean(text(row?.title) && text(row?.artist));
    if (stage === 'isrc') return Boolean(isrc && !hasTitleArtist);
    if (!spotifyId) return false;
    if (!isrc) return true;
    return !hasTitleArtist || !text(row?.thumbnail_url);
  });
  return tracks.length === queue.tracks.length ? queue : { ...queue, tracks };
}

async function enrichmentQueue(sourceEnv, queue, stage) {
  const rows = await dictionaryRows(sourceEnv?.DB, queue);
  return filteredQueue(queue, rows, stage);
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
      const queue = await enrichmentQueue(sourceEnv, job.payload.queue, 'spotify');
      const candidates = Number(queue?.tracks?.length || 0);
      const saved = candidates > 0
        ? await enrichTracks(sourceEnv, ingest, queue, job.payload.observedAt, config)
        : 0;
      console.log(JSON.stringify({
        event: 'minute_track_metadata_enriched',
        stage: 'spotify',
        job_id: job.jobId,
        candidates,
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
      const queue = await enrichmentQueue(sourceEnv, job.payload.queue, 'isrc');
      const candidates = Number(queue?.tracks?.length || 0);
      const result = candidates > 0
        ? await enrichIsrcTracks(sourceEnv, queue, config)
        : { attempted: 0, saved: 0 };
      console.log(JSON.stringify({
        event: 'isrc_track_metadata_enriched',
        stage: 'isrc',
        job_id: job.jobId,
        candidates,
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
  // Resolve recording identity first. Spotify is now only the artwork/provider
  // fallback after the ISRC dictionary has had a chance to satisfy the request.
  await runCommittedIsrcMetadataEnrichment(env, jobs, dependencies);
  await runCommittedSpotifyMetadataEnrichment(env, jobs, dependencies);
}
