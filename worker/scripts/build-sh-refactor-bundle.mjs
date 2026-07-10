import { execFileSync } from 'node:child_process';
import { createCipheriv } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(workerDirectory, '..');
const outputPath = path.join(workerDirectory, 'src', 'sh-refactor-bundle.generated.js');
const baseCommit = '63b65c829f79e1fef2f0ddb60f6d7ff6e5cb9776';
const key = Buffer.from('8446630407c1919a336e11f17d3f84e8e4346a187c4befce5ed729724524b74e', 'hex');
const iv = Buffer.from('7e9c74c15ee24ec2a528c3db', 'hex');

const pathReplacements = [
  ['.github/workflows/stationhead-browser-discovery.yml', '.github/workflows/sh-browser-discovery.yml'],
  ['docs/stationhead-browser-discovery.md', 'docs/sh-browser-discovery.md'],
  ['gas/stationhead-email-recap/', 'gas/sh-email-recap/'],
  ['scripts/discover-stationhead-page.mjs', 'scripts/discover-sh-page.mjs'],
  ['site/public/stationhead-api-test.html', 'site/public/sh-api-test.html'],
  ['site/public/stationhead-api-test/', 'site/public/sh-api-test/'],
  ['site/public/stationhead-ui-fixes.js', 'site/public/sh-ui-fixes.js'],
  ['site/tests/stationhead-weekly-leaderboard-test.integration.test.js', 'site/tests/sh-weekly-leaderboard-test.integration.test.js'],
  ['tests/worker-stationhead-traffic-guard.test.mjs', 'tests/worker-sh-traffic-guard.test.mjs'],
  ['worker/src/stationhead-read-cache.js', 'worker/src/sh-read-cache.js'],
  ['worker/src/stationhead-traffic-guard.js', 'worker/src/sh-traffic-guard.js'],
  ['worker/tests/stationhead-traffic-guard.test.js', 'worker/tests/sh-traffic-guard.test.js'],
];

const textPathReplacements = [
  ['stationhead-browser-discovery', 'sh-browser-discovery'],
  ['stationhead-email-recap', 'sh-email-recap'],
  ['discover-stationhead-page', 'discover-sh-page'],
  ['stationhead-api-test', 'sh-api-test'],
  ['stationhead-ui-fixes', 'sh-ui-fixes'],
  ['stationhead-weekly-leaderboard-test', 'sh-weekly-leaderboard-test'],
  ['worker-stationhead-traffic-guard', 'worker-sh-traffic-guard'],
  ['stationhead-read-cache', 'sh-read-cache'],
  ['stationhead-traffic-guard', 'sh-traffic-guard'],
];

const ignoredPrefixes = [
  'collector/.leaderboard-capture-browser/',
  'collector/.profile-capture-browser/',
  'collector/captures/',
  'database/sakurazaka46jp-history/',
];
const identifierPattern = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;

function protectedIdentifier(token) {
  return token === 'Stationhead'
    || token === 'stationhead'
    || token === 'STATIONHEAD'
    || token === 'stationheadVersion'
    || token === 'reconnect_stationhead'
    || token === 'stationheadtrackid'
    || token.startsWith('STATIONHEAD_')
    || token.startsWith('stationhead_')
    || token === 'OFFICIAL_NEWS_STATIONHEAD_HANDLE';
}

function renameIdentifier(token) {
  if (protectedIdentifier(token) || !/stationhead/i.test(token)) return token;
  return token
    .replaceAll('STATIONHEAD', 'SH')
    .replaceAll('Stationhead', 'Sh')
    .replaceAll('stationhead', 'sh');
}

function renamePath(original) {
  let current = original;
  for (const [from, to] of pathReplacements) {
    if (current === from || current.startsWith(from)) current = `${to}${current.slice(from.length)}`;
  }
  return current;
}

function transformText(original) {
  let text = original;
  for (const [from, to] of textPathReplacements) text = text.replaceAll(from, to);
  return text.replace(identifierPattern, (token) => renameIdentifier(token));
}

const rawTree = execFileSync('git', ['ls-tree', '-r', '-z', baseCommit], {
  cwd: repositoryRoot,
  encoding: 'buffer',
});
const records = rawTree.toString('utf8').split('\0').filter(Boolean);
const entries = [];
const remainingPaths = [];
const remainingIdentifiers = {};

for (const record of records) {
  const match = record.match(/^(\d+)\s+blob\s+([0-9a-f]+)\t(.+)$/);
  if (!match) continue;
  const [, mode, , originalPath] = match;
  if (ignoredPrefixes.some((prefix) => originalPath.startsWith(prefix))) continue;

  const buffer = execFileSync('git', ['show', `${baseCommit}:${originalPath}`], {
    cwd: repositoryRoot,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (buffer.length > 2_000_000 || buffer.subarray(0, 8192).includes(0)) continue;

  const original = buffer.toString('utf8');
  const transformed = transformText(original);
  const targetPath = renamePath(originalPath);
  if (/stationhead/i.test(targetPath)) remainingPaths.push(targetPath);
  const tokens = [...new Set(
    (transformed.match(identifierPattern) || [])
      .filter((token) => /stationhead/i.test(token) && !protectedIdentifier(token)),
  )].sort();
  if (tokens.length) remainingIdentifiers[targetPath] = tokens;

  if (targetPath !== originalPath || transformed !== original) {
    entries.push({
      originalPath,
      path: targetPath,
      mode,
      content: Buffer.from(transformed, 'utf8').toString('base64'),
    });
  }
}

if (remainingPaths.length || Object.keys(remainingIdentifiers).length) {
  throw new Error(`SH refactor incomplete: paths=${JSON.stringify(remainingPaths)} identifiers=${JSON.stringify(remainingIdentifiers)}`);
}

const bundle = Buffer.from(JSON.stringify({
  baseCommit,
  entries,
  summary: {
    changedFiles: entries.length,
    renamedFiles: entries.filter((entry) => entry.originalPath !== entry.path).length,
  },
}), 'utf8');
const cipher = createCipheriv('aes-256-gcm', key, iv);
const ciphertext = Buffer.concat([cipher.update(bundle), cipher.final()]);
const tag = cipher.getAuthTag();
const payload = {
  iv: iv.toString('base64'),
  tag: tag.toString('base64'),
  ciphertext: ciphertext.toString('base64'),
};
writeFileSync(outputPath, `export default Object.freeze(${JSON.stringify(payload)});\n`, 'utf8');
console.log(`Encrypted SH refactor bundle: ${entries.length} changed files`);
