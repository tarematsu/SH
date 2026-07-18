import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const FREE_READ_ROWS = 5_000_000;
const FREE_WRITE_ROWS = 100_000;
const TARGET_RATIO = 0.8;
const TARGET_READ_ROWS = Math.floor(FREE_READ_ROWS * TARGET_RATIO);
const TARGET_WRITE_ROWS = Math.floor(FREE_WRITE_ROWS * TARGET_RATIO);
const WINDOW_DAYS = 8;
const outputDir = path.resolve(process.env.D1_USAGE_OUTPUT_DIR || 'd1-usage');
const token = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function dayOffset(date, days) {
  return new Date(date.getTime() + days * 86_400_000);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function percentage(value, denominator) {
  return denominator > 0 ? (value / denominator) * 100 : 0;
}

function average(items, field) {
  return items.length ? items.reduce((sum, item) => sum + finite(item[field]), 0) / items.length : 0;
}

function maximum(items, field) {
  return items.length ? Math.max(...items.map((item) => finite(item[field]))) : 0;
}

async function cloudflare(pathname, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    throw new Error(`Cloudflare API ${response.status}: ${JSON.stringify(payload).slice(0, 2000)}`);
  }
  return payload;
}

async function graphql(accountId, query, variables) {
  const payload = await cloudflare('/graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
  if (payload?.errors?.length) throw new Error(`Cloudflare GraphQL: ${JSON.stringify(payload.errors)}`);
  const account = payload?.data?.viewer?.accounts?.[0];
  if (!account || account.id !== accountId) throw new Error(`Cloudflare GraphQL account missing: ${accountId}`);
  return account;
}

async function repositoryConfigs() {
  const workerDir = path.resolve('worker');
  const names = (await readdir(workerDir)).filter((name) => /^wrangler(?:\..+)?\.jsonc$/.test(name));
  const databases = new Map();
  for (const name of names) {
    const text = await readFile(path.join(workerDir, name), 'utf8');
    for (const match of text.matchAll(/"database_name"\s*:\s*"([^"]+)"[\s\S]{0,300}?"database_id"\s*:\s*"([^"]+)"/g)) {
      const [, databaseName, databaseId] = match;
      const record = databases.get(databaseId) || { id: databaseId, name: databaseName, configs: [] };
      if (!record.configs.includes(name)) record.configs.push(name);
      databases.set(databaseId, record);
    }
  }
  return [...databases.values()].sort((left, right) => left.name.localeCompare(right.name));
}

const now = new Date();
const today = isoDate(now);
const yesterday = isoDate(dayOffset(now, -1));
const startDate = isoDate(dayOffset(now, -WINDOW_DAYS + 1));
const accountsPayload = await cloudflare('/accounts?per_page=50');
const accounts = accountsPayload.result || [];
if (!accounts.length) throw new Error('No Cloudflare accounts are visible to this token');

const configs = await repositoryConfigs();
const databases = [];
for (const account of accounts) {
  const listed = await cloudflare(`/accounts/${account.id}/d1/database?per_page=100`);
  const byId = new Map((listed.result || []).map((database) => [database.uuid, database]));
  for (const config of configs) {
    const database = byId.get(config.id);
    if (!database) continue;
    databases.push({ ...config, accountId: account.id, accountName: account.name });
  }
}

const usageQuery = `query D1Usage($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      id
      d1AnalyticsAdaptiveGroups(
        filter: { datetime_geq: $start, datetime_lt: $end }
        limit: 10000
        orderBy: [datetimeDay_ASC]
      ) {
        dimensions { datetimeDay databaseId }
        sum { readQueries writeQueries rowsRead rowsWritten }
      }
    }
  }
}`;

const daily = new Map();
const byDatabase = new Map();
for (const account of accounts) {
  const accountData = await graphql(account.id, usageQuery, {
    accountTag: account.id,
    start: `${startDate}T00:00:00Z`,
    end: `${isoDate(dayOffset(now, 1))}T00:00:00Z`,
  });
  for (const group of accountData.d1AnalyticsAdaptiveGroups || []) {
    const date = String(group.dimensions?.datetimeDay || '').slice(0, 10);
    const databaseId = String(group.dimensions?.databaseId || 'unknown');
    const sum = group.sum || {};
    const values = {
      rowsRead: finite(sum.rowsRead),
      rowsWritten: finite(sum.rowsWritten),
      readQueries: finite(sum.readQueries),
      writeQueries: finite(sum.writeQueries),
    };
    const day = daily.get(date) || { date, rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 };
    for (const key of ['rowsRead', 'rowsWritten', 'readQueries', 'writeQueries']) day[key] += values[key];
    daily.set(date, day);
    const databaseDayKey = `${databaseId}:${date}`;
    const dbDay = byDatabase.get(databaseDayKey) || {
      databaseId,
      date,
      rowsRead: 0,
      rowsWritten: 0,
      readQueries: 0,
      writeQueries: 0,
    };
    for (const key of ['rowsRead', 'rowsWritten', 'readQueries', 'writeQueries']) dbDay[key] += values[key];
    byDatabase.set(databaseDayKey, dbDay);
  }
}

const completeDays = [...daily.values()].filter((item) => item.date < today).sort((a, b) => a.date.localeCompare(b.date));
const latestComplete = completeDays.find((item) => item.date === yesterday)
  || completeDays.at(-1)
  || { date: yesterday, rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 };
const currentPartial = daily.get(today)
  || { date: today, rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 };
const elapsedTodayMs = Math.max(60_000, now.getTime() - Date.parse(`${today}T00:00:00Z`));
const projectedFactor = Math.min(24, 86_400_000 / elapsedTodayMs);
const projectedToday = {
  date: today,
  rowsRead: Math.round(currentPartial.rowsRead * projectedFactor),
  rowsWritten: Math.round(currentPartial.rowsWritten * projectedFactor),
  readQueries: Math.round(currentPartial.readQueries * projectedFactor),
  writeQueries: Math.round(currentPartial.writeQueries * projectedFactor),
};
const recentComplete = completeDays.slice(-7);
const sevenDayAverage = {
  rowsRead: Math.round(average(recentComplete, 'rowsRead')),
  rowsWritten: Math.round(average(recentComplete, 'rowsWritten')),
  readQueries: Math.round(average(recentComplete, 'readQueries')),
  writeQueries: Math.round(average(recentComplete, 'writeQueries')),
};
const sevenDayMaximum = {
  rowsRead: maximum(recentComplete, 'rowsRead'),
  rowsWritten: maximum(recentComplete, 'rowsWritten'),
  readQueries: maximum(recentComplete, 'readQueries'),
  writeQueries: maximum(recentComplete, 'writeQueries'),
};
const planningEstimate = {
  rowsRead: Math.max(latestComplete.rowsRead, sevenDayAverage.rowsRead, projectedToday.rowsRead),
  rowsWritten: Math.max(latestComplete.rowsWritten, sevenDayAverage.rowsWritten, projectedToday.rowsWritten),
};
const model = {
  basis: 'one-day query insights plus bounded execution frequency after this change',
  normalDay: {
    rowsReadLow: 3_200_000,
    rowsReadHigh: 3_900_000,
    rowsWrittenLow: 35_000,
    rowsWrittenHigh: 75_000,
  },
  caveat: 'Model excludes the first index-build or migration day; completed UTC-day analytics remain authoritative.',
};

const configuredNames = new Map(configs.map((database) => [database.id, database.name]));
const latestDatabaseRows = databases.map((database) => {
  const values = byDatabase.get(`${database.id}:${latestComplete.date}`) || {};
  return {
    databaseId: database.id,
    databaseName: database.name,
    accountId: database.accountId,
    rowsRead: finite(values.rowsRead),
    rowsWritten: finite(values.rowsWritten),
    readQueries: finite(values.readQueries),
    writeQueries: finite(values.writeQueries),
  };
}).sort((left, right) => right.rowsRead - left.rowsRead || right.rowsWritten - left.rowsWritten);

for (const item of byDatabase.values()) {
  if (!configuredNames.has(item.databaseId)) configuredNames.set(item.databaseId, item.databaseId);
}

await mkdir(outputDir, { recursive: true });
const report = {
  generatedAt: now.toISOString(),
  window: { start: startDate, end: today, latestCompleteDate: latestComplete.date },
  limits: {
    free: { rowsRead: FREE_READ_ROWS, rowsWritten: FREE_WRITE_ROWS },
    targetRatio: TARGET_RATIO,
    target: { rowsRead: TARGET_READ_ROWS, rowsWritten: TARGET_WRITE_ROWS },
  },
  accounts: accounts.map(({ id, name }) => ({ id, name })),
  databases,
  latestComplete,
  currentPartial,
  projectedToday,
  sevenDayAverage,
  sevenDayMaximum,
  planningEstimate,
  model,
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
  '## Post-change normal-day model',
  '',
  `- Rows read: ${fmt.format(model.normalDay.rowsReadLow)}-${fmt.format(model.normalDay.rowsReadHigh)} per day`,
  `- Rows written: ${fmt.format(model.normalDay.rowsWrittenLow)}-${fmt.format(model.normalDay.rowsWrittenHigh)} per day`,
  `- Basis: ${model.basis}`,
  `- Caveat: ${model.caveat}`,
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
  model,
  targetUtilization: report.targetUtilization,
  targetHeadroom: report.targetHeadroom,
}));
