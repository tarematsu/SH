import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  assertWranglerInstalled,
  cloudflareBuildContext,
  cloudflareCredentials,
  scriptPaths,
  skipNonProductionD1Step,
  spawnWrangler,
  wranglerEnvironment,
} from './lib/d1-script-common.mjs';

const migrationName = String(process.env.D1_MIGRATION_NAME || '').trim();
const target = process.env.D1_MIGRATION_TARGET === 'local' ? 'local' : 'remote';
const grandfatheredDuplicateGroups = new Set([
  '005_cloud_host_monitor.sql|005_weekly_summary_foundation.sql',
  '008_buddy_auth_control.sql|008_runtime_query_indexes.sql',
  '019_collector_failure_diagnostics.sql|019_comment_counts.sql',
]);

const buildContext = cloudflareBuildContext();
skipNonProductionD1Step({
  context: buildContext,
  failurePrefix: 'D1 migration failed',
  skippedPrefix: 'D1 migrations skipped',
});

const {
  siteDirectory,
  repositoryRoot,
  wranglerConfigPath,
  wranglerExecutable,
} = scriptPaths(import.meta.url);
const migrationsDirectory = path.join(repositoryRoot, 'database', 'migrations');

function assertSafeMigrationNumbering() {
  const files = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+_[A-Za-z0-9._-]+\.sql$/.test(name))
    .sort();
  const byNumber = new Map();
  for (const file of files) {
    const number = file.match(/^(\d+)_/)?.[1];
    if (!number) continue;
    const group = byNumber.get(number) || [];
    group.push(file);
    byNumber.set(number, group);
  }
  const unexpected = [...byNumber.entries()]
    .filter(([, filesForNumber]) => filesForNumber.length > 1)
    .filter(([, filesForNumber]) => !grandfatheredDuplicateGroups.has([...filesForNumber].sort().join('|')));
  if (unexpected.length) {
    const details = unexpected
      .map(([number, filesForNumber]) => `${number}: ${filesForNumber.join(', ')}`)
      .join('; ');
    throw new Error(`unsafe duplicate D1 migration numbers detected: ${details}`);
  }
}

function createSingleMigrationConfig(configPath, singleMigrationName) {
  if (!/^\d+_[A-Za-z0-9._-]+\.sql$/.test(singleMigrationName) || path.basename(singleMigrationName) !== singleMigrationName) {
    throw new Error(`invalid D1_MIGRATION_NAME=${singleMigrationName}`);
  }
  const sourceMigration = path.join(migrationsDirectory, singleMigrationName);
  if (!existsSync(sourceMigration)) throw new Error(`migration file not found: ${sourceMigration}`);

  const temporaryName = `.single-d1-migration-${process.pid}-${Date.now()}`;
  const temporaryDirectory = path.join(siteDirectory, temporaryName);
  const temporaryConfigPath = path.join(siteDirectory, `${temporaryName}.jsonc`);
  mkdirSync(temporaryDirectory, { recursive: false });
  copyFileSync(sourceMigration, path.join(temporaryDirectory, singleMigrationName));

  const baseConfig = JSON.parse(readFileSync(wranglerConfigPath, 'utf8'));
  const temporaryConfig = {
    ...baseConfig,
    d1_databases: baseConfig.d1_databases.map((entry) => (
      entry.database_name === 'stationhead-monitor'
        ? { ...entry, migrations_dir: temporaryName }
        : entry
    )),
  };
  writeFileSync(temporaryConfigPath, `${JSON.stringify(temporaryConfig, null, 2)}\n`, 'utf8');
  return { configPath: temporaryConfigPath, temporaryConfigPath, temporaryDirectory };
}

function migrationArgs(configPath) {
  const args = [
    'd1', 'migrations', 'apply', 'stationhead-monitor',
    target === 'local' ? '--local' : '--remote',
    '--config', configPath,
  ];
  if (target === 'local' && process.env.D1_MIGRATION_PERSIST_TO) {
    args.push('--persist-to', path.resolve(process.env.D1_MIGRATION_PERSIST_TO));
  }
  return args;
}

assertWranglerInstalled(wranglerExecutable, 'D1 migration failed: Wrangler is not installed in site/node_modules.');

const { apiToken, accountId } = cloudflareCredentials();
if (target === 'remote' && !apiToken) {
  if (buildContext.cloudflareBuild && !buildContext.force) {
    console.warn('D1 migrations skipped: this Cloudflare build has no API token; runtime schema bootstrap and the manual migration workflow remain available.');
    process.exit(0);
  }
  console.error('D1 migration failed: configure CLOUDFLARE_API_TOKEN or CLOUDFLARE_BUILDS_API_TOKEN.');
  process.exit(1);
}
if (target === 'remote' && !accountId) {
  console.warn('CLOUDFLARE_ACCOUNT_ID is not set; Wrangler will try to infer the account from the API token.');
}

let configPath = wranglerConfigPath;
let temporaryDirectory = null;
let temporaryConfigPath = null;

try {
  assertSafeMigrationNumbering();
  if (migrationName) {
    const temporary = createSingleMigrationConfig(configPath, migrationName);
    configPath = temporary.configPath;
    temporaryConfigPath = temporary.temporaryConfigPath;
    temporaryDirectory = temporary.temporaryDirectory;
    console.log(`Applying exactly one D1 migration: ${migrationName} (${target}).`);
  } else {
    console.log(`Applying every pending D1 migration (${target}).`);
  }

  const result = spawnWrangler({
    executable: wranglerExecutable,
    args: migrationArgs(configPath),
    cwd: siteDirectory,
    stdio: 'inherit',
    env: wranglerEnvironment({ apiToken, accountId }),
  });
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`D1 migration failed: ${error?.message || error}`);
  process.exitCode = 1;
} finally {
  if (temporaryConfigPath) rmSync(temporaryConfigPath, { force: true });
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}
