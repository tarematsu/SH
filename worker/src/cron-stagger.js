// All three workers (buddies/other/minute) share the same "* * * * *" cron.
// Buddies is the latency-sensitive primary collector that writes the shared DB
// and is left unstaggered; other/minute delay their own DB-touching work by a
// few seconds so the workers don't all start hitting the shared DB in the same
// instant every minute. The delay is spent blocking (setTimeout) inside the
// invocation, so it must stay well under the runtime limits -- callers should
// only pay it before work that actually touches the shared DB.
const MAX_DELAY_MS = 45_000;
const DEFAULT_DELAYS_MS = {
  other: 10_000,
  minute: 5_000,
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
