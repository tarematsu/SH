import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const productionBranch = 'main';
const currentBranch = process.env.CF_PAGES_BRANCH;
const migrationName = String(process.env.D1_MIGRATION_NAME || '').trim();
const target = process.env.D1_MIGRATION_TARGET === 'local' ? 'local' : 'remote';

if (currentBranch !== productionBranch) {
  console.log(`D1 migration skipped: CF_PAGES_BRANCH=${currentBranch || '(not set)'}`);
  process.exit(0);
}

if (!migrationName) {
  console.log('D1 migration skipped: D1_MIGRATION_NAME is not set. No pending migrations were applied.');
  process.exit(0);
}

if (!/^\d+_[A-Za-z0-9._-]+\.sql$/.test(migrationName) || path.basename(migrationName) !== migrationName) {
  console.error(`D1 migration failed: invalid D1_MIGRATION_NAME=${migrationName}`);
  process.exit(1);
}

if (target === 'remote') {
  for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    if (!process.env[name]) {
      console.error(`D1 migration failed: ${name} is not configured.`);
      process.exit(1);
    }
  }
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const siteDirectory = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(siteDirectory, '..');
const sourceMigration = path.join(repositoryRoot, 'database', 'migrations', migrationName);
const wranglerConfigPath = path.join(siteDirectory, 'wrangler.jsonc');
const wranglerExecutable = process.platform === 'win32'
  ? path.join(siteDirectory, 'node_modules', '.bin', 'wrangler.cmd')
  : path.join(siteDirectory, 'node_modules', '.bin', 'wrangler');

if (!existsSync(sourceMigration)) {
  console.error(`D1 migration failed: migration file not found: ${sourceMigration}`);
  process.exit(1);
}
if (!existsSync(wranglerExecutable)) {
  console.error('D1 migration failed: Wrangler is not installed in site/node_modules.');
  process.exit(1);
}

const baseConfig = JSON.parse(readFileSync(wranglerConfigPath, 'utf8'));
const database = baseConfig.d1_databases?.find((entry) => entry.database_name === 'stationhead-monitor');
if (!database) {
  console.error('D1 migration failed: stationhead-monitor D1 binding is missing.');
  process.exit(1);
}

const temporaryDirectoryName = `.single-d1-migration-${process.pid}-${Date.now()}`;
const temporaryDirectory = path.join(siteDirectory, temporaryDirectoryName);
const temporaryConfigPath = path.join(siteDirectory, `${temporaryDirectoryName}.jsonc`);

try {
  mkdirSync(temporaryDirectory, { recursive: false });
  copyFileSync(sourceMigration, path.join(temporaryDirectory, migrationName));

  const temporaryConfig = {
    ...baseConfig,
    d1_databases: baseConfig.d1_databases.map((entry) => (
      entry.database_name === 'stationhead-monitor'
        ? { ...entry, migrations_dir: temporaryDirectoryName }
        : entry
    )),
  };
  writeFileSync(temporaryConfigPath, `${JSON.stringify(temporaryConfig, null, 2)}\n`, 'utf8');

  const args = [
    'd1', 'migrations', 'apply', 'stationhead-monitor',
    target === 'local' ? '--local' : '--remote',
    '--config', temporaryConfigPath,
  ];
  if (target === 'local' && process.env.D1_MIGRATION_PERSIST_TO) {
    args.push('--persist-to', path.resolve(process.env.D1_MIGRATION_PERSIST_TO));
  }

  console.log(`Applying exactly one D1 migration: ${migrationName} (${target})`);
  const result = spawnSync(wranglerExecutable, args, {
    cwd: siteDirectory,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' },
  });

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporaryConfigPath, { force: true });
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
