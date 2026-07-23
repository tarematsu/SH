import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const workerRoot = resolve(repositoryRoot, 'worker');

const workerDefinitions = [
  { name: 'sh-sakurazaka46jp', config: 'worker/wrangler.sakurazaka46jp.jsonc', command: 'deploy:sakurazaka46jp' },
  { name: 'sh-buddies-collector', config: 'worker/wrangler.buddies-collector.jsonc', command: 'deploy:buddies-collector' },
  { name: 'sh-runtime-orchestrator', config: 'worker/wrangler.runtime.jsonc', command: 'deploy:runtime' },
];

const gitConnectedWorkers = new Set(['sh-runtime-orchestrator']);
const collectorWorker = 'sh-buddies-collector';
const runtimeWorker = 'sh-runtime-orchestrator';

const deployScriptWorkers = new Map([
  ['worker/scripts/deploy-buddies-collector.mjs', collectorWorker],
  ['worker/scripts/deploy-runtime.mjs', runtimeWorker],
  ['worker/scripts/pages-response-kv-namespace.mjs', runtimeWorker],
  ['worker/scripts/provision-runtime-analytics-pipeline.mjs', runtimeWorker],
  ['worker/scripts/deploy-sakurazaka46jp.mjs', 'sh-sakurazaka46jp'],
]);

const allWorkerDeployScripts = new Set([
  'worker/scripts/cloudflare-build-config.mjs',
  'worker/scripts/cloudflare-queues.mjs',
  'worker/scripts/cloudflare-workers.mjs',
  'worker/scripts/deploy-connected-worker.mjs',
  'worker/scripts/select-worker-deploys.mjs',
  'worker/scripts/wrangler-command.mjs',
  'worker/package.json',
]);

function repositoryPath(path) {
  return relative(repositoryRoot, path).split(sep).join('/');
}

function configMain(configPath) {
  const source = readFileSync(resolve(repositoryRoot, configPath), 'utf8');
  const match = source.match(/"main"\s*:\s*"([^"]+)"/);
  if (!match) throw new Error(`Worker main is missing from ${configPath}`);
  return resolve(workerRoot, match[1]);
}

function existingModule(path) {
  const candidates = extname(path)
    ? [path]
    : [path, `${path}.js`, `${path}.mjs`, resolve(path, 'index.js'), resolve(path, 'index.mjs')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) || null;
}

function importedSpecifiers(source) {
  const result = [];
  const patterns = [
    /(?:import|export)\s+(?:[^'\"]*?\s+from\s*)?['\"]([^'\"]+)['\"]/g,
    /import\s*\(\s*['\"]([^'\"]+)['\"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) result.push(match[1]);
  }
  return result;
}

function resolveImport(importer, specifier) {
  if (specifier === 'sh-shared') return resolve(repositoryRoot, 'packages/sh-shared/index.mjs');
  if (!specifier.startsWith('.')) return null;
  return existingModule(resolve(dirname(importer), specifier));
}

function dependencySet(entrypoint) {
  const pending = [entrypoint];
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (!current || visited.has(current) || !existsSync(current)) continue;
    visited.add(current);
    const source = readFileSync(current, 'utf8');
    for (const specifier of importedSpecifiers(source)) {
      const imported = resolveImport(current, specifier);
      if (imported && !visited.has(imported)) pending.push(imported);
    }
  }
  return new Set([...visited].map(repositoryPath));
}

const definitions = workerDefinitions.map((definition) => ({
  ...definition,
  dependencies: dependencySet(configMain(definition.config)),
}));

function normalizeChangedPath(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

function readChangedPaths() {
  if (process.argv.includes('--all')) return { all: true, paths: [] };
  const input = readFileSync(0, 'utf8');
  return {
    all: false,
    paths: [...new Set(input.split(/\r?\n/).map(normalizeChangedPath).filter(Boolean))],
  };
}

function affectedByPath(definition, changedPath) {
  if (changedPath === definition.config) return true;
  if (definition.name === runtimeWorker && changedPath.startsWith('worker/pipelines/')) {
    return true;
  }
  if (changedPath.startsWith('packages/sh-shared/')) {
    return [...definition.dependencies].some((dependency) => dependency.startsWith('packages/sh-shared/'));
  }
  return definition.dependencies.has(changedPath);
}

function changesMinuteDbSchema(changedPath) {
  return changedPath === 'database/facts-db.json'
    || changedPath.startsWith('database/facts-migrations/');
}

const changed = readChangedPaths();
const selected = new Set();

if (changed.all) {
  for (const definition of definitions) selected.add(definition.name);
} else {
  for (const changedPath of changed.paths) {
    if (changedPath === 'worker/package-lock.json' || allWorkerDeployScripts.has(changedPath)) {
      for (const definition of definitions) selected.add(definition.name);
      continue;
    }

    if (changesMinuteDbSchema(changedPath)) {
      selected.add(runtimeWorker);
      continue;
    }

    const deployWorker = deployScriptWorkers.get(changedPath);
    if (deployWorker) {
      selected.add(deployWorker);
      continue;
    }

    let matched = false;
    for (const definition of definitions) {
      if (affectedByPath(definition, changedPath)) {
        selected.add(definition.name);
        matched = true;
      }
    }

    if (!matched
        && changedPath.startsWith('worker/src/')
        && !changedPath.startsWith('worker/src/__fixtures__/')) {
      for (const definition of definitions) selected.add(definition.name);
    }

    if (!matched && /^worker\/wrangler.*\.jsonc$/.test(changedPath)) {
      for (const definition of definitions) selected.add(definition.name);
    }
  }
}

const workers = definitions.filter((definition) => selected.has(definition.name));
process.stdout.write(`${JSON.stringify({
  changed_paths: changed.paths,
  workers: workers.map((definition) => definition.name),
  commands: workers.map((definition) => definition.command),
  diagnostics: workers
    .map((definition) => definition.name)
    .filter((name) => gitConnectedWorkers.has(name)),
})}\n`);
