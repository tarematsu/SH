import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Pages no longer owns a D1 database. The three current databases are
// provisioned by the Worker jobs, so keeping a Pages-side migration runner
// would target an orphaned schema and recreate the old split-brain ownership.
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const siteDirectory = path.resolve(scriptDirectory, '..');
const wranglerConfigPath = path.join(siteDirectory, 'wrangler.jsonc');
const config = JSON.parse(readFileSync(wranglerConfigPath, 'utf8'));
const pagesOwnedDatabase = (config.d1_databases || []).find(
  (entry) => entry.database_name === 'stationhead-legacy',
);

if (!pagesOwnedDatabase) {
  console.log('D1 migrations skipped: Pages has no owned database; Worker database provisioning is authoritative.');
  process.exit(0);
}

console.error('D1 migration failed: the retired Pages-owned database is not supported.');
process.exit(1);
