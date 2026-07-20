export const ACTIVE_WORKER_BUILDS = Object.freeze({
  'sh-buddies-ingest': 'wrangler.ingest.jsonc',
  'sh-minute-enrichment': 'wrangler.minute-enrichment.jsonc',
  'sh-runtime-orchestrator': 'wrangler.runtime.jsonc',
});

export function cloudflareBuildConfig(workerName) {
  return ACTIVE_WORKER_BUILDS[String(workerName || '').trim()] || null;
}
