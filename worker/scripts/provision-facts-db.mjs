import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workerRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(workerRoot, '..');
const wranglerScript = resolve(workerRoot, 'node_modules/wrangler/bin/wrangler.js');
const schemaPath = resolve(repositoryRoot, 'database/facts-migrations/001_initial_schema.sql');
const enumMigrationPath = resolve(
  repositoryRoot,
  'database/facts-migrations/002_normalize_minute_fact_enums.sql',
);
const compactMigrationPath = resolve(
  repositoryRoot,
  'database/facts-migrations/003_compact_minute_facts.sql',
);
const readModelMigrationPath = resolve(
  repositoryRoot,
  'database/facts-migrations/004_buddies_queue_read_models.sql',
);
const metadataPath = resolve(repositoryRoot, 'database/facts-db.json');
const databaseName = process.env.FACTS_DATABASE_NAME || 'Stationhead-DB';

if (!process.env.CLOUDFLARE_API_TOKEN) {
  throw new Error('CLOUDFLARE_API_TOKEN is required');
}
if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.warn('CLOUDFLARE_ACCOUNT_ID is not set; Wrangler will infer the account from the API token.');
}

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

function tableColumnNames(databaseName, table) {
  const output = wrangler([
    'd1', 'execute', databaseName,
    '--remote', '--yes', '--json',
    '--command', `SELECT name FROM pragma_table_info('${table}')`,
  ]);
  const parsed = parseJsonOutput(output);
  const containers = Array.isArray(parsed) ? parsed : [parsed];
  const rows = containers.flatMap((container) => container?.results || []);
  return new Set(rows.map((row) => String(row.name)));
}

let database = listDatabases().find((item) => item.name === databaseName);
if (!database) {
  wrangler(['d1', 'create', databaseName]);
  database = listDatabases().find((item) => item.name === databaseName);
}
if (!database) throw new Error(`Wrangler did not create or list ${databaseName}`);

const databaseId = database.uuid || database.id || database.database_id;
if (!databaseId) throw new Error(`Could not determine database id for ${databaseName}`);

let factsColumns = tableColumnNames(databaseName, 'sh_minute_facts');
if (factsColumns.size === 0) {
  wrangler([
    'd1', 'execute', databaseName,
    '--remote', '--yes',
    '--file', schemaPath,
  ]);
  factsColumns = tableColumnNames(databaseName, 'sh_minute_facts');
}
if (factsColumns.size > 0 && !factsColumns.has('source_code')) {
  console.log('Migrating sh_minute_facts.source/track_detection_method to integer codes...');
  wrangler([
    'd1', 'execute', databaseName,
    '--remote', '--yes',
    '--file', enumMigrationPath,
  ]);
  factsColumns = tableColumnNames(databaseName, 'sh_minute_facts');
}

if (factsColumns.has('source_code') && !factsColumns.has('collector_code')) {
  console.log('Compacting sh_minute_facts and normalizing sparse context...');
  wrangler([
    'd1', 'execute', databaseName,
    '--remote', '--yes',
    '--file', compactMigrationPath,
  ]);
}

wrangler([
  'd1', 'execute', databaseName,
  '--remote', '--yes',
  '--file', readModelMigrationPath,
]);

writeFileSync(metadataPath, `${JSON.stringify({
  binding: 'FACTS_DB',
  database_name: databaseName,
  database_id: databaseId,
  schema: 'database/facts-migrations/004_buddies_queue_read_models.sql',
}, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, database_name: databaseName, database_id: databaseId }));
