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
  assertSchemaVerification,
  parseVerificationRow,
  SCHEMA_VERIFICATION_SQL,
} from './lib/d1-schema-verification.mjs';

const buildContext = cloudflareBuildContext();
skipNonProductionD1Step({
  context: buildContext,
  failurePrefix: 'D1 schema verification failed',
  skippedPrefix: 'D1 schema verification skipped',
});

const {
  siteDirectory,
  wranglerConfigPath,
  wranglerExecutable,
} = scriptPaths(import.meta.url);

assertWranglerInstalled(wranglerExecutable, 'D1 schema verification failed: Wrangler is not installed.');

const { apiToken, accountId } = cloudflareCredentials();
if (!apiToken) {
  if (buildContext.cloudflareBuild && !buildContext.force) {
    console.warn('D1 schema verification skipped: this Cloudflare build has no API token; runtime schema bootstrap will verify availability through live use.');
    process.exit(0);
  }
  console.error('D1 schema verification failed: Cloudflare API token is missing.');
  process.exit(1);
}

const result = spawnWrangler({
  executable: wranglerExecutable,
  args: [
    'd1', 'execute', 'stationhead-monitor', '--remote', '--config', wranglerConfigPath,
    '--command', SCHEMA_VERIFICATION_SQL, '--json',
  ],
  cwd: siteDirectory,
  env: wranglerEnvironment({ apiToken, accountId }),
});

if (result.status !== 0) {
  console.error(result.stderr || result.stdout || `Wrangler exited ${result.status}`);
  process.exit(result.status ?? 1);
}

try {
  assertSchemaVerification(parseVerificationRow(result.stdout));
} catch (error) {
  console.error(`D1 schema verification failed: ${error?.message || error}`);
  process.exit(1);
}
console.log('Remote D1 schema verification completed successfully.');
