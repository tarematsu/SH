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
const commentTaskMigrationPath = resolve(
  repositoryRoot,
  'database/facts-migrations/005_minute_comment_tasks.sql',
);
const predictionStateMigrationPath = resolve(
  repositoryRoot,
  'database/facts-migrations/006_stream_goal_prediction_state.sql',
);
const cleanupMigrationPath = resolve(
  repositoryRoot,
  'database/facts-migrations/007_remove_unused_runtime_tables.sql',
);
const downstreamArchiveMigrationPath = resolve(
  repositoryRoot,
  'database/facts-migrations/008_buddies_downstream_archive.sql',
);
const completionMigrationPath = resolve(
  repositoryRoot,
  'database/facts-migrations/009_mark_legacy_migration_complete.sql',
);
const storageRedesignMigrationPath = resolve(
  repositoryRoot,
  'database/facts-migrations/010_sparse_context_and_counter_log.sql',
);
const counterRepairMigrationPath = resolve(
  repositoryRoot,
  'database/facts-migrations/011_repair_counter_current.sql',
);
const counterReadIndexMigrationPath = resolve(
  repositoryRoot,
  'database/facts-migrations/012_counter_current_read_index.sql',
);
const runtimeTablesMigrationPath = resolve(
  repositoryRoot,
  'database/facts-migrations/013_minute_runtime_tables.sql',
);
const trackMetadataBackfillMigrationPath = resolve(
  repositoryRoot,
  'database/facts-migrations/014_backfill_track_metadata.sql',
);
const trackHistoryViewRepairMigrationPath = resolve(
  repositoryRoot,
  'database/facts-migrations/015_repair_track_history_queue_views.sql',
);
const trackMetadataIsrcMigrationPath = resolve(
  repositoryRoot,
  'database/facts-migrations/016_track_metadata_isrc.sql',
);
const metadataPath = resolve(repositoryRoot, 'database/facts-db.json');
const databaseName = process.env.FACTS_DATABASE_NAME || 'stationhead-minute';

if (!process.env.CLOUDFLARE_API_TOKEN) {
  throw new Error('CLOUDFLARE_API_TOKEN is required');
}
if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.warn('CLOUDFLARE_ACCOUNT_ID is not set; Wrangler will infer the account from the API token.');
}

function retryableWranglerError(error) {
  const detail = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join(' ');
  return /(?:429|502|503|504|temporarily unavailable|database .* unavailable|ECONNRESET|ETIMEDOUT|network)/i.test(detail);
}

function waitBeforeRetry() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
}

function wrangler(args) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return execFileSync(process.execPath, [wranglerScript, ...args], {
        cwd: workerRoot,
        env: process.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      });
    } catch (error) {
      if (attempt === 2 || !retryableWranglerError(error)) throw error;
      console.warn(`Wrangler transient failure; retrying (${attempt + 1}/2)...`);
      waitBeforeRetry();
    }
  }
  throw new Error('Wrangler operation failed without an error');
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

function executeCommand(sql) {
  return wrangler([
    'd1', 'execute', databaseName,
    '--remote', '--yes',
    '--command', sql,
  ]);
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

for (const migrationPath of [
  readModelMigrationPath,
  commentTaskMigrationPath,
  predictionStateMigrationPath,
  cleanupMigrationPath,
  downstreamArchiveMigrationPath,
  completionMigrationPath,
]) {
  wrangler([
    'd1', 'execute', databaseName,
    '--remote', '--yes',
    '--file', migrationPath,
  ]);
}

if (tableColumnNames(databaseName, 'sh_minute_fact_context_v2').size === 0) {
  console.log('Applying sparse member/context and canonical counter-log migration...');
  wrangler([
    'd1', 'execute', databaseName,
    '--remote', '--yes',
    '--file', storageRedesignMigrationPath,
  ]);
}

if (tableColumnNames(databaseName, 'sh_facts_storage_repairs').size === 0) {
  console.log('Applying counter-current repair migration...');
  wrangler([
    'd1', 'execute', databaseName,
    '--remote', '--yes',
    '--file', counterRepairMigrationPath,
  ]);
}

wrangler([
  'd1', 'execute', databaseName,
  '--remote', '--yes',
  '--file', counterReadIndexMigrationPath,
]);

const inboxColumns = tableColumnNames(databaseName, 'sh_minute_fact_jobs');
if (inboxColumns.size > 0 && !inboxColumns.has('job_kind')) {
  executeCommand("ALTER TABLE sh_minute_fact_jobs ADD COLUMN job_kind TEXT NOT NULL DEFAULT 'live'");
}
if (inboxColumns.size > 0 && !inboxColumns.has('job_priority')) {
  executeCommand('ALTER TABLE sh_minute_fact_jobs ADD COLUMN job_priority INTEGER NOT NULL DEFAULT 100');
}
wrangler([
  'd1', 'execute', databaseName,
  '--remote', '--yes',
  '--file', runtimeTablesMigrationPath,
]);

let trackColumns = tableColumnNames(databaseName, 'sh_tracks');
if (trackColumns.size > 0 && !trackColumns.has('isrc')) {
  console.log('Adding sh_tracks.isrc for minute track metadata enrichment...');
  executeCommand('ALTER TABLE sh_tracks ADD COLUMN isrc TEXT');
  trackColumns = tableColumnNames(databaseName, 'sh_tracks');
}
if (trackColumns.size > 0 && !trackColumns.has('isrc')) {
  throw new Error('sh_tracks.isrc migration did not complete');
}

wrangler([
  'd1', 'execute', databaseName,
  '--remote', '--yes',
  '--file', trackMetadataBackfillMigrationPath,
]);

let trackMetadataColumns = tableColumnNames(databaseName, 'sh_track_metadata');
if (trackMetadataColumns.size > 0 && !trackMetadataColumns.has('isrc')) {
  console.log('Adding sh_track_metadata.isrc for committed metadata enrichment...');
  wrangler([
    'd1', 'execute', databaseName,
    '--remote', '--yes',
    '--file', trackMetadataIsrcMigrationPath,
  ]);
  trackMetadataColumns = tableColumnNames(databaseName, 'sh_track_metadata');
}
if (trackMetadataColumns.size > 0 && !trackMetadataColumns.has('isrc')) {
  throw new Error('sh_track_metadata.isrc migration did not complete');
}
executeCommand(`CREATE INDEX IF NOT EXISTS idx_sh_track_metadata_isrc
  ON sh_track_metadata(isrc)
  WHERE isrc IS NOT NULL AND TRIM(isrc)<>''`);

wrangler([
  'd1', 'execute', databaseName,
  '--remote', '--yes',
  '--file', trackHistoryViewRepairMigrationPath,
]);

writeFileSync(metadataPath, `${JSON.stringify({
  binding: 'MINUTE_DB',
  database_name: databaseName,
  database_id: databaseId,
  schema: 'database/facts-migrations/016_track_metadata_isrc.sql',
}, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, database_name: databaseName, database_id: databaseId }));
