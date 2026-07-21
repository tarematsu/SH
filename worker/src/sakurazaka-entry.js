import './fetch-guard.js';
import {
  OFFICIAL_NEWS_STAGE_MESSAGE,
  officialNewsStageTask,
  processOfficialNewsStage,
} from './other-official-news-stages.js';
import { officialNewsProbeDue, scheduledTimestamp } from './other-monitor-support.js';
import { ensureSakurazakaSession } from './sakurazaka-auth.js';
import { runSakurazakaMonitor } from './sakurazaka-monitor.js';

export const SAKURAZAKA_CRON = '*/5 * * * *';
export const SAKURAZAKA_CYCLE_MESSAGE = 'sakurazaka-cycle';
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
const RETRY_60_SECONDS = Object.freeze({ delaySeconds: 60 });

function cycleBody(scheduledAt) {
  return {
    message_type: SAKURAZAKA_CYCLE_MESSAGE,
    message_version: 1,
    scheduled_at: scheduledAt,
  };
}

function officialListDue(now) {
  return new Date(now).getUTCMinutes() === 20;
}

async function send(queue, body) {
  if (!queue?.send) throw new Error('SAKURAZAKA_QUEUE binding is missing');
  await queue.send(body, JSON_QUEUE_SEND_OPTIONS);
}

export async function runSakurazakaScheduled(controller, env) {
  const cron = String(controller?.cron || '');
  if (cron !== SAKURAZAKA_CRON) return { skipped: true, reason: 'unsupported-cron', cron };
  const scheduledAt = scheduledTimestamp(controller);
  await send(env?.SAKURAZAKA_QUEUE, cycleBody(scheduledAt));
  return { dispatched: true, scheduled_at: scheduledAt };
}

async function runCycle(env, scheduledAt) {
  await ensureSakurazakaSession(env);
  const due = await officialNewsProbeDue(env, scheduledAt);
  if (officialListDue(scheduledAt) || due) {
    const result = await processOfficialNewsStage(env, { stage: 'probe', scheduledAt });
    return { task: 'official-news', ...result };
  }
  const result = await runSakurazakaMonitor(env, scheduledAt);
  return { task: 'solo-monitor', ...result };
}

async function processMessage(message, env) {
  const body = message?.body || {};
  if (Number(body.message_version) !== 1) throw new Error('unsupported Sakurazaka task version');
  if (body.message_type === SAKURAZAKA_CYCLE_MESSAGE) {
    const scheduledAt = Number(body.scheduled_at);
    if (!Number.isFinite(scheduledAt)) throw new Error('Sakurazaka cycle timestamp is invalid');
    return runCycle(env, scheduledAt);
  }
  if (body.message_type === OFFICIAL_NEWS_STAGE_MESSAGE) {
    await ensureSakurazakaSession(env);
    const task = officialNewsStageTask(body);
    return { task: 'official-news', ...(await processOfficialNewsStage(env, task)) };
  }
  throw new Error(`unsupported Sakurazaka task: ${String(body.message_type || 'unknown')}`);
}

export async function runSakurazakaQueue(batch, env) {
  const messages = batch?.messages || [];
  for (const message of messages) {
    try {
      const result = await processMessage(message, env);
      console.log(JSON.stringify({
        event: 'sakurazaka_task_completed',
        message_type: message?.body?.message_type || null,
        ...result,
      }));
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({
        event: 'sakurazaka_task_failed',
        message_type: message?.body?.message_type || null,
        error: String(error?.message || error).slice(0, 800),
      }));
      message.retry(RETRY_60_SECONDS);
    }
  }
}

async function health(env) {
  const [monitor, news] = await Promise.all([
    env.OTHER_DB.prepare(`SELECT phase,last_success_at,last_error,updated_at
      FROM sh_cloud_host_monitor_state WHERE id=? LIMIT 1`)
      .bind(`solo:${env.SOLO_BROADCAST_HANDLE || 'sakurazaka46jp'}`).first(),
    env.OTHER_DB.prepare(`SELECT last_check_at,last_success_at,last_error,updated_at
      FROM sh_official_news_monitor_state WHERE id='official-news' LIMIT 1`).first(),
  ]).catch(() => [null, null]);
  return Response.json({
    ok: true,
    worker: 'sh-sakurazaka46jp',
    monitor: monitor || null,
    official_news: news || null,
  }, { headers: { 'cache-control': 'no-store' } });
}

export default {
  scheduled: runSakurazakaScheduled,
  queue: runSakurazakaQueue,
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return health(env);
    }
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
