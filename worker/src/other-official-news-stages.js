export const OFFICIAL_NEWS_STAGE_MESSAGE = 'other-official-news-stage';
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
let checkModulePromise;
let splitModulePromise;
let reconcileModulePromise;
let utilsModulePromise;

function loadCheckModule() {
  checkModulePromise ||= import('./official-news-check-stages.js');
  return checkModulePromise;
}

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

async function sendStage(env, stage, scheduledAt, dependencies, extra = null) {
  const body = {
    message_type: OFFICIAL_NEWS_STAGE_MESSAGE,
    message_version: 1,
    stage,
    scheduled_at: scheduledAt,
    ...(extra || {}),
  };
  if (dependencies.send) return dependencies.send(body);
  if (!env?.HOST_MONITOR_QUEUE?.send) throw new Error('HOST_MONITOR_QUEUE binding is missing');
  return env.HOST_MONITOR_QUEUE.send(body, JSON_QUEUE_SEND_OPTIONS);
}

async function stageConfig(env, dependencies) {
  const config = dependencies.config || (await loadUtilsModule()).officialNewsConfig;
  return config(env);
}

async function runList(env, task, dependencies) {
  const list = dependencies.list || (await loadCheckModule()).runOfficialNewsListStage;
  const result = await list(env, await stageConfig(env, dependencies), task.scheduledAt);
  let nextStage;
  let extra = null;
  if (result?.failed) {
    nextStage = 'station-probe';
  } else if (result?.candidates?.length) {
    nextStage = 'news-detail';
    extra = { candidates: result.candidates, candidate_index: 0 };
  } else {
    nextStage = 'news-complete';
  }
  await sendStage(env, nextStage, task.scheduledAt, dependencies, extra);
  return {
    stage: 'probe',
    pending: true,
    next_stage: nextStage,
    candidates: result?.candidates?.length || 0,
    skipped: result?.skipped === true,
    reason: result?.reason ?? null,
  };
}

async function runDetail(env, task, dependencies) {
  const detail = dependencies.detail || (await loadCheckModule()).runOfficialNewsDetailStage;
  const candidate = task.candidates[task.candidateIndex];
  if (!candidate) throw new Error('official news detail candidate is missing');
  const result = await detail(
    env,
    await stageConfig(env, dependencies),
    task.scheduledAt,
    candidate,
  );
  let nextStage;
  let extra = null;
  if (result?.failed) {
    nextStage = 'station-probe';
  } else if (task.candidateIndex + 1 < task.candidates.length) {
    nextStage = 'news-detail';
    extra = { candidates: task.candidates, candidate_index: task.candidateIndex + 1 };
  } else {
    nextStage = 'news-complete';
  }
  await sendStage(env, nextStage, task.scheduledAt, dependencies, extra);
  return {
    stage: 'news-detail',
    pending: true,
    next_stage: nextStage,
    candidate_index: task.candidateIndex,
    candidates: task.candidates.length,
    skipped: result?.skipped === true,
    reason: result?.reason ?? null,
    saved: Number(result?.saved || 0),
  };
}

async function runComplete(env, task, dependencies) {
  const complete = dependencies.complete || (await loadCheckModule()).completeOfficialNewsCheck;
  const result = await complete(env, task.scheduledAt);
  await sendStage(env, 'station-probe', task.scheduledAt, dependencies);
  return {
    stage: 'news-complete',
    pending: true,
    next_stage: 'station-probe',
    skipped: result?.skipped === true,
    reason: result?.reason ?? null,
  };
}

async function runStationProbe(env, task, dependencies) {
  const probe = dependencies.probe || (await loadSplitModule()).runOfficialNewsProbeOnly;
  const result = await probe(env, await stageConfig(env, dependencies), task.scheduledAt);
  await sendStage(env, 'reconcile', task.scheduledAt, dependencies);
  return {
    stage: 'station-probe',
    pending: true,
    next_stage: 'reconcile',
    skipped: result?.skipped === true,
    reason: result?.reason ?? null,
  };
}

async function runReconcile(env, task, dependencies) {
  const reconcile = dependencies.reconcile
    || (await loadReconcileModule()).reconcileOfficialAnnouncements;
  const result = await reconcile(env, task.scheduledAt);
  return {
    stage: 'reconcile',
    pending: false,
    skipped: result?.skipped === true,
    reason: result?.reason ?? null,
  };
}

function compactCandidate(candidate) {
  return {
    newsId: String(candidate?.newsId || '').slice(0, 100),
    href: String(candidate?.href || '').slice(0, 1000),
    listTitle: String(candidate?.listTitle || '').slice(0, 500),
  };
}

export function officialNewsStageTask(body) {
  if (body?.message_type !== OFFICIAL_NEWS_STAGE_MESSAGE
      || Number(body?.message_version) !== 1) {
    throw new Error('unsupported official news stage task');
  }
  const scheduledAt = Number(body.scheduled_at);
  if (!Number.isFinite(scheduledAt)) throw new Error('official news stage timestamp is invalid');
  let stage = 'probe';
  if (body.stage === 'news-detail') stage = 'news-detail';
  else if (body.stage === 'news-complete') stage = 'news-complete';
  else if (body.stage === 'station-probe') stage = 'station-probe';
  else if (body.stage === 'reconcile') stage = 'reconcile';
  const candidates = Array.isArray(body.candidates)
    ? body.candidates.slice(0, 40).map(compactCandidate).filter((item) => item.newsId && item.href)
    : [];
  const candidateIndex = Math.max(0, Math.trunc(Number(body.candidate_index) || 0));
  return { stage, scheduledAt, candidates, candidateIndex };
}

export async function processOfficialNewsStage(env, task, dependencies = {}) {
  if (task.stage === 'reconcile') return runReconcile(env, task, dependencies);
  if (task.stage === 'station-probe') return runStationProbe(env, task, dependencies);
  if (task.stage === 'news-complete') return runComplete(env, task, dependencies);
  if (task.stage === 'news-detail') return runDetail(env, task, dependencies);
  return runList(env, task, dependencies);
}
