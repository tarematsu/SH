export const OFFICIAL_NEWS_STAGE_MESSAGE = 'other-official-news-stage';
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
let splitModulePromise;
let reconcileModulePromise;
let utilsModulePromise;

function loadSplitModule() {
  splitModulePromise ||= import('./official-news-split-stages.js');
  return splitModulePromise;
}

function loadReconcileModule() {
  reconcileModulePromise ||= import('./official-news-reconcile.js');
  return reconcileModulePromise;
}

function loadUtilsModule() {
  utilsModulePromise ||= import('./official-news-utils.js');
  return utilsModulePromise;
}

async function sendStage(env, stage, scheduledAt, dependencies) {
  const body = {
    message_type: OFFICIAL_NEWS_STAGE_MESSAGE,
    message_version: 1,
    stage,
    scheduled_at: scheduledAt,
  };
  if (dependencies.send) return dependencies.send(body);
  if (!env?.HOST_MONITOR_QUEUE?.send) throw new Error('HOST_MONITOR_QUEUE binding is missing');
  return env.HOST_MONITOR_QUEUE.send(body, JSON_QUEUE_SEND_OPTIONS);
}

async function stageConfig(env, dependencies) {
  const config = dependencies.config || (await loadUtilsModule()).officialNewsConfig;
  return config(env);
}

async function runCheck(env, scheduledAt, dependencies) {
  const check = dependencies.check || (await loadSplitModule()).runOfficialNewsCheckOnly;
  const result = await check(env, await stageConfig(env, dependencies), scheduledAt);
  const nextStage = result?.reason === 'check-failed' ? 'reconcile' : 'probe';
  await sendStage(env, nextStage, scheduledAt, dependencies);
  return {
    stage: 'check',
    pending: true,
    next_stage: nextStage,
    skipped: result?.skipped === true,
    reason: result?.reason ?? null,
  };
}

async function runProbe(env, scheduledAt, dependencies) {
  const probe = dependencies.probe || (await loadSplitModule()).runOfficialNewsProbeOnly;
  const result = await probe(env, await stageConfig(env, dependencies), scheduledAt);
  await sendStage(env, 'reconcile', scheduledAt, dependencies);
  return {
    stage: 'probe',
    pending: true,
    next_stage: 'reconcile',
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
  let stage = 'check';
  if (body.stage === 'probe') stage = 'probe';
  else if (body.stage === 'reconcile') stage = 'reconcile';
  return { stage, scheduledAt };
}

export async function processOfficialNewsStage(env, task, dependencies = {}) {
  if (task.stage === 'reconcile') return runReconcile(env, task.scheduledAt, dependencies);
  if (task.stage === 'probe') return runProbe(env, task.scheduledAt, dependencies);
  return runCheck(env, task.scheduledAt, dependencies);
}
