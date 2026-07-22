import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const workerRoot = resolve(repositoryRoot, 'worker');
const sharedRoot = resolve(repositoryRoot, 'packages/sh-shared');
const stampPath = resolve(workerRoot, 'node_modules/.sh-worker-deps.sha256');

function trackedFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (path) => {
    for (const entry of readdirSync(path).sort()) {
      if (entry === 'node_modules') continue;
      const child = resolve(path, entry);
      if (statSync(child).isDirectory()) visit(child);
      else files.push(child);
    }
  };
  visit(root);
  return files;
}

function dependencyHash() {
  const hash = createHash('sha256');
  for (const path of [
    resolve(workerRoot, 'package-lock.json'),
    ...trackedFiles(sharedRoot),
  ]) {
    hash.update(path.slice(repositoryRoot.length));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const expected = dependencyHash();
const installed = existsSync(resolve(workerRoot, 'node_modules/wrangler/package.json'))
  && existsSync(resolve(workerRoot, 'node_modules/sh-shared/package.json'));
const current = existsSync(stampPath) ? readFileSync(stampPath, 'utf8').trim() : '';

if (installed && current === expected) {
  console.log('Reusing cached Worker integration dependencies.');
  process.exit(0);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['ci', '--prefer-offline', '--no-audit', '--no-fund'], {
  cwd: workerRoot,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

writeFileSync(stampPath, `${expected}\n`);
console.log('Installed and stamped Worker integration dependencies.');
