// All three workers (buddies/other/minute) share the same "* * * * *" cron.
// Buddies is the latency-sensitive primary collector that writes the shared DB
// and is left unstaggered; other/minute delay their own DB-touching work by a
// few seconds so the workers don't all start hitting the shared DB in the same
// instant every minute. The delay is spent blocking (setTimeout) inside the
// invocation, so it must stay well under the runtime limits -- callers should
// only pay it before work that actually touches the shared DB.
const MAX_DELAY_MS = 45_000;
const DEFAULT_DELAYS_MS = {
  other: 25_000,
  minute: 12_000,
};

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function cronStaggerEnabled(env = {}) {
  const configured = env.CRON_STAGGER_ENABLED;
  if (configured == null || configured === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(configured).trim().toLowerCase());
}

export function cronStaggerDelayMs(env = {}, worker) {
  const configured = Number(env?.[`CRON_STAGGER_${String(worker).toUpperCase()}_MS`]);
  const delay = Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_DELAYS_MS[worker] ?? 0;
  return Math.min(MAX_DELAY_MS, delay);
}

export async function applyCronStagger(env, worker, sleepFn = defaultSleep) {
  if (!cronStaggerEnabled(env)) return 0;
  const delayMs = cronStaggerDelayMs(env, worker);
  if (delayMs > 0) await sleepFn(delayMs);
  return delayMs;
}

function collectorMinuteAt(scheduledAt) {
  const timestamp = Number(scheduledAt);
  const base = Number.isFinite(timestamp) ? timestamp : Date.now();
  return Math.floor(base / 60_000) * 60_000;
}

function priorityWaitMs(env = {}, options = {}) {
  const configured = Number(options.maxWaitMs ?? env.COLLECTOR_PRIORITY_WAIT_MS ?? 15_000);
  if (!Number.isFinite(configured) || configured < 0) return 15_000;
  return Math.min(20_000, Math.trunc(configured));
}

function priorityPollMs(env = {}, options = {}) {
  const configured = Number(options.pollMs ?? env.COLLECTOR_PRIORITY_POLL_MS ?? 1_000);
  if (!Number.isFinite(configured) || configured <= 0) return 1_000;
  return Math.min(5_000, Math.trunc(configured));
}

export async function waitForCollectorCompletion(env = {}, scheduledAt = Date.now(), options = {}) {
  const db = env?.BUDDIES_DB || (env?.MINUTE_DB ? null : env?.DB);
  if (!db?.prepare) return { ready: true, reason: 'buddies-db-binding-missing' };

  const targetMinute = collectorMinuteAt(scheduledAt);
  const deadline = Date.now() + priorityWaitMs(env, options);
  const pollMs = priorityPollMs(env, options);
  while (true) {
    try {
      const row = await db.prepare(`SELECT last_run_at,last_success_at,last_error
        FROM sh_worker_collector_state WHERE id='stationhead' LIMIT 1`).first();
      if (Number(row?.last_run_at || 0) >= targetMinute
          && Number(row?.last_success_at || 0) >= targetMinute
          && !row?.last_error) {
        return { ready: true, targetMinute };
      }
    } catch (error) {
      if (/no such table|no such column/i.test(String(error?.message || error))) {
        return { ready: true, reason: 'collector-state-unavailable' };
      }
      throw error;
    }
    if (Date.now() >= deadline) return { ready: false, reason: 'collector-not-ready', targetMinute };
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}
