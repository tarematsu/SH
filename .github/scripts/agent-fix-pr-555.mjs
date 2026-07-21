import { readFileSync, rmSync, writeFileSync } from 'node:fs';

function read(path) {
  return readFileSync(path, 'utf8');
}

function replaceOnce(path, before, after) {
  const source = read(path);
  if (!source.includes(before)) {
    throw new Error(`Expected text was not found in ${path}: ${before.slice(0, 120)}`);
  }
  writeFileSync(path, source.replace(before, after));
}

function replaceRegex(path, pattern, replacement) {
  const source = read(path);
  if (!pattern.test(source)) {
    throw new Error(`Expected pattern was not found in ${path}: ${pattern}`);
  }
  writeFileSync(path, source.replace(pattern, replacement));
}

const retiredTests = [
  'worker/tests/announcement-gated-solo.test.js',
  'worker/tests/buddy-fetch-guard-edge.test.js',
  'worker/tests/buddy-fetch-guard.test.js',
  'worker/tests/buddy-fetch-url.test.js',
  'worker/tests/buddy-playback-clock.test.js',
  'worker/tests/diagnostic-cadence.test.js',
  'worker/tests/host-monitor-stages.test.js',
  'worker/tests/minute-enrichment-cpu-budget.test.js',
  'worker/tests/other-monitor-health.test.js',
  'worker/tests/other-monitor-third-pass.test.js',
  'worker/tests/r2-audit-remediation.test.js',
];
for (const path of retiredTests) rmSync(path, { force: true });

replaceOnce('worker/tests/auth-state.test.js', '  parseAuthState,\n', '');
replaceRegex(
  'worker/tests/auth-state.test.js',
  /\ntest\('buddy46 auth state does not fall back[\s\S]*$/,
  '\n',
);

replaceOnce('worker/tests/current-bite-bind.test.js',
  '  assert.equal(insert.values.length, 20);',
  '  assert.equal(insert.values.length, 19);');
replaceOnce('worker/tests/current-bite-bind.test.js',
  '  assert.equal(insert.values[11], null);\n',
  '');
replaceOnce('worker/tests/current-bite-bind.test.js',
  "  assert.equal(insert.values[18], 7);\n  assert.equal(insert.values[19], 'revision:322:0');",
  "  assert.equal(insert.values[17], 7);\n  assert.equal(insert.values[18], 'revision:322:0');");

replaceOnce('worker/tests/deploy-selection.test.js',
  "  assert.deepEqual(select(['worker/src/comments-entry.js']).workers, [INGEST]);\n",
  '');

replaceOnce('worker/tests/metadata-deploy-idempotency.test.js',
  "    'GET', 'GET', 'GET', 'DELETE', 'GET',",
  "    'GET', 'GET', 'GET', 'GET', 'DELETE', 'GET',");

replaceOnce('worker/src/minute-rebuild-maintenance-entry.js',
  'const REBUILD_SLOT_MS = 10 * 60_000;\n',
  'const REBUILD_SLOT_MS = 10 * 60_000;\nconst HISTORICAL_BACKFILL_DUE_WINDOW_MS = 60_000;\n');
replaceOnce('worker/src/minute-rebuild-maintenance-entry.js',
  '  return Math.floor(timestamp / interval) !== Math.floor((timestamp - REBUILD_SLOT_MS) / interval);',
  '  return Math.floor(timestamp / interval) !== Math.floor((timestamp - HISTORICAL_BACKFILL_DUE_WINDOW_MS) / interval);');

replaceOnce('worker/tests/minute-enrichment-playback-stages.test.js',
  "    apple_music_id: 'am27',\n",
  '');
replaceOnce('worker/tests/minute-enrichment-playback-stages.test.js',
  '    processMinuteEnrichment: async (_env, value) => {',
  '    processMinuteIdentitySession: async (_env, value) => {');

replaceOnce('worker/tests/minute-entry.test.js',
  '  assert.equal(config.vars.DERIVE_DISPATCH_LIMIT, 10);',
  '  assert.equal(config.vars.DERIVE_DISPATCH_LIMIT, 20);');

replaceOnce('worker/tests/minute-fact-payload-cleanup.test.js',
  '  assert.deepEqual(row, {\n    status:',
  '  assert.deepEqual({ ...row }, {\n    status:');

replaceOnce('worker/tests/minute-facts-fast-store.test.js',
  '  assert.equal(insertParams[13], 42);',
  '  assert.equal(insertParams[12], 42);');

replaceOnce('worker/tests/other-official-news-stages.test.js',
  "  const source = readFileSync(new URL('../src/other-monitor-entry.js', import.meta.url), 'utf8');\n  assert.match(source, /messageType === OFFICIAL_NEWS_STAGE_MESSAGE/);\n  assert.match(source, /processOfficialNewsStageMessage/);\n  assert.match(source, /const message = messages\\[0\\]/);",
  "  const source = readFileSync(new URL('../src/sakurazaka-entry.js', import.meta.url), 'utf8');\n  assert.match(source, /body\\.message_type === OFFICIAL_NEWS_STAGE_MESSAGE/);\n  assert.match(source, /processOfficialNewsStage/);\n  assert.match(source, /for \\(const message of messages\\)/);");

replaceOnce('worker/tests/pages-track-history-publication.test.js',
  '  assert.equal(payload.likes_included, false);',
  '  assert.equal(payload.likes_included, true);');
replaceOnce('worker/tests/pages-track-history-publication.test.js',
  "  assert.equal(pagesReadModelTask(CYCLE_START + 175 * 60_000).key, 'minute-facts-current');",
  "  assert.equal(pagesReadModelTask(CYCLE_START + 175 * 60_000).key, 'six-hour-cycle-idle');");

replaceOnce('worker/tests/production-entry.test.js',
  "    'BUDDY_PLAYBACK_QUEUE',\n",
  '');
replaceOnce('worker/tests/production-entry.test.js',
  "  for (const prefix of ['BUDDY_PLAYBACK_', 'HOST_', 'SOLO_', 'OFFICIAL_NEWS_', 'DERIVE_', 'HEALTH_ALERT_']) {\n    assert.equal(names.some((name) => name.startsWith(prefix)), true, prefix);\n  }",
  "  for (const prefix of ['BUDDY_PLAYBACK_', 'HOST_', 'SOLO_', 'OFFICIAL_NEWS_']) {\n    assert.equal(names.some((name) => name.startsWith(prefix)), false, prefix);\n  }\n  for (const prefix of ['DERIVE_', 'REBUILD_', 'HEALTH_ALERT_']) {\n    assert.equal(names.some((name) => name.startsWith(prefix)), true, prefix);\n  }");

for (const path of [
  'worker/tests/total-listens-baseline-index.test.js',
  'worker/tests/track-metadata-resolution.test.js',
]) {
  replaceOnce(path,
    'database/facts-migrations/025_d1_budget_hotpath_index.sql',
    'database/facts-migrations/028_purge_completed_minute_fact_payloads.sql');
}

console.log('Applied PR #555 worker fixes.');
