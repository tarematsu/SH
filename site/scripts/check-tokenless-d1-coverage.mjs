import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertRuntimeMigrationCoverage } from './d1-runtime-coverage.mjs';

const cloudflareBuild = process.env.CF_PAGES === '1' || process.env.WORKERS_CI === '1';
const currentBranch = process.env.CF_PAGES_BRANCH || process.env.WORKERS_CI_BRANCH || '';
const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_BUILDS_API_TOKEN || '';
const force = String(process.env.D1_MIGRATION_FORCE || '').toLowerCase() === 'true';

if (!cloudflareBuild || currentBranch !== 'main' || apiToken || force) {
  console.log('Tokenless D1 coverage check skipped.');
  process.exit(0);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');

try {
  assertRuntimeMigrationCoverage(repositoryRoot);
  console.log('Tokenless D1 coverage check completed successfully.');
} catch (error) {
  console.error(`Tokenless D1 coverage check failed: ${error?.message || error}`);
  process.exit(1);
}
