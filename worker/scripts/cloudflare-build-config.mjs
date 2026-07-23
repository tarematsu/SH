export const ACTIVE_WORKER_BUILDS = Object.freeze({
  'sh-buddies-collector': 'wrangler.buddies-collector.jsonc',
  'sh-runtime-orchestrator': 'wrangler.runtime.jsonc',
});

export function cloudflareBuildConfig(workerName) {
  return ACTIVE_WORKER_BUILDS[String(workerName || '').trim()] || null;
}
