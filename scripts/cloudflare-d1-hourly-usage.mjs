import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API_ROOT = 'https://api.cloudflare.com/client/v4';
const GRAPHQL_URL = `${API_ROOT}/graphql`;
const FREE_READ_ROWS_PER_DAY = 5_000_000;
const FREE_WRITE_ROWS_PER_DAY = 100_000;
const TARGET_RATIO = 0.5;
const DEFAULT_WINDOW_MINUTES = 60;
const token = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');

const outputDir = path.resolve(process.env.D1_USAGE_OUTPUT_DIR || 'd1-usage');
await mkdir(outputDir, { recursive: true });

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percentage(value, limit) {
  return limit > 0 ? (value / limit) * 100 : 0;
}

function configuredWindowMinutes() {
  const parsed = Number(process.env.D1_USAGE_WINDOW_MINUTES || DEFAULT_WINDOW_MINUTES);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WINDOW_MINUTES;
  return Math.max(1, Math.min(DEFAULT_WINDOW_MINUTES, parsed));
}

function configuredStart(end) {
  const raw = String(process.env.D1_USAGE_START || '').trim();
  if (!raw) return new Date(end.getTime() - configuredWindowMinutes() * 60_000);
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime()) || parsed >= end) {
    throw new Error(`D1_USAGE_START is invalid: ${raw}`);
  }
  const earliest = new Date(end.getTime() - DEFAULT_WINDOW_MINUTES * 60_000);
  return parsed < earliest ? earliest : parsed;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Cloudflare returned non-JSON (${response.status}): ${text.slice(0, 500)}`);
  }
  if (!response.ok || body?.success === false || body?.errors?.length) {
    throw new Error(`Cloudflare API failed (${response.status}): ${JSON.stringify(body?.errors || body).slice(0, 1200)}`);
  }
  return body;
}

async function referencedDatabases() {
  const workerDir = path.resolve('worker');
  const files = (await readdir(workerDir)).filter((name) => /^wrangler.*\.jsonc$/.test(name));
  const databases = new Map();
  const pattern = /"database_name"\s*:\s*"([^"]+)"[\s\S]{0,300}?"database_id"\s*:\s*"([^"]+)"/g;
  for (const file of files) {
    const source = await readFile(path.join(workerDir, file), 'utf8');
    for (const match of source.matchAll(pattern)) {
      const [, name, id] = match;
      const current = databases.get(id) || { id, name, configs: [] };
      current.configs.push(file);
      databases.set(id, current);
    }
  }
  if (!databases.size) throw new Error('No D1 databases found in worker/wrangler*.jsonc');
  return databases;
}

async function discoverAccounts(referenced) {
  const response = await api(`${API_ROOT}/accounts?per_page=50`);
  const accounts = [];
  for (const account of response.result || []) {
    let listed;
    try {
      listed = await api(`${API_ROOT}/accounts/${account.id}/d1/database?per_page=100`);
    } catch (error) {
      console.warn(`Skipping inaccessible account: ${error.message}`);
      continue;
    }
    const matches = (listed.result || []).filter((database) => referenced.has(database.uuid || database.id));
    if (matches.length) accounts.push({ id: account.id, name: account.name, referenced: matches });
  }
  if (!accounts.length) throw new Error('No accessible account contains repository D1 databases');
  return accounts;
}

const query = `query D1HourlyUsage($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $start, datetime_leq: $end }
        orderBy: [datetimeFifteenMinutes_ASC]
      ) {
        sum { readQueries writeQueries rowsRead rowsWritten }
        dimensions { datetimeFifteenMinutes databaseId }
      }
    }
  }
}`;

async function usageForAccount(accountId, start, end) {
  const body = await api(GRAPHQL_URL, {
    method: 'POST',
    body: JSON.stringify({ query, variables: { accountTag: accountId, start, end } }),
  });
  return body.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups || [];
}

function emptyUsage(extra = {}) {
  return { ...extra, rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 };
}

function addUsage(target, source) {
  target.rowsRead += numeric(source.rowsRead);
  target.rowsWritten += numeric(source.rowsWritten);
  target.readQueries += numeric(source.readQueries);
  target.writeQueries += numeric(source.writeQueries);
}

const generatedAt = new Date();
const startDate = configuredStart(generatedAt);
const end = generatedAt.toISOString();
const start = startDate.toISOString();
const windowMinutes = Math.max(1, (generatedAt.getTime() - startDate.getTime()) / 60_000);
const referenced = await referencedDatabases();
const accounts = await discoverAccounts(referenced);
const databaseNames = new Map([...referenced.values()].map(({ id, name }) => [id, name]));
const total = emptyUsage();
const byDatabase = new Map();
const byBucket = new Map();

for (const account of accounts) {
  const groups = await usageForAccount(account.id, start, end);
  for (const group of groups) {
    const databaseId = String(group.dimensions?.databaseId || '');
    if (!referenced.has(databaseId)) continue;
    const bucket = String(group.dimensions?.datetimeFifteenMinutes || 'unknown');
    const values = group.sum || {};
    addUsage(total, values);

    const database = byDatabase.get(databaseId) || emptyUsage({
      databaseId,
      databaseName: databaseNames.get(databaseId) || databaseId,
    });
    addUsage(database, values);
    byDatabase.set(databaseId, database);

    const interval = byBucket.get(bucket) || emptyUsage({ bucket });
    addUsage(interval, values);
    byBucket.set(bucket, interval);
  }
}

const windowRatio = windowMinutes / (24 * 60);
const windowTarget = {
  rowsRead: FREE_READ_ROWS_PER_DAY * TARGET_RATIO * windowRatio,
  rowsWritten: FREE_WRITE_ROWS_PER_DAY * TARGET_RATIO * windowRatio,
};
const dailyProjectionFactor = (24 * 60) / windowMinutes;
const projectedDaily = {
  rowsRead: Math.round(total.rowsRead * dailyProjectionFactor),
  rowsWritten: Math.round(total.rowsWritten * dailyProjectionFactor),
  readQueries: Math.round(total.readQueries * dailyProjectionFactor),
  writeQueries: Math.round(total.writeQueries * dailyProjectionFactor),
};
const violations = [];
if (total.rowsRead >= windowTarget.rowsRead) {
  violations.push(`rows read ${total.rowsRead} >= ${Math.floor(windowTarget.rowsRead)}`);
}
if (total.rowsWritten >= windowTarget.rowsWritten) {
  violations.push(`rows written ${total.rowsWritten} >= ${Math.floor(windowTarget.rowsWritten)}`);
}

const databases = [...byDatabase.values()]
  .sort((left, right) => (right.rowsRead + right.rowsWritten) - (left.rowsRead + left.rowsWritten));
const buckets = [...byBucket.values()].sort((left, right) => left.bucket.localeCompare(right.bucket));
const report = {
  generatedAt: generatedAt.toISOString(),
  scope: 'repository-referenced-databases',
  window: { start, end, minutes: windowMinutes },
  limits: {
    freePerDay: { rowsRead: FREE_READ_ROWS_PER_DAY, rowsWritten: FREE_WRITE_ROWS_PER_DAY },
    targetRatio: TARGET_RATIO,
    targetPerDay: {
      rowsRead: FREE_READ_ROWS_PER_DAY * TARGET_RATIO,
      rowsWritten: FREE_WRITE_ROWS_PER_DAY * TARGET_RATIO,
    },
    targetPerWindow: windowTarget,
    targetPerHour: {
      rowsRead: (FREE_READ_ROWS_PER_DAY * TARGET_RATIO) / 24,
      rowsWritten: (FREE_WRITE_ROWS_PER_DAY * TARGET_RATIO) / 24,
    },
  },
  observed: total,
  projectedDaily,
  utilization: {
    rowsReadPercent: percentage(total.rowsRead, windowTarget.rowsRead),
    rowsWrittenPercent: percentage(total.rowsWritten, windowTarget.rowsWritten),
  },
  headroom: {
    rowsRead: Math.floor(windowTarget.rowsRead - total.rowsRead),
    rowsWritten: Math.floor(windowTarget.rowsWritten - total.rowsWritten),
  },
  ok: violations.length === 0,
  violations,
  accounts: accounts.map(({ id, name }) => ({ id, name })),
  databases,
  buckets,
};

await writeFile(path.join(outputDir, 'hourly-summary.json'), `${JSON.stringify(report, null, 2)}\n`);
const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const lines = [
  '# D1 rolling usage',
  '',
  `Generated: ${report.generatedAt}`,
  `Window: ${start} to ${end} (${windowMinutes.toFixed(1)} minutes)`,
  'Scope: D1 databases referenced by this repository',
  '',
  '| Metric | Observed window | 50% free-tier window target | Utilization | 24h projection | Headroom |',
  '|---|---:|---:|---:|---:|---:|',
  `| Rows read | ${fmt.format(total.rowsRead)} | ${fmt.format(windowTarget.rowsRead)} | ${report.utilization.rowsReadPercent.toFixed(1)}% | ${fmt.format(projectedDaily.rowsRead)} | ${fmt.format(report.headroom.rowsRead)} |`,
  `| Rows written | ${fmt.format(total.rowsWritten)} | ${fmt.format(windowTarget.rowsWritten)} | ${report.utilization.rowsWrittenPercent.toFixed(1)}% | ${fmt.format(projectedDaily.rowsWritten)} | ${fmt.format(report.headroom.rowsWritten)} |`,
  '',
  `Budget result: ${report.ok ? 'PASS' : `FAIL (${violations.join(', ')})`}`,
  '',
  '## By database',
  '',
  '| Database | Rows read | Rows written | Read queries | Write queries |',
  '|---|---:|---:|---:|---:|',
  ...databases.map((item) => `| ${item.databaseName} | ${fmt.format(item.rowsRead)} | ${fmt.format(item.rowsWritten)} | ${fmt.format(item.readQueries)} | ${fmt.format(item.writeQueries)} |`),
  '',
];
await writeFile(path.join(outputDir, 'hourly-summary.md'), `${lines.join('\n')}\n`);
console.log(JSON.stringify({
  scope: report.scope,
  window: report.window,
  observed: total,
  projectedDaily,
  utilization: report.utilization,
  ok: report.ok,
  violations,
}));
