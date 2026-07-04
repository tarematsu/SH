import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const productionBranch = 'main';
const currentBranch = process.env.CF_PAGES_BRANCH;
const force = String(process.env.D1_MIGRATION_FORCE || '').toLowerCase() === 'true';
const migrationName = String(process.env.D1_MIGRATION_NAME || '').trim();
const target = process.env.D1_MIGRATION_TARGET === 'local' ? 'local' : 'remote';

if (!force && currentBranch !== productionBranch) {
  console.log(`D1 migrations skipped: CF_PAGES_BRANCH=${currentBranch || '(not set)'}`);
  process.exit(0);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const siteDirectory = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(siteDirectory, '..');
const wranglerConfigPath = path.join(siteDirectory, 'wrangler.jsonc');
const wranglerExecutable = process.platform === 'win32'
  ? path.join(siteDirectory, 'node_modules', '.bin', 'wrangler.cmd')
  : path.join(siteDirectory, 'node_modules', '.bin', 'wrangler');

if (!existsSync(wranglerExecutable)) {
  console.error('D1 migration failed: Wrangler is not installed in site/node_modules.');
  process.exit(1);
}

const apiToken = process.env.CLOUDFLARE_API_TOKEN
  || process.env.CLOUDFLARE_BUILDS_API_TOKEN
  || '';
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  || process.env.CF_ACCOUNT_ID
  || '';
if (target === 'remote' && !apiToken) {
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
  if (migrationName) {
    if (!/^\d+_[A-Za-z0-9._-]+\.sql$/.test(migrationName) || path.basename(migrationName) !== migrationName) {
      throw new Error(`invalid D1_MIGRATION_NAME=${migrationName}`);
    }
    const sourceMigration = path.join(repositoryRoot, 'database', 'migrations', migrationName);
    if (!existsSync(sourceMigration)) throw new Error(`migration file not found: ${sourceMigration}`);

    const temporaryName = `.single-d1-migration-${process.pid}-${Date.now()}`;
    temporaryDirectory = path.join(siteDirectory, temporaryName);
    temporaryConfigPath = path.join(siteDirectory, `${temporaryName}.jsonc`);
    mkdirSync(temporaryDirectory, { recursive: false });
    copyFileSync(sourceMigration, path.join(temporaryDirectory, migrationName));

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
    configPath = temporaryConfigPath;
    console.log(`Applying exactly one D1 migration: ${migrationName} (${target}).`);
  } else {
    console.log(`Applying every pending D1 migration (${target}).`);
  }

  const args = [
    'd1', 'migrations', 'apply', 'stationhead-monitor',
    target === 'local' ? '--local' : '--remote',
    '--config', configPath,
  ];
  if (target === 'local' && process.env.D1_MIGRATION_PERSIST_TO) {
    args.push('--persist-to', path.resolve(process.env.D1_MIGRATION_PERSIST_TO));
  }

  const result = spawnSync(wranglerExecutable, args, {
    cwd: siteDirectory,
    stdio: 'inherit',
    env: {
      ...process.env,
      CI: 'true',
      ...(apiToken ? { CLOUDFLARE_API_TOKEN: apiToken } : {}),
      ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`D1 migration failed: ${error?.message || error}`);
  process.exitCode = 1;
} finally {
  if (temporaryConfigPath) rmSync(temporaryConfigPath, { force: true });
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}
