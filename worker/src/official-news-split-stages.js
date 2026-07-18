import {
  checkOfficialNews,
  monitorState,
  saveMonitorState,
} from './official-news-announcements.js';
import { probeAnnouncements } from './official-news-probe.js';
import { finite } from './official-news-utils.js';

async function recordStageFailure(env, now, error, dependencies) {
  const readState = dependencies.monitorState || monitorState;
  const writeState = dependencies.saveMonitorState || saveMonitorState;
  const message = String(error?.message || error).slice(0, 1000);
  const state = await readState(env).catch(() => null);
  await writeState(env, {
    lastCheckAt: finite(state?.last_check_at) ?? now,
    lastSuccessAt: finite(state?.last_success_at),
    lastError: message,
  }).catch(() => {});
  console.error(JSON.stringify({
    event: 'official_news_stage_failed',
    stage: dependencies.stage,
    error: message,
  }));
  return { skipped: true, reason: `${dependencies.stage}-failed` };
}

export async function runOfficialNewsCheckOnly(env, cfg, now, dependencies = {}) {
  const check = dependencies.checkOfficialNews || checkOfficialNews;
  try {
    await check(env, cfg, now);
    return { skipped: false, reason: null };
  } catch (error) {
    return recordStageFailure(env, now, error, { ...dependencies, stage: 'check' });
  }
}

export async function runOfficialNewsProbeOnly(env, cfg, now, dependencies = {}) {
  const probe = dependencies.probeAnnouncements || probeAnnouncements;
  try {
    await probe(env, cfg, now);
    return { skipped: false, reason: null };
  } catch (error) {
    return recordStageFailure(env, now, error, { ...dependencies, stage: 'probe' });
  }
}
