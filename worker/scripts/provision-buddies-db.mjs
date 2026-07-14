import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUDDIES_ALL_TABLES } from './buddies-db-tables.mjs';

const workerRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(workerRoot, '..');
const wranglerScript = resolve(workerRoot, 'node_modules/wrangler/bin/wrangler.js');
const migrationsDir = resolve(repositoryRoot, 'database/buddies-migrations');
const metadataPath = resolve(repositoryRoot, 'database/buddies-db.json');
const databaseName = process.env.BUDDIES_DATABASE_NAME || 'stationhead-buddies';

function wrangler(args) {
  return execFileSync(process.execPath, [wranglerScript, ...args], {
    cwd: workerRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function parseJsonOutput(output) {
  const trimmed = String(output || '').trim();
  const starts = [trimmed.indexOf('['), trimmed.indexOf('{')].filter((index) => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0) throw new Error(`Wrangler did not return JSON: ${trimmed.slice(0, 300)}`);
  return JSON.parse(trimmed.slice(start));
}

function listDatabases() {
  return parseJsonOutput(wrangler(['d1', 'list', '--json']));
}

let database = listDatabases().find((item) => item.name === databaseName);
if (!database) {
  wrangler(['d1', 'create', databaseName]);
  database = listDatabases().find((item) => item.name === databaseName);
}
if (!database) throw new Error(`Wrangler did not create or list ${databaseName}`);

const databaseId = database.uuid || database.id || database.database_id;
if (!databaseId) throw new Error(`Could not determine database id for ${databaseName}`);

const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();
for (const migrationFile of migrationFiles) {
  wrangler([
    'd1', 'execute', databaseName,
    '--remote', '--yes',
    '--file', resolve(migrationsDir, migrationFile),
  ]);
}

const tableList = BUDDIES_ALL_TABLES.map((table) => `'${table}'`).join(',');
const verification = parseJsonOutput(wrangler([
  'd1', 'execute', databaseName,
  '--remote', '--yes', '--json',
  '--command', `SELECT name FROM sqlite_schema WHERE type='table' AND name IN (${tableList}) ORDER BY name`,
]));
const rows = (Array.isArray(verification) ? verification : [verification])
  .flatMap((container) => container?.results || []);
const installed = new Set(rows.map((row) => row.name));
const missing = BUDDIES_ALL_TABLES.filter((table) => !installed.has(table));
if (missing.length) throw new Error(`Buddies schema verification failed; missing: ${missing.join(', ')}`);

writeFileSync(metadataPath, `${JSON.stringify({
  binding: 'DB',
  database_name: databaseName,
  database_id: databaseId,
  migrations_dir: 'database/buddies-migrations',
  schema: `database/buddies-migrations/${migrationFiles.at(-1)}`,
}, null, 2)}\n`);

console.log(JSON.stringify({
  ok: true,
  database_name: databaseName,
  database_id: databaseId,
  tables: installed.size,
  binding_change: {
    config: 'worker/wrangler.jsonc',
    binding: 'DB',
    database_name: databaseName,
    database_id: databaseId,
  },
}));
