import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(workerDirectory, '..');
const outputPath = path.join(workerDirectory, 'src', 'sh-refactor-report.generated.js');
const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  '.wrangler',
  'dist',
  'dist-dry-run',
  'coverage',
  '.leaderboard-capture-browser',
  '.profile-capture-browser',
  'captures',
]);
const ignoredFiles = new Set([
  '.github/workflows/sh-refactor-scan.yml',
  'site/scripts/build-sh-refactor-report.mjs',
  'worker/scripts/build-sh-refactor-report.mjs',
  'worker/src/sh-refactor-report.generated.js',
]);
const identifierPattern = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
const fragmentPattern = /[A-Za-z0-9_@.:/\\-]*stationhead[A-Za-z0-9_@.:/\\-]*/gi;
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
    if (!entry.isFile() || ignoredFiles.has(relative)) continue;
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
    const fragments = [...new Set(text.match(fragmentPattern) || [])]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    if (counts.size || fragments.length) {
      contentHits.push({
        path: relative,
        identifiers: [...counts.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        fragments,
      });
    }
  }
}

walk(repositoryRoot);
pathHits.sort();
contentHits.sort((a, b) => a.path.localeCompare(b.path));
const report = { pathHits, contentHits };
const serialized = JSON.stringify(report);
writeFileSync(
  outputPath,
  `export default Object.freeze(${serialized});\n`,
  'utf8',
);
console.log('SH_REFACTOR_REPORT_BEGIN');
console.log(serialized);
console.log('SH_REFACTOR_REPORT_END');
console.log(`SH refactor Worker report: ${pathHits.length} paths, ${contentHits.length} files`);
