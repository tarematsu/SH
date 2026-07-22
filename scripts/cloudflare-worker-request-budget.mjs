import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const FREE_DAILY_REQUESTS = 100_000;
export const TARGET_DAILY_REQUESTS = 80_000;
export const TARGET_RATIO = TARGET_DAILY_REQUESTS / FREE_DAILY_REQUESTS;
export const CONTINUATION_RESERVE_PER_DAY = 5_000;

// Historical minute-fact reconstruction is intentionally outside the temporary
// request budget while the thirty-day backlog is being restored. Live minute
// derivation remains counted through stationhead-minute-live-derive.
export const REQUEST_BUDGET_EXCLUDED_QUEUES = Object.freeze([
  'stationhead-minute-derive',
  'stationhead-minute-rebuild',
]);

// These are the only production Worker configs selected by
// worker/scripts/select-worker-deploys.mjs.
export const ACTIVE_CONFIGS = Object.freeze([
  'worker/wrangler.sakurazaka46jp.jsonc',
  'worker/wrangler.runtime.jsonc',
]);

// A queue message normally becomes one consumer invocation with the current
// one-message CPU boundaries. Reconstruction-only queues above are deliberately
// excluded until the historical backlog is complete.
export const QUEUE_MESSAGES_PER_DAY = Object.freeze({
  'stationhead-comments': 288,
  'stationhead-raw-collection': 1_440,
  'stationhead-ingest-finalize': 1_440,
  'stationhead-buddies-persist': 10_080,
  'stationhead-host-monitor': 2_256,
  'stationhead-sakurazaka46jp': 720,
  'stationhead-minute-live-derive': 5_760,
  'stationhead-minute-enrichment': 7_200,
  'stationhead-track-metadata': 1_440,
  'stationhead-buddies-facts': 1_440,
  'stationhead-pages-read-model-publication': 2_880,
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
  const marker = `"${key}"`;
  const keyOffset = source.indexOf(marker);
  if (keyOffset < 0) return null;
  const valueSource = source.slice(keyOffset + marker.length);
  const colonOffset = valueSource.indexOf(':');
  if (colonOffset < 0) return null;
  const startQuote = valueSource.indexOf('"', colonOffset + 1);
  if (startQuote < 0) return null;
  const endQuote = valueSource.indexOf('"', startQuote + 1);
  return endQuote < 0 ? null : valueSource.slice(startQuote + 1, endQuote);
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
    request_budget_excluded_queues: [...REQUEST_BUDGET_EXCLUDED_QUEUES],
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
    `Excluded reconstruction queues: ${report.request_budget_excluded_queues.join(', ')}`,
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
