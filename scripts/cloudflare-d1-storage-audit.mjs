import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const outputDir = path.resolve(
  process.env.D1_STORAGE_AUDIT_OUTPUT_DIR || 'd1-storage-audit',
);
const deepAudit = /^(1|true|yes)$/i.test(
  String(process.env.D1_STORAGE_DEEP_AUDIT || '').trim(),
);
const wranglerScript = path.resolve('worker/node_modules/wrangler/bin/wrangler.js');
await mkdir(outputDir, { recursive: true });

function wrangler(args) {
  return execFileSync(process.execPath, [wranglerScript, ...args], {
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function parseJsonOutput(output) {
  const text = String(output || '').trim();
  const starts = [text.indexOf('['), text.indexOf('{')].filter((index) => index >= 0);
  if (!starts.length) throw new Error(`Wrangler did not return JSON: ${text.slice(0, 500)}`);
  return JSON.parse(text.slice(Math.min(...starts)));
}

function resultRows(payload) {
  const containers = Array.isArray(payload) ? payload : [payload];
  return containers.flatMap((container) => (
    container?.results || container?.result?.results || container?.result?.[0]?.results || []
  ));
}

function resultMeta(payload) {
  const containers = Array.isArray(payload) ? payload : [payload];
  return containers.find((container) => container?.meta)?.meta
    || containers.find((container) => container?.result?.meta)?.result?.meta
    || containers.find((container) => container?.result?.[0]?.meta)?.result?.[0]?.meta
    || null;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'unavailable';
  return `${bytes.toLocaleString('en-US')} bytes (${(bytes / 1024 / 1024).toFixed(2)} MiB)`;
}

function markdown(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

const descriptor = JSON.parse(await readFile('database/facts-db.json', 'utf8'));
const databaseName = String(descriptor.database_name || '').trim();
const databaseId = String(descriptor.database_id || '').trim();
if (!databaseName || !databaseId) {
  throw new Error('database/facts-db.json is missing database_name or database_id');
}

const databases = parseJsonOutput(wrangler(['d1', 'list', '--json']));
const listedDatabases = Array.isArray(databases) ? databases : databases?.result || [];
const database = listedDatabases
  .find((item) => String(item.uuid || item.id || item.database_id) === databaseId)
  || listedDatabases.find((item) => String(item.name) === databaseName);
if (!database) throw new Error(`Wrangler did not list ${databaseName} (${databaseId})`);

function query(label, sql) {
  try {
    const payload = parseJsonOutput(wrangler([
      'd1', 'execute', databaseName,
      '--remote', '--yes', '--json',
      '--command', sql,
    ]));
    return {
      label,
      sql,
      ok: true,
      rows: resultRows(payload),
      meta: resultMeta(payload),
    };
  } catch (error) {
    return {
      label,
      sql,
      ok: false,
      rows: [],
      meta: null,
      error: String(error?.message || error).slice(0, 1200),
    };
  }
}

const probeDefinitions = [
  ['page_count', 'PRAGMA page_count'],
  ['page_size', 'PRAGMA page_size'],
  ['freelist_count', 'PRAGMA freelist_count'],
  ['table_list', 'PRAGMA table_list'],
  ['schema', "SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"],
  ['sqlite_stat1', 'SELECT tbl,idx,stat FROM sqlite_stat1 ORDER BY tbl,idx'],
];
if (deepAudit) {
  probeDefinitions.push([
    'dbstat',
    'SELECT name,SUM(pgsize) AS bytes,COUNT(*) AS pages FROM dbstat GROUP BY name ORDER BY bytes DESC',
  ]);
}

const probes = probeDefinitions.map(([label, sql]) => query(label, sql));
const probeRows = (label) => probes.find((item) => item.label === label && item.ok)?.rows || [];
const firstRow = (label) => probeRows(label)[0] || null;
const numberOrNull = (value, { positive = false } = {}) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (positive && number === 0)) return null;
  return number;
};

const pageCount = numberOrNull(firstRow('page_count')?.page_count);
const pageSize = numberOrNull(firstRow('page_size')?.page_size, { positive: true });
const freePages = numberOrNull(firstRow('freelist_count')?.freelist_count);
const pragmaBytes = pageCount != null && pageSize != null ? pageCount * pageSize : null;
const freeBytes = freePages != null && pageSize != null ? freePages * pageSize : null;
const dbstatRows = probeRows('dbstat');
const statRows = probeRows('sqlite_stat1');
const queryRowsRead = probes.reduce((sum, probe) => sum + Number(probe.meta?.rows_read || 0), 0);

const report = {
  generatedAt: new Date().toISOString(),
  deepAudit,
  database,
  sqlite: { pageCount, pageSize, freePages, pragmaBytes, freeBytes },
  queryRowsRead,
  probes,
};
await writeFile(path.join(outputDir, 'storage-audit.json'), `${JSON.stringify(report, null, 2)}\n`);

const lines = [
  '# D1 storage audit',
  '',
  `Generated: ${report.generatedAt}`,
  '',
  `- Database: ${markdown(database.name)} (${markdown(database.uuid || database.id || database.database_id)})`,
  `- Cloudflare file size: ${formatBytes(database.file_size)}`,
  `- Tables reported by API: ${Number(database.num_tables || 0).toLocaleString('en-US')}`,
  `- SQLite page estimate: ${formatBytes(pragmaBytes)}`,
  `- SQLite freelist: ${freePages == null ? 'unavailable' : `${freePages.toLocaleString('en-US')} pages, ${formatBytes(freeBytes)}`}`,
  `- Deep dbstat audit: ${deepAudit ? 'enabled' : 'disabled'}`,
  `- Query rows read: ${queryRowsRead.toLocaleString('en-US')}`,
  '',
];

if (deepAudit) {
  lines.push('## Object storage by dbstat', '');
  if (dbstatRows.length) {
    lines.push('| Object | Bytes | MiB | Pages |', '|---|---:|---:|---:|');
    for (const row of dbstatRows.slice(0, 100)) {
      const bytes = Number(row.bytes || 0);
      lines.push(`| ${markdown(row.name)} | ${bytes.toLocaleString('en-US')} | ${(bytes / 1024 / 1024).toFixed(2)} | ${Number(row.pages || 0).toLocaleString('en-US')} |`);
    }
  } else {
    const probe = probes.find((item) => item.label === 'dbstat');
    lines.push(`Unavailable: ${markdown(probe?.error || 'no rows returned')}`);
  }
  lines.push('');
}

lines.push('## sqlite_stat1 estimates', '');
if (statRows.length) {
  lines.push('| Table | Index | Stat |', '|---|---|---|');
  for (const row of statRows.slice(0, 200)) {
    lines.push(`| ${markdown(row.tbl)} | ${markdown(row.idx)} | ${markdown(row.stat)} |`);
  }
} else {
  const probe = probes.find((item) => item.label === 'sqlite_stat1');
  lines.push(`Unavailable: ${markdown(probe?.error || 'no statistics available')}`);
}

lines.push('', '## Probe status', '', '| Probe | Result | Rows read |', '|---|---|---:|');
for (const probe of probes) {
  const status = probe.ok ? 'ok' : markdown(probe.error || 'failed').slice(0, 500);
  lines.push(`| ${markdown(probe.label)} | ${status} | ${Number(probe.meta?.rows_read || 0).toLocaleString('en-US')} |`);
}
lines.push('');

await writeFile(path.join(outputDir, 'storage-audit.md'), `${lines.join('\n')}\n`);
console.log(JSON.stringify({
  database: database.name,
  fileSize: database.file_size,
  numTables: database.num_tables,
  pageCount,
  pageSize,
  freePages,
  deepAudit,
  queryRowsRead,
  dbstatAvailable: dbstatRows.length > 0,
  sqliteStat1Available: statRows.length > 0,
}));
