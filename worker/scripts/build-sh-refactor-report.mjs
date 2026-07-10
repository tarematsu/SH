import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(workerDirectory, '..');
const outputPath = path.join(workerDirectory, 'src', 'sh-refactor-report.generated.js');
const ignoredDirectories = new Set(['.git', 'node_modules', '.wrangler', 'dist', 'dist-dry-run', 'coverage']);
const identifierPattern = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
const pathHits = [];
const contentHits = [];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(repositoryRoot, absolute).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      walk(absolute);
      continue;
    }
    if (!entry.isFile()) continue;
    if (/stationhead/i.test(relative)) pathHits.push(relative);
    const size = statSync(absolute).size;
    if (size > 2_000_000) continue;
    let buffer;
    try {
      buffer = readFileSync(absolute);
    } catch {
      continue;
    }
    if (buffer.subarray(0, 8192).includes(0)) continue;
    const text = buffer.toString('utf8');
    const counts = new Map();
    for (const token of text.match(identifierPattern) || []) {
      if (!/stationhead/i.test(token)) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
    if (counts.size) {
      contentHits.push({
        path: relative,
        identifiers: [...counts.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
  }
}

walk(repositoryRoot);
pathHits.sort();
contentHits.sort((a, b) => a.path.localeCompare(b.path));
writeFileSync(
  outputPath,
  `export default Object.freeze(${JSON.stringify({ pathHits, contentHits })});\n`,
  'utf8',
);
console.log(`SH refactor Worker report: ${pathHits.length} paths, ${contentHits.length} files`);
