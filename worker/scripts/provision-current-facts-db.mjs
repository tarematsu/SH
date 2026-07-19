import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workerRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(workerRoot, '..');
const descriptorPath = resolve(repositoryRoot, 'database/facts-db.json');
const provisionScript = resolve(import.meta.dirname, 'provision-facts-db.mjs');
const currentSchemaScript = resolve(import.meta.dirname, 'apply-facts-pr-schema.mjs');
const originalDescriptorText = readFileSync(descriptorPath, 'utf8');
const originalDescriptor = JSON.parse(originalDescriptorText);

if (!originalDescriptor.schema) {
  throw new Error('current facts schema descriptor is missing');
}

function run(script) {
  execFileSync(process.execPath, [script], {
    cwd: workerRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: 'inherit',
  });
}

try {
  run(provisionScript);
  // The compatibility provisioner still owns the full historical bootstrap and
  // writes its last embedded migration back to the descriptor. Restore the
  // checked-in current descriptor before applying the newest idempotent schema.
  writeFileSync(descriptorPath, originalDescriptorText);
  run(currentSchemaScript);
} finally {
  writeFileSync(descriptorPath, originalDescriptorText);
}

console.log(JSON.stringify({
  ok: true,
  database_name: originalDescriptor.database_name,
  schema: originalDescriptor.schema,
  mode: 'historical-bootstrap-plus-current-schema',
}));
