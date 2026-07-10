import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';

const defaultRoots = ['collector', 'scraper', 'worker', 'site', 'tools', 'scripts', 'tests'];
const requestedRoots = process.argv.slice(2);
const roots = requestedRoots.length ? requestedRoots : defaultRoots;

const repo = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (repo.status !== 0) {
  process.stderr.write(repo.stderr || 'git rev-parse failed\n');
  process.exit(repo.status || 1);
}

const repoRoot = repo.stdout.trim();
const listed = spawnSync('git', ['ls-files', '--', ...roots], {
  cwd: repoRoot,
  encoding: 'utf8',
});

if (listed.status !== 0) {
  process.stderr.write(listed.stderr || 'git ls-files failed\n');
  process.exit(listed.status || 1);
}

const files = listed.stdout
  .split(/\r?\n/)
  .filter((file) => /\.(?:mjs|js)$/.test(file))
  .filter((file) => existsSync(resolve(repoRoot, file)))
  .filter((file) => !file.includes('/node_modules/'))
  .sort();

const failures = [];
let cursor = 0;

async function checkNext() {
  while (cursor < files.length) {
    const file = files[cursor];
    cursor += 1;
    const failure = await new Promise((resolveFailure) => {
      const child = spawn(process.execPath, ['--check', file], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => resolveFailure({
        file,
        stdout,
        stderr: `${stderr}${error.stack || error.message}\n`,
      }));
      child.on('close', (code) => resolveFailure(code === 0 ? null : { file, stdout, stderr }));
    });
    if (failure) failures.push(failure);
  }
}

const concurrency = Math.min(8, Math.max(1, availableParallelism()), files.length || 1);
await Promise.all(Array.from({ length: concurrency }, () => checkNext()));

if (failures.length) {
  failures.sort((a, b) => a.file.localeCompare(b.file));
  for (const failure of failures) {
    process.stderr.write(`JavaScript syntax check failed: ${failure.file}\n`);
    process.stderr.write(failure.stdout);
    process.stderr.write(failure.stderr);
  }
  process.exit(1);
}

console.log(`Checked ${files.length} JavaScript files with ${concurrency} workers.`);
