// All three workers (buddies/other/minute) share the same "* * * * *" cron and
// the same D1 database. Buddies is the latency-sensitive primary collector and
// is left unstaggered; other/minute delay their own D1-touching work by a few
// seconds each so the three workers don't all start hitting D1 in the same
// instant every minute.
const MAX_DELAY_MS = 45_000;
const DEFAULT_DELAYS_MS = {
  other: 10_000,
  minute: 20_000,
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
