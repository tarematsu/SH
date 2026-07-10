import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkerSource = await readFile(
  path.join(repositoryRoot, 'scripts', 'check-js-syntax.mjs'),
  'utf8',
);

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8' });
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'sh-js-check-'));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'worker', 'src'), { recursive: true });
  await writeFile(path.join(root, 'scripts', 'check-js-syntax.mjs'), checkerSource);
  await writeFile(path.join(root, 'worker', 'src', 'valid.js'), 'export const valid = true;\n');

  const initialized = run('git', ['init', '--quiet'], root);
  assert.equal(initialized.status, 0, initialized.stderr);
  const staged = run('git', ['add', '.'], root);
  assert.equal(staged.status, 0, staged.stderr);
  return root;
}

test('scoped syntax check works when invoked from a package directory', async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = run(
    process.execPath,
    ['../scripts/check-js-syntax.mjs', 'worker/src'],
    path.join(root, 'worker'),
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Checked 1 JavaScript file/);
});

test('scoped syntax check fails when a requested root does not exist', async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = run(
    process.execPath,
    ['scripts/check-js-syntax.mjs', 'worker/missing'],
    root,
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JavaScript syntax check root not found: worker\/missing/);
});
