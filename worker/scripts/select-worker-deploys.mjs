import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const workerRoot = resolve(repositoryRoot, 'worker');

const workerDefinitions = [
  { name: 'sh-minute-derive', config: 'worker/wrangler.minute-derive.jsonc', command: 'deploy:minute-derive' },
  { name: 'sh-minute-maintenance', config: 'worker/wrangler.minute.jsonc', command: 'deploy:minute-maintenance' },
  { name: 'sh-minute-ingest', config: 'worker/wrangler.minute-ingest.jsonc', command: 'deploy:minute-ingest' },
  { name: 'sh-minute-read-model', config: 'worker/wrangler.read-model.jsonc', command: 'deploy:minute-read-model' },
  { name: 'sh-comments', config: 'worker/wrangler.comments.jsonc', command: 'deploy:comments' },
  { name: 'sh-ingest-channel', config: 'worker/wrangler.ingest.jsonc', command: 'deploy:ingest' },
  { name: 'sh-monitor-buddies', config: 'worker/wrangler.jsonc', command: 'deploy:buddies' },
  { name: 'sh-pages-read-model', config: 'worker/wrangler.pages-read-model.jsonc', command: 'deploy:pages-read-model' },
  { name: 'sh-monitor-maintenance', config: 'worker/wrangler.monitor-maintenance.jsonc', command: 'deploy:monitor-maintenance' },
  { name: 'sh-monitor-other', config: 'worker/wrangler.other.jsonc', command: 'deploy:other' },
];

export const gitConnectedWorkers = Object.freeze([
  'sh-monitor-buddies',
  'sh-monitor-other',
  'sh-minute-maintenance',
]);
const gitConnectedWorkerSet = new Set(gitConnectedWorkers);

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
  if (specifier === 'sh-shared') {
    return resolve(repositoryRoot, 'packages/sh-shared/index.mjs');
  }
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

function affectedByPath(definition, changedPath) {
  if (changedPath === definition.config) return true;
  if (changedPath.startsWith('packages/sh-shared/')) {
    return [...definition.dependencies].some((dependency) => dependency.startsWith('packages/sh-shared/'));
  }
  return definition.dependencies.has(changedPath);
}

export function workerBuildWatchPaths(workerName) {
  const definition = definitions.find(({ name }) => name === workerName);
  if (!definition) throw new Error(`Unknown Worker: ${workerName}`);
  return [...new Set([
    definition.config,
    ...definition.dependencies,
    'worker/package.json',
    'worker/package-lock.json',
    'worker/scripts/select-cloudflare-build-config.mjs',
  ])].sort();
}

export function connectedWorkerBuildWatchConfig() {
  return Object.fromEntries(gitConnectedWorkers.map((name) => [name, workerBuildWatchPaths(name)]));
}

export function selectWorkersForPaths(inputPaths = [], options = {}) {
  const paths = [...new Set(inputPaths.map(normalizeChangedPath).filter(Boolean))];
  const selected = new Set();

  if (options.all === true) {
    for (const definition of definitions) selected.add(definition.name);
  } else {
    for (const changedPath of paths) {
      if (/^worker\/package(?:-lock)?\.json$/.test(changedPath)) {
        for (const definition of definitions) selected.add(definition.name);
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
        // A deleted or newly introduced runtime module may not be reachable from
        // the current import graph. Fall back to all Workers rather than miss a
        // production deploy.
        for (const definition of definitions) selected.add(definition.name);
      }

      if (!matched && /^worker\/wrangler.*\.jsonc$/.test(changedPath)) {
        for (const definition of definitions) selected.add(definition.name);
      }
    }
  }

  const workers = definitions.filter((definition) => selected.has(definition.name));
  return {
    changed_paths: paths,
    workers: workers.map((definition) => definition.name),
    commands: workers.map((definition) => definition.command),
    diagnostics: workers
      .map((definition) => definition.name)
      .filter((name) => gitConnectedWorkerSet.has(name)),
  };
}

function readChangedPaths() {
  if (process.argv.includes('--all')) return { all: true, paths: [] };
  const input = readFileSync(0, 'utf8');
  return {
    all: false,
    paths: input.split(/\r?\n/).map(normalizeChangedPath).filter(Boolean),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const changed = readChangedPaths();
  process.stdout.write(`${JSON.stringify(selectWorkersForPaths(changed.paths, { all: changed.all }))}\n`);
}
