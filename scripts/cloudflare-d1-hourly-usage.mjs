import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API_ROOT = 'https://api.cloudflare.com/client/v4';
const GRAPHQL_URL = `${API_ROOT}/graphql`;
const FREE_READ_ROWS_PER_DAY = 5_000_000;
const FREE_WRITE_ROWS_PER_DAY = 100_000;
const TARGET_RATIO = 0.5;
const WINDOW_MINUTES = 60;
const token = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');

const outputDir = path.resolve(process.env.D1_USAGE_OUTPUT_DIR || 'd1-usage');
await mkdir(outputDir, { recursive: true });

function numeric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function percentage(value, limit) {
  return limit > 0 ? (value / limit) * 100 : 0;
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
    const text = await readFile(path.join(workerDir, file), 'utf8');
    for (const match of text.matchAll(pattern)) {
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
  const accountsResponse = await api(`${API_ROOT}/accounts?per_page=50`);
  const matches = [];
  for (const account of accountsResponse.result || []) {
    let response;
    try {
      response = await api(`${API_ROOT}/accounts/${account.id}/d1/database?per_page=100`);
    } catch (error) {
      console.warn(`Skipping account ${account.id}: ${error.message}`);
      continue;
    }
    const databases = response.result || [];
    const referencedHere = databases.filter((database) => referenced.has(database.uuid || database.id));
    if (referencedHere.length) {
      matches.push({ id: account.id, name: account.name, databases, referenced: referencedHere });
    }
  }
  if (!matches.length) throw new Error('No accessible Cloudflare account contains the referenced D1 databases');
  return matches;
}

const query = `query D1HourlyUsage($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $start, datetime_leq: $end }
        orderBy: [datetimeFifteenMinutes_ASC]
      ) {
        sum {
          readQueries
          writeQueries
          rowsRead
          rowsWritten
        }
        dimensions {
          datetimeFifteenMinutes
          databaseId
        }
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

const generatedAt = new Date();
const end = generatedAt.toISOString();
const start = new Date(generatedAt.getTime() - WINDOW_MINUTES * 60_000).toISOString();
const referenced = await referencedDatabases();
const accounts = await discoverAccounts(referenced);
const databaseNames = new Map();
for (const account of accounts) {
  for (const database of account.databases) {
    databaseNames.set(database.uuid || database.id, database.name || database.uuid || database.id);
  }
}
for (const database of referenced.values()) databaseNames.set(database.id, database.name);

const groups = [];
for (const account of accounts) {
  const rows = await usageForAccount(account.id, start, end);
  for (const row of rows) groups.push({ ...row, accountId: account.id, accountName: account.name });
}

const total = { rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 };
const byDatabase = new Map();
const byBucket = new Map();
for (const group of groups) {
  const databaseId = String(group.dimensions?.databaseId || 'unknown');
  const bucket = String(group.dimensions?.datetimeFifteenMinutes || 'unknown');
  const sum = group.sum || {};
  const values = {
    rowsRead: numeric(sum.rowsRead),
    rowsWritten: numeric(sum.rowsWritten),
    readQueries: numeric(sum.readQueries),
    writeQueries: numeric(sum.writeQueries),
  };
  for (const key of Object.keys(total)) total[key] += values[key];

  const database = byDatabase.get(databaseId) || {
    databaseId,
    databaseName: databaseNames.get(databaseId) || databaseId,
    rowsRead: 0,
    rowsWritten: 0,
    readQueries: 0,
    writeQueries: 0,
  };
  for (const key of Object.keys(total)) database[key] += values[key];
  byDatabase.set(databaseId, database);

  const interval = byBucket.get(bucket) || {
    bucket,
    rowsRead: 0,
    rowsWritten: 0,
    readQueries: 0,
    writeQueries: 0,
  };
  for (const key of Object.keys(total)) interval[key] += values[key];
  byBucket.set(bucket, interval);
}

const hourlyTarget = {
  rowsRead: (FREE_READ_ROWS_PER_DAY * TARGET_RATIO) / 24,
  rowsWritten: (FREE_WRITE_ROWS_PER_DAY * TARGET_RATIO) / 24,
};
const projectedDaily = {
  rowsRead: Math.round(total.rowsRead * 24),
  rowsWritten: Math.round(total.rowsWritten * 24),
  readQueries: Math.round(total.readQueries * 24),
  writeQueries: Math.round(total.writeQueries * 24),
};
const violations = [];
if (total.rowsRead >= hourlyTarget.rowsRead) {
  violations.push(`rows read ${total.rowsRead} >= ${Math.floor(hourlyTarget.rowsRead)}`);
}
if (total.rowsWritten >= hourlyTarget.rowsWritten) {
  violations.push(`rows written ${total.rowsWritten} >= ${Math.floor(hourlyTarget.rowsWritten)}`);
}

const databases = [...byDatabase.values()]
  .sort((a, b) => (b.rowsRead + b.rowsWritten) - (a.rowsRead + a.rowsWritten));
const buckets = [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
const report = {
  generatedAt: generatedAt.toISOString(),
  window: { start, end, minutes: WINDOW_MINUTES },
  limits: {
    freePerDay: { rowsRead: FREE_READ_ROWS_PER_DAY, rowsWritten: FREE_WRITE_ROWS_PER_DAY },
    targetRatio: TARGET_RATIO,
    targetPerDay: {
      rowsRead: FREE_READ_ROWS_PER_DAY * TARGET_RATIO,
      rowsWritten: FREE_WRITE_ROWS_PER_DAY * TARGET_RATIO,
    },
    targetPerHour: hourlyTarget,
  },
  observed: total,
  projectedDaily,
  utilization: {
    rowsReadPercent: percentage(total.rowsRead, hourlyTarget.rowsRead),
    rowsWrittenPercent: percentage(total.rowsWritten, hourlyTarget.rowsWritten),
  },
  headroom: {
    rowsRead: Math.floor(hourlyTarget.rowsRead - total.rowsRead),
    rowsWritten: Math.floor(hourlyTarget.rowsWritten - total.rowsWritten),
  },
  ok: violations.length === 0,
  violations,
  accounts: accounts.map((account) => ({ id: account.id, name: account.name })),
  databases,
  buckets,
};

await writeFile(path.join(outputDir, 'hourly-summary.json'), `${JSON.stringify(report, null, 2)}\n`);
const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const lines = [
  '# D1 rolling one-hour usage',
  '',
  `Generated: ${report.generatedAt}`,
  `Window: ${start} to ${end}`,
  '',
  '| Metric | Observed hour | 50% free-tier hourly target | Utilization | 24h projection | Headroom |',
  '|---|---:|---:|---:|---:|---:|',
  `| Rows read | ${fmt.format(total.rowsRead)} | ${fmt.format(hourlyTarget.rowsRead)} | ${report.utilization.rowsReadPercent.toFixed(1)}% | ${fmt.format(projectedDaily.rowsRead)} | ${fmt.format(report.headroom.rowsRead)} |`,
  `| Rows written | ${fmt.format(total.rowsWritten)} | ${fmt.format(hourlyTarget.rowsWritten)} | ${report.utilization.rowsWrittenPercent.toFixed(1)}% | ${fmt.format(projectedDaily.rowsWritten)} | ${fmt.format(report.headroom.rowsWritten)} |`,
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
console.log(JSON.stringify({ window: report.window, observed: total, projectedDaily, utilization: report.utilization, ok: report.ok, violations }));
