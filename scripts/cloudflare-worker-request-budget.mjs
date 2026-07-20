import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const FREE_DAILY_REQUESTS = 100_000;
export const TARGET_DAILY_REQUESTS = 80_000;
export const TARGET_RATIO = TARGET_DAILY_REQUESTS / FREE_DAILY_REQUESTS;
export const CONTINUATION_RESERVE_PER_DAY = 5_000;

// These are the only production Worker configs selected by
// worker/scripts/select-worker-deploys.mjs.
export const ACTIVE_CONFIGS = Object.freeze([
  'worker/wrangler.minute-enrichment.jsonc',
  'worker/wrangler.ingest.jsonc',
  'worker/wrangler.runtime.jsonc',
]);

// A queue message normally becomes one consumer invocation with the current
// one-message CPU boundaries. Continuation-heavy queues include every normal
// stage rather than pretending one source poll equals one request:
// - persistence: persist + likes + up to four likes-write chunks + finalize
// - live derive: trigger/write + compact revision close
// - enrichment: identity/playback continuation allowance
export const QUEUE_MESSAGES_PER_DAY = Object.freeze({
  'stationhead-comments': 288,
  'stationhead-raw-collection': 1_440,
  'stationhead-ingest-finalize': 1_440,
  'stationhead-buddies-persist': 10_080,
  'stationhead-buddy-playback': 72,
  'stationhead-host-monitor': 696,
  'stationhead-minute-derive': 1_440,
  'stationhead-minute-live-derive': 4_320,
  'stationhead-minute-enrichment': 4_320,
  'stationhead-track-metadata': 1_440,
  'stationhead-buddies-facts': 1_440,
  'stationhead-minute-rebuild': 144,
  'stationhead-pages-read-model-publication': 1_440,
  'stationhead-read-model': 1_440,
});

function numeric(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

export function cronInvocationsPerDay(expression) {
  const minute = String(expression || '').trim().split(/\s+/)[0] || '';
  if (minute === '*') return 1_440;
  const every = minute.match(/^\*\/(\d+)$/);
  if (every) return Math.floor(1_440 / Math.max(1, Number(every[1])));
  const values = minute.split(',').filter((value) => /^\d+$/.test(value));
  return values.length * 24;
}

function configValue(source, key) {
  const match = source.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
  return match?.[1] || null;
}

export function cronExpressions(source) {
  const result = [];
  for (const match of source.matchAll(/"crons"\s*:\s*\[([^\]]*)\]/g)) {
    for (const value of match[1].matchAll(/"([^"]+)"/g)) result.push(value[1]);
  }
  return result;
}

export function calculateDailyRequestBudget({
  configs,
  queueMessages = QUEUE_MESSAGES_PER_DAY,
  pagesRequests = 25_000,
  continuationReserve = CONTINUATION_RESERVE_PER_DAY,
}) {
  const workers = [];
  const names = new Set();
  let scheduled = 0;
  for (const config of configs) {
    const name = config.name || configValue(config.source, 'name');
    if (!name || names.has(name)) continue;
    names.add(name);
    const cron = cronExpressions(config.source);
    const count = cron.reduce((sum, expression) => sum + cronInvocationsPerDay(expression), 0);
    scheduled += count;
    workers.push({ name, config: config.path, scheduled_requests: count, cron });
  }
  const queue = Object.entries(queueMessages).map(([name, count]) => ({
    queue: name,
    expected_messages: numeric(count),
  }));
  const queueRequests = queue.reduce((sum, item) => sum + item.expected_messages, 0);
  const reserve = numeric(continuationReserve);
  const total = scheduled + queueRequests + numeric(pagesRequests) + reserve;
  return {
    ok: total < TARGET_DAILY_REQUESTS,
    free_daily_requests: FREE_DAILY_REQUESTS,
    target_ratio: TARGET_RATIO,
    target_daily_requests: TARGET_DAILY_REQUESTS,
    pages_function_reserve: numeric(pagesRequests),
    continuation_and_burst_reserve: reserve,
    scheduled_requests: scheduled,
    queue_consumer_requests: queueRequests,
    estimated_daily_requests: total,
    headroom: TARGET_DAILY_REQUESTS - total,
    workers,
    queue,
  };
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const configs = [];
  for (const relative of ACTIVE_CONFIGS) {
    const configPath = path.resolve(repositoryRoot, relative);
    configs.push({ path: relative, source: await readFile(configPath, 'utf8') });
  }
  const report = calculateDailyRequestBudget({
    configs,
    pagesRequests: process.env.PAGES_FUNCTION_REQUEST_RESERVE_PER_DAY || 25_000,
    continuationReserve: process.env.WORKER_CONTINUATION_RESERVE_PER_DAY
      || CONTINUATION_RESERVE_PER_DAY,
  });
  const outputDir = path.resolve(process.env.WORKER_REQUEST_BUDGET_OUTPUT_DIR || 'worker-request-budget');
  await writeFile(path.join(outputDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`).catch(async (error) => {
    if (error.code !== 'ENOENT') throw error;
    const { mkdir } = await import('node:fs/promises');
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
  });
  const lines = [
    '# Worker daily request budget',
    '',
    `Estimated requests: ${report.estimated_daily_requests}`,
    `Target: <${report.target_daily_requests}/day`,
    `Continuation and burst reserve: ${report.continuation_and_burst_reserve}`,
    `Headroom: ${report.headroom}`,
    '',
    `Budget result: ${report.ok ? 'PASS' : 'FAIL'}`,
  ];
  await writeFile(path.join(outputDir, 'summary.md'), `${lines.join('\n')}\n`);
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
