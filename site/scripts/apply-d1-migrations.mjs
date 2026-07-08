import { rmSync } from 'node:fs';
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
import {
  assertSafeMigrationNumbering,
  createSingleMigrationConfig,
  migrationApplyArgs,
} from './lib/d1-migration-plan.mjs';

const migrationName = String(process.env.D1_MIGRATION_NAME || '').trim();
const target = process.env.D1_MIGRATION_TARGET === 'local' ? 'local' : 'remote';
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
  assertSafeMigrationNumbering({ migrationsDirectory });
  if (migrationName) {
    const temporary = createSingleMigrationConfig({
      siteDirectory,
      wranglerConfigPath,
      migrationsDirectory,
      migrationName,
    });
    configPath = temporary.configPath;
    temporaryConfigPath = temporary.temporaryConfigPath;
    temporaryDirectory = temporary.temporaryDirectory;
    console.log(`Applying exactly one D1 migration: ${migrationName} (${target}).`);
  } else {
    console.log(`Applying every pending D1 migration (${target}).`);
  }

  const result = spawnWrangler({
    executable: wranglerExecutable,
    args: migrationApplyArgs({ target, configPath }),
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
