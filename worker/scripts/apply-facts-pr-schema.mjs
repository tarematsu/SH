import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const workerRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(workerRoot, '..');
const wranglerScript = resolve(workerRoot, 'node_modules/wrangler/bin/wrangler.js');
const descriptorPath = resolve(repositoryRoot, 'database/facts-db.json');
const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
const databaseName = process.env.FACTS_DATABASE_NAME || descriptor.database_name;
const configuredMigrations = Array.isArray(descriptor.migrations)
  ? descriptor.migrations.filter((value) => typeof value === 'string' && value.trim())
  : [];
const migrationPaths = [...new Set([
  ...configuredMigrations,
  descriptor.schema,
].filter(Boolean))];
const deployChangedOnly = /^(1|true|yes)$/i.test(
  String(process.env.FACTS_DEPLOY_CHANGED_ONLY || '').trim(),
);
const deployBaseSha = String(process.env.DEPLOY_BASE_SHA || '').trim();
const deployHeadSha = String(process.env.DEPLOY_HEAD_SHA || 'HEAD').trim() || 'HEAD';

if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is required');
if (!databaseName) throw new Error('facts database name is missing');
if (!descriptor.schema) throw new Error('facts schema descriptor is missing');
if (!migrationPaths.length) throw new Error('facts migration set is empty');

function wrangler(args, stdio = 'inherit') {
  return execFileSync(process.execPath, [wranglerScript, ...args], {
    cwd: workerRoot,
    env: process.env,
    encoding: 'utf8',
    stdio,
  });
}

function parseJsonOutput(output) {
  const text = String(output || '').trim();
  const starts = [text.indexOf('['), text.indexOf('{')].filter((index) => index >= 0);
  if (!starts.length) throw new Error(`Wrangler did not return JSON: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(Math.min(...starts)));
}

function resultRows(payload) {
  const containers = Array.isArray(payload) ? payload : [payload];
  return containers.flatMap((container) => container?.results || container?.result?.results || []);
}

function tableColumns(table) {
  const output = wrangler([
    'd1', 'execute', databaseName,
    '--remote', '--yes', '--json',
    '--command', `SELECT name FROM pragma_table_info('${table}')`,
  ], ['ignore', 'pipe', 'inherit']);
  return new Set(resultRows(parseJsonOutput(output)).map((row) => String(row.name)));
}

function appleMusicCompatibilityPresent() {
  const changes = tableColumns('sh_track_counter_changes').has('apple_music_id');
  const current = tableColumns('sh_track_counter_current').has('apple_music_id');
  if (changes !== current) {
    throw new Error('FACTS Apple Music compatibility migration is partially applied');
  }
  return changes;
}

let playbackPositionPresent;
function playbackPositionColumnPresent() {
  if (playbackPositionPresent === undefined) {
    playbackPositionPresent = tableColumns('sh_minute_facts').has('queue_position_patch');
  }
  return playbackPositionPresent;
}

function deploymentMigrations() {
  if (!deployChangedOnly) {
    return { migrations: migrationPaths, mode: 'ordered-migration-set' };
  }
  if (!deployBaseSha || /^0+$/.test(deployBaseSha)) {
    return { migrations: [descriptor.schema], mode: 'schema-tip-fallback' };
  }
  const changedOutput = execFileSync(
    'git',
    ['diff', '--name-only', deployBaseSha, deployHeadSha, '--', 'database/facts-migrations'],
    { cwd: repositoryRoot, env: process.env, encoding: 'utf8' },
  );
  const changed = new Set(String(changedOutput || '').split(/\r?\n/).filter(Boolean));
  const selected = migrationPaths.filter((migration) => changed.has(migration));
  return selected.length
    ? { migrations: selected, mode: 'changed-migration-set' }
    : { migrations: [descriptor.schema], mode: 'schema-tip-fallback' };
}

let deployment = deploymentMigrations();
const playbackPositionMigration = migrationPaths.find(
  (migration) => basename(migration) === '036_minute_fact_playback_position.sql',
);
if (playbackPositionMigration
    && !deployment.migrations.includes(playbackPositionMigration)
    && !playbackPositionColumnPresent()) {
  deployment = {
    ...deployment,
    migrations: [playbackPositionMigration, ...deployment.migrations],
  };
}

const applied = [];
const skipped = [];
for (const migration of deployment.migrations) {
  const migrationName = basename(migration);
  if (migrationName === '026_remove_apple_music_compatibility.sql'
      && !appleMusicCompatibilityPresent()) {
    skipped.push(migration);
    continue;
  }
  if (migrationName === '036_minute_fact_playback_position.sql'
      && playbackPositionColumnPresent()) {
    skipped.push(migration);
    continue;
  }
  const migrationPath = resolve(repositoryRoot, migration);
  wrangler([
    'd1', 'execute', databaseName,
    '--remote', '--yes',
    '--file', migrationPath,
  ]);
  applied.push(migration);
}

console.log(JSON.stringify({
  ok: true,
  binding: descriptor.binding,
  database_name: databaseName,
  schema: descriptor.schema,
  migrations_applied: applied,
  migrations_skipped: skipped,
  mode: deployment.mode,
}));
