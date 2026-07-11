import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workerRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(workerRoot, '..');
const configPath = resolve(workerRoot, 'wrangler.jsonc');
const schemaPath = resolve(repositoryRoot, 'database/facts-migrations/001_initial_schema.sql');
const metadataPath = resolve(repositoryRoot, 'database/facts-db.json');
const databaseName = process.env.FACTS_DATABASE_NAME || 'sh-monitor-facts';

if (!process.env.CLOUDFLARE_API_TOKEN) {
  throw new Error('CLOUDFLARE_API_TOKEN is required');
}
if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.warn('CLOUDFLARE_ACCOUNT_ID is not set; Wrangler will infer the account from the API token.');
}

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: workerRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function parseJsonOutput(output) {
  const trimmed = String(output || '').trim();
  const starts = [trimmed.indexOf('['), trimmed.indexOf('{')].filter((index) => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0) throw new Error(`Wrangler did not return JSON: ${trimmed.slice(0, 300)}`);
  return JSON.parse(trimmed.slice(start));
}

function readConfig() {
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

function bindingFrom(config) {
  return (Array.isArray(config.d1_databases) ? config.d1_databases : [])
    .find((entry) => entry.binding === 'FACTS_DB');
}

const databases = parseJsonOutput(wrangler(['d1', 'list', '--json']));
let database = databases.find((item) => item.name === databaseName);
let config = readConfig();

if (!database) {
  wrangler([
    'd1', 'create', databaseName,
    '--binding', 'FACTS_DB',
    '--update-config',
    '--config', configPath,
  ]);
  config = readConfig();
  const generated = bindingFrom(config);
  if (!generated?.database_id) {
    throw new Error(`Wrangler created ${databaseName} but did not write the FACTS_DB binding`);
  }
  database = {
    name: databaseName,
    uuid: generated.database_id,
  };
}

const databaseId = database.uuid || database.id || database.database_id;
if (!databaseId) throw new Error(`Could not determine database id for ${databaseName}`);

const bindings = Array.isArray(config.d1_databases) ? config.d1_databases : [];
const nextBinding = {
  binding: 'FACTS_DB',
  database_name: databaseName,
  database_id: databaseId,
};
const index = bindings.findIndex((item) => item.binding === 'FACTS_DB');
if (index >= 0) bindings[index] = nextBinding;
else bindings.push(nextBinding);
config.d1_databases = bindings;
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

wrangler([
  'd1', 'execute', databaseName,
  '--remote', '--yes',
  '--file', schemaPath,
]);

writeFileSync(metadataPath, `${JSON.stringify({
  binding: 'FACTS_DB',
  database_name: databaseName,
  database_id: databaseId,
  schema: 'database/facts-migrations/001_initial_schema.sql',
}, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, database_name: databaseName, database_id: databaseId }));
