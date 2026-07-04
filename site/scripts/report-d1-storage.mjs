import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const database = process.env.D1_DATABASE || 'stationhead-monitor';
const config = process.env.D1_CONFIG || 'wrangler.jsonc';
const outputPath = process.env.D1_REPORT_PATH || 'd1-storage-report.md';
const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_BUILDS_API_TOKEN || '';
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '';

if (!apiToken) {
  throw new Error('D1 storage diagnostics failed: Cloudflare API token is missing.');
}

const runnerEnv = {
  ...process.env,
  CI: 'true',
  CLOUDFLARE_API_TOKEN: apiToken,
  ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
};

function runSql(sql) {
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'd1', 'execute', database, '--remote', '--config', config, '--command', sql, '--json'],
    { encoding: 'utf8', env: runnerEnv, maxBuffer: 20 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`D1 query failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout);
  const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
  while (queue.length) {
    const value = queue.shift();
    if (Array.isArray(value?.results)) return value.results;
    if (Array.isArray(value)) queue.push(...value);
    else if (value && typeof value === 'object') queue.push(...Object.values(value));
  }
  return [];
}

function quoteIdentifier(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function bytes(value) {
  const number = Number(value || 0);
  if (number < 1024) return `${number} B`;
  if (number < 1024 ** 2) return `${(number / 1024).toFixed(1)} KiB`;
  return `${(number / 1024 ** 2).toFixed(2)} MiB`;
}

const tables = runSql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")
  .map((row) => row.name);
const rows = [];

for (const table of tables) {
  const columns = runSql(`PRAGMA table_info(${quoteIdentifier(table)})`);
  const textColumns = columns
    .filter((column) => /TEXT|CLOB|CHAR|JSON|BLOB/i.test(String(column.type || '')))
    .map((column) => column.name);
  const timeColumn = ['observed_at', 'chat_time_ms', 'detected_at', 'first_seen_at', 'updated_at', 'imported_at', 'fetched_at']
    .find((candidate) => columns.some((column) => column.name === candidate));
  const payloadExpression = textColumns.length
    ? textColumns.map((column) => `COALESCE(LENGTH(CAST(${quoteIdentifier(column)} AS BLOB)),0)`).join(' + ')
    : '0';
  const timeFields = timeColumn
    ? `, MIN(${quoteIdentifier(timeColumn)}) AS oldest_value, MAX(${quoteIdentifier(timeColumn)}) AS newest_value`
    : ', NULL AS oldest_value, NULL AS newest_value';
  const [summary = {}] = runSql(`SELECT COUNT(*) AS row_count, COALESCE(SUM(${payloadExpression}),0) AS payload_bytes${timeFields} FROM ${quoteIdentifier(table)}`);
  rows.push({
    table,
    rowCount: Number(summary.row_count || 0),
    payloadBytes: Number(summary.payload_bytes || 0),
    timeColumn: timeColumn || '',
    oldest: summary.oldest_value ?? '',
    newest: summary.newest_value ?? '',
  });
}

rows.sort((a, b) => b.payloadBytes - a.payloadBytes || b.rowCount - a.rowCount);
const totalPayload = rows.reduce((sum, row) => sum + row.payloadBytes, 0);
const totalRows = rows.reduce((sum, row) => sum + row.rowCount, 0);

const lines = [
  '# D1 storage diagnostics',
  '',
  `- Generated: ${new Date().toISOString()}`,
  `- Database: \`${database}\``,
  `- Tables: ${rows.length}`,
  `- Total rows: ${totalRows.toLocaleString('en-US')}`,
  `- Measured TEXT/BLOB payload: ${bytes(totalPayload)} (${totalPayload.toLocaleString('en-US')} bytes)`,
  '',
  '> This is a read-only estimate of stored TEXT/BLOB payload. SQLite row overhead, indexes, free pages and internal metadata are not included.',
  '',
  '| Table | Rows | TEXT/BLOB payload | Time column | Oldest | Newest |',
  '|---|---:|---:|---|---:|---:|',
];
for (const row of rows) {
  lines.push(`| \`${row.table}\` | ${row.rowCount.toLocaleString('en-US')} | ${bytes(row.payloadBytes)} | ${row.timeColumn || '-'} | ${row.oldest || '-'} | ${row.newest || '-'} |`);
}

const monthlyTargets = rows.filter((row) => row.timeColumn && row.rowCount > 0).slice(0, 12);
for (const row of monthlyTargets) {
  const unit = row.newest > 10_000_000_000 ? 1000 : 1;
  const monthly = runSql(`SELECT strftime('%Y-%m', ${quoteIdentifier(row.timeColumn)} / ${unit}, 'unixepoch') AS month, COUNT(*) AS rows FROM ${quoteIdentifier(row.table)} WHERE ${quoteIdentifier(row.timeColumn)} IS NOT NULL GROUP BY month ORDER BY month DESC LIMIT 12`);
  lines.push('', `## ${row.table}: monthly rows`, '', '| Month | Rows |', '|---|---:|');
  for (const item of monthly) lines.push(`| ${item.month || 'unknown'} | ${Number(item.rows || 0).toLocaleString('en-US')} |`);
}

writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
console.log(lines.join('\n'));
