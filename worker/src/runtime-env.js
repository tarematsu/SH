export const MINUTE_PIPELINE_QUEUE_NAMES = Object.freeze([
  'stationhead-minute-derive',
  'stationhead-minute-live-derive',
  'stationhead-buddies-facts',
  'stationhead-minute-rebuild',
]);

const MINUTE_PIPELINE_QUEUE_SET = new Set(MINUTE_PIPELINE_QUEUE_NAMES);

function withDatabaseAlias(env, sourceBinding) {
  if (!env || env.DB || !env[sourceBinding]) return env;
  const active = Object.create(env);
  Object.defineProperty(active, 'DB', {
    value: env[sourceBinding],
    enumerable: false,
    configurable: true,
  });
  return active;
}

export function rawCollectorEnv(env) {
  return withDatabaseAlias(env, 'BUDDIES_DB');
}

export function minutePipelineEnv(env) {
  return withDatabaseAlias(env, 'BUDDIES_DB');
}

export function isMinutePipelineBatch(batch) {
  return MINUTE_PIPELINE_QUEUE_SET.has(String(batch?.queue || ''));
}
