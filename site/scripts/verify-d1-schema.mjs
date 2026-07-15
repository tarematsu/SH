import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Schema verification is performed by the current Worker database jobs. A
// Pages-side verifier must not query the retired monolithic database.
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const siteDirectory = path.resolve(scriptDirectory, '..');
const wranglerConfigPath = path.join(siteDirectory, 'wrangler.jsonc');
const config = JSON.parse(readFileSync(wranglerConfigPath, 'utf8'));
const pagesOwnedDatabase = (config.d1_databases || []).find(
  (entry) => entry.database_name === 'stationhead-legacy',
);

if (!pagesOwnedDatabase) {
  console.log('D1 schema verification skipped: Pages has no owned database; Worker database jobs verify the current schemas.');
  process.exit(0);
}

console.error('D1 schema verification failed: the retired Pages-owned database is not supported.');
process.exit(1);
