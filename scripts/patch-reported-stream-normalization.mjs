import { readFileSync, writeFileSync } from 'node:fs';

function replace(path, before, after) {
  const source = readFileSync(path, 'utf8');
  if (!source.includes(before)) throw new Error(`Missing block in ${path}`);
  writeFileSync(path, source.replace(before, after));
}

replace(
  'site/functions/lib/d1-lean-ingest.js',
  '    num(data?.current_stream_count), null, num(data?.host_account_id), text(data?.host_handle),',
  '    streamCount, null, num(data?.host_account_id), text(data?.host_handle),',
);

replace(
  'worker/src/minute-facts-store.js',
  `function integer(value) {\n  const parsed = num(value);\n  return parsed == null ? null : Math.trunc(parsed);\n}\n`,
  `function integer(value) {\n  const parsed = num(value);\n  return parsed == null ? null : Math.trunc(parsed);\n}\n\nexport function reportedStreamCount(value) {\n  const parsed = integer(value);\n  return parsed != null && parsed >= 0 ? parsed : null;\n}\n`,
);

replace(
  'worker/src/minute-facts-store.js',
  '    reported_current_stream_count: integer(snapshot.current_stream_count),',
  '    reported_current_stream_count: reportedStreamCount(snapshot.current_stream_count),',
);

replace(
  'worker/tests/minute-facts.test.js',
  `  qualityScore,\n  queueStructuralHash,`,
  `  qualityScore,\n  queueStructuralHash,\n  reportedStreamCount,`,
);

const testPath = 'worker/tests/minute-facts.test.js';
const source = readFileSync(testPath, 'utf8');
const marker = "test('reported stream count preserves Stationhead values without continuity validation'";
if (!source.includes(marker)) {
  writeFileSync(testPath, `${source.trimEnd()}\n\ntest('reported stream count preserves Stationhead values without continuity validation', () => {\n  assert.equal(reportedStreamCount(1_234_567), 1_234_567);\n  assert.equal(reportedStreamCount('456'), 456);\n  assert.equal(reportedStreamCount(-1), null);\n  assert.equal(reportedStreamCount('not-a-number'), null);\n});\n`);
}
