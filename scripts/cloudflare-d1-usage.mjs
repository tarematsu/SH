import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API_ROOT = 'https://api.cloudflare.com/client/v4';
const GRAPHQL_URL = `${API_ROOT}/graphql`;
const FREE_READ_ROWS = 5_000_000;
const FREE_WRITE_ROWS = 100_000;
const TARGET_RATIO = 0.8;
const TARGET_READ_ROWS = FREE_READ_ROWS * TARGET_RATIO;
const TARGET_WRITE_ROWS = FREE_WRITE_ROWS * TARGET_RATIO;
const token = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');

const outputDir = path.resolve(process.env.D1_USAGE_OUTPUT_DIR || 'd1-usage');
await mkdir(outputDir, { recursive: true });

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function shiftUtcDate(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

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

const query = `query D1DailyUsage($accountTag: string!, $start: Date!, $end: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(
        limit: 10000
        filter: { date_geq: $start, date_leq: $end }
        orderBy: [date_ASC]
      ) {
        sum {
          readQueries
          writeQueries
          rowsRead
          rowsWritten
          queryBatchResponseBytes
        }
        dimensions {
          date
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

const now = new Date();
const today = isoDate(now);
const yesterday = isoDate(shiftUtcDate(now, -1));
const start = isoDate(shiftUtcDate(now, -7));
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
  const rows = await usageForAccount(account.id, start, today);
  for (const row of rows) groups.push({ ...row, accountId: account.id, accountName: account.name });
}

const daily = new Map();
const databaseDaily = new Map();
for (let cursor = new Date(`${start}T00:00:00Z`); isoDate(cursor) <= today; cursor = shiftUtcDate(cursor, 1)) {
  daily.set(isoDate(cursor), { date: isoDate(cursor), rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 });
}
for (const group of groups) {
  const date = String(group.dimensions?.date || '');
  const databaseId = String(group.dimensions?.databaseId || 'unknown');
  const sum = group.sum || {};
  const values = {
    rowsRead: numeric(sum.rowsRead),
    rowsWritten: numeric(sum.rowsWritten),
    readQueries: numeric(sum.readQueries),
    writeQueries: numeric(sum.writeQueries),
  };
  const total = daily.get(date) || { date, rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 };
  for (const key of ['rowsRead', 'rowsWritten', 'readQueries', 'writeQueries']) total[key] += values[key];
  daily.set(date, total);
  const dbKey = `${date}:${databaseId}`;
  const db = databaseDaily.get(dbKey) || {
    date,
    databaseId,
    databaseName: databaseNames.get(databaseId) || databaseId,
    rowsRead: 0,
    rowsWritten: 0,
    readQueries: 0,
    writeQueries: 0,
  };
  for (const key of ['rowsRead', 'rowsWritten', 'readQueries', 'writeQueries']) db[key] += values[key];
  databaseDaily.set(dbKey, db);
}

const completeDays = [...daily.values()].filter((item) => item.date < today).sort((a, b) => a.date.localeCompare(b.date));
const lastSeven = completeDays.slice(-7);
const latestComplete = daily.get(yesterday) || { date: yesterday, rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 };
const currentPartial = daily.get(today) || { date: today, rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 };
const elapsedHours = Math.max(1, now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600);
const projectionFactor = Math.min(24, 24 / elapsedHours);
const projectedToday = {
  date: today,
  rowsRead: Math.round(currentPartial.rowsRead * projectionFactor),
  rowsWritten: Math.round(currentPartial.rowsWritten * projectionFactor),
  readQueries: Math.round(currentPartial.readQueries * projectionFactor),
  writeQueries: Math.round(currentPartial.writeQueries * projectionFactor),
};

function average(key) {
  return lastSeven.length ? Math.round(lastSeven.reduce((sum, day) => sum + day[key], 0) / lastSeven.length) : 0;
}
function maximum(key) {
  return lastSeven.length ? Math.max(...lastSeven.map((day) => day[key])) : 0;
}

const sevenDayAverage = {
  rowsRead: average('rowsRead'),
  rowsWritten: average('rowsWritten'),
  readQueries: average('readQueries'),
  writeQueries: average('writeQueries'),
};
const sevenDayMaximum = {
  rowsRead: maximum('rowsRead'),
  rowsWritten: maximum('rowsWritten'),
  readQueries: maximum('readQueries'),
  writeQueries: maximum('writeQueries'),
};
const planningEstimate = {
  rowsRead: Math.max(latestComplete.rowsRead, sevenDayAverage.rowsRead, projectedToday.rowsRead),
  rowsWritten: Math.max(latestComplete.rowsWritten, sevenDayAverage.rowsWritten, projectedToday.rowsWritten),
};

const latestDatabaseRows = [...databaseDaily.values()]
  .filter((item) => item.date === yesterday)
  .sort((a, b) => (b.rowsRead + b.rowsWritten) - (a.rowsRead + a.rowsWritten));

const report = {
  generatedAt: now.toISOString(),
  window: { start, end: today, latestCompleteDate: yesterday },
  limits: {
    free: { rowsRead: FREE_READ_ROWS, rowsWritten: FREE_WRITE_ROWS },
    targetRatio: TARGET_RATIO,
    target: { rowsRead: TARGET_READ_ROWS, rowsWritten: TARGET_WRITE_ROWS },
  },
  accounts: accounts.map((account) => ({ id: account.id, name: account.name })),
  databases: [...referenced.values()].map((database) => ({
    ...database,
    accountId: accounts.find((account) => account.referenced.some((item) => (item.uuid || item.id) === database.id))?.id || null,
  })),
  latestComplete,
  currentPartial,
  projectedToday,
  sevenDayAverage,
  sevenDayMaximum,
  planningEstimate,
  targetUtilization: {
    rowsReadPercent: percentage(planningEstimate.rowsRead, TARGET_READ_ROWS),
    rowsWrittenPercent: percentage(planningEstimate.rowsWritten, TARGET_WRITE_ROWS),
  },
  targetHeadroom: {
    rowsRead: TARGET_READ_ROWS - planningEstimate.rowsRead,
    rowsWritten: TARGET_WRITE_ROWS - planningEstimate.rowsWritten,
  },
  daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
  latestCompleteByDatabase: latestDatabaseRows,
};

await writeFile(path.join(outputDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(outputDir, 'databases.json'), `${JSON.stringify(report.databases, null, 2)}\n`);

const fmt = new Intl.NumberFormat('en-US');
const lines = [
  '# D1 daily usage',
  '',
  `Generated: ${report.generatedAt}`,
  '',
  '| Metric | Free limit | 80% target | Latest complete day | 7-day average | 7-day maximum | Projected today | Planning estimate | Target utilization |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  `| Rows read | ${fmt.format(FREE_READ_ROWS)} | ${fmt.format(TARGET_READ_ROWS)} | ${fmt.format(latestComplete.rowsRead)} | ${fmt.format(sevenDayAverage.rowsRead)} | ${fmt.format(sevenDayMaximum.rowsRead)} | ${fmt.format(projectedToday.rowsRead)} | ${fmt.format(planningEstimate.rowsRead)} | ${percentage(planningEstimate.rowsRead, TARGET_READ_ROWS).toFixed(1)}% |`,
  `| Rows written | ${fmt.format(FREE_WRITE_ROWS)} | ${fmt.format(TARGET_WRITE_ROWS)} | ${fmt.format(latestComplete.rowsWritten)} | ${fmt.format(sevenDayAverage.rowsWritten)} | ${fmt.format(sevenDayMaximum.rowsWritten)} | ${fmt.format(projectedToday.rowsWritten)} | ${fmt.format(planningEstimate.rowsWritten)} | ${percentage(planningEstimate.rowsWritten, TARGET_WRITE_ROWS).toFixed(1)}% |`,
  '',
  `Planning headroom: ${fmt.format(report.targetHeadroom.rowsRead)} read rows/day and ${fmt.format(report.targetHeadroom.rowsWritten)} written rows/day.`,
  '',
  `## ${yesterday} by database`,
  '',
  '| Database | Rows read | Rows written | Read queries | Write queries |',
  '|---|---:|---:|---:|---:|',
  ...latestDatabaseRows.map((item) => `| ${item.databaseName} | ${fmt.format(item.rowsRead)} | ${fmt.format(item.rowsWritten)} | ${fmt.format(item.readQueries)} | ${fmt.format(item.writeQueries)} |`),
  '',
];
await writeFile(path.join(outputDir, 'summary.md'), `${lines.join('\n')}\n`);
console.log(JSON.stringify({
  latestComplete,
  sevenDayAverage,
  sevenDayMaximum,
  projectedToday,
  planningEstimate,
  targetUtilization: report.targetUtilization,
  targetHeadroom: report.targetHeadroom,
}));
