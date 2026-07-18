export const OFFICIAL_NEWS_STAGE_MESSAGE = 'other-official-news-stage';
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
let probeModulePromise;
let reconcileModulePromise;
let utilsModulePromise;

function loadProbeModule() {
  probeModulePromise ||= import('./official-news-probe.js');
  return probeModulePromise;
}

function loadReconcileModule() {
  reconcileModulePromise ||= import('./official-news-reconcile.js');
  return reconcileModulePromise;
}

function loadUtilsModule() {
  utilsModulePromise ||= import('./official-news-utils.js');
  return utilsModulePromise;
}

async function sendReconcile(env, scheduledAt, dependencies) {
  const body = {
    message_type: OFFICIAL_NEWS_STAGE_MESSAGE,
    message_version: 1,
    stage: 'reconcile',
    scheduled_at: scheduledAt,
  };
  if (dependencies.send) return dependencies.send(body);
  if (!env?.HOST_MONITOR_QUEUE?.send) throw new Error('HOST_MONITOR_QUEUE binding is missing');
  return env.HOST_MONITOR_QUEUE.send(body, JSON_QUEUE_SEND_OPTIONS);
}

async function runProbe(env, scheduledAt, dependencies) {
  const probe = dependencies.probe || (await loadProbeModule()).runOfficialNewsMonitor;
  const config = dependencies.config || (await loadUtilsModule()).officialNewsConfig;
  const result = await probe(env, config(env), scheduledAt);
  await sendReconcile(env, scheduledAt, dependencies);
  return {
    stage: 'probe',
    pending: true,
    skipped: result?.skipped === true,
    reason: result?.reason ?? null,
  };
}

async function runReconcile(env, scheduledAt, dependencies) {
  const reconcile = dependencies.reconcile
    || (await loadReconcileModule()).reconcileOfficialAnnouncements;
  const result = await reconcile(env, scheduledAt);
  return {
    stage: 'reconcile',
    pending: false,
    skipped: result?.skipped === true,
    reason: result?.reason ?? null,
  };
}

export function officialNewsStageTask(body) {
  if (body?.message_type !== OFFICIAL_NEWS_STAGE_MESSAGE
      || Number(body?.message_version) !== 1) {
    throw new Error('unsupported official news stage task');
  }
  const scheduledAt = Number(body.scheduled_at);
  if (!Number.isFinite(scheduledAt)) throw new Error('official news stage timestamp is invalid');
  return {
    stage: body.stage === 'reconcile' ? 'reconcile' : 'probe',
    scheduledAt,
  };
}

export async function processOfficialNewsStage(env, task, dependencies = {}) {
  if (task.stage === 'reconcile') return runReconcile(env, task.scheduledAt, dependencies);
  return runProbe(env, task.scheduledAt, dependencies);
}
