import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workerRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(workerRoot, '..');
const wranglerScript = resolve(workerRoot, 'node_modules/wrangler/bin/wrangler.js');
const migrationsDir = resolve(repositoryRoot, 'database/other-migrations');
const metadataPath = resolve(repositoryRoot, 'database/other-db.json');
const metadataCleanupScript = resolve(workerRoot, 'scripts/consolidate-track-metadata.mjs');
const metadataDropMigration = '009_drop_duplicate_track_metadata.sql';
const databaseName = process.env.OTHER_DATABASE_NAME || 'stationhead-other';
const BINDING = 'OTHER_DB';

// Both configs need this binding: sh-monitor-other writes the tables in
// database/other-migrations, and site reads/writes several of the same
// tables (host-ingest, dashboard, history summaries) directly.
// Shared track metadata is consolidated into stationhead-buddies below.
const configPaths = [
  resolve(workerRoot, 'wrangler.other.jsonc'),
  resolve(repositoryRoot, 'site/wrangler.jsonc'),
];

if (!process.env.CLOUDFLARE_API_TOKEN) {
  throw new Error('CLOUDFLARE_API_TOKEN is required');
}
if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.warn('CLOUDFLARE_ACCOUNT_ID is not set; Wrangler will infer the account from the API token.');
}

function wrangler(args) {
  try {
    return execFileSync(process.execPath, [wranglerScript, ...args], {
      cwd: workerRoot,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
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

for (const configPath of configPaths) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const bindings = Array.isArray(config.d1_databases) ? config.d1_databases : [];
  const nextBinding = { binding: BINDING, database_name: databaseName, database_id: databaseId };
  const index = bindings.findIndex((item) => item.binding === BINDING);
  if (index >= 0) bindings[index] = nextBinding;
  else bindings.push(nextBinding);
  config.d1_databases = bindings;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();
for (const migrationFile of migrationFiles.filter((name) => name !== metadataDropMigration)) {
  try {
    wrangler([
      'd1', 'execute', databaseName,
      '--remote', '--yes',
      '--file', resolve(migrationsDir, migrationFile),
    ]);
  } catch (error) {
    const details = `${error.stderr || ''}\n${error.stdout || ''}`;
    if (migrationFile === '006_legacy_snapshot_stream_count.sql'
        && /duplicate column name:\s*total_stream_count/i.test(details)) {
      continue;
    }
    throw error;
  }
}

// Copy the old OTHER_DB cache into its new shared owner before dropping the
// duplicate table. The consolidation script is idempotent and skips cleanly
// when this database was provisioned without the legacy table.
try {
  execFileSync(process.execPath, [metadataCleanupScript], {
    cwd: workerRoot,
    env: {
      ...process.env,
      TRACK_METADATA_APPLY: 'true',
      TRACK_METADATA_DROP_SOURCE: 'true',
    },
    stdio: 'inherit',
  });
} catch (error) {
  throw new Error(`Track metadata consolidation failed: ${error?.message || error}`);
}

wrangler([
  'd1', 'execute', databaseName,
  '--remote', '--yes',
  '--file', resolve(migrationsDir, metadataDropMigration),
]);

writeFileSync(metadataPath, `${JSON.stringify({
  binding: BINDING,
  database_name: databaseName,
  database_id: databaseId,
  schema: `database/other-migrations/${migrationFiles.at(-1)}`,
}, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, database_name: databaseName, database_id: databaseId }));
