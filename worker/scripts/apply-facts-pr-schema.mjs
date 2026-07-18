import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workerRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(workerRoot, '..');
const wranglerScript = resolve(workerRoot, 'node_modules/wrangler/bin/wrangler.js');
const descriptorPath = resolve(repositoryRoot, 'database/facts-db.json');
const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
const databaseName = process.env.FACTS_DATABASE_NAME || descriptor.database_name;
const schemaPath = resolve(repositoryRoot, descriptor.schema || '');

if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is required');
if (!databaseName) throw new Error('facts database name is missing');
if (!descriptor.schema) throw new Error('facts schema descriptor is missing');

execFileSync(process.execPath, [
  wranglerScript,
  'd1', 'execute', databaseName,
  '--remote', '--yes',
  '--file', schemaPath,
], {
  cwd: workerRoot,
  env: process.env,
  encoding: 'utf8',
  stdio: 'inherit',
});

console.log(JSON.stringify({
  ok: true,
  database_name: databaseName,
  schema: descriptor.schema,
  mode: 'current-schema-only',
}));
