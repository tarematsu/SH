import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(path, before, after) {
  const source = readFileSync(path, 'utf8');
  if (!source.includes(before)) throw new Error(`Expected block not found in ${path}`);
  const updated = source.replace(before, after);
  if (updated === source) throw new Error(`No replacement made in ${path}`);
  writeFileSync(path, updated);
}

replaceOnce(
  'worker/src/minute-facts-store.js',
  `export function qualityScore(flags) {\n  let score = 1;\n  if (flags & FACT_QUALITY_FLAGS.QUEUE_MISSING) score -= 0.2;\n  if (flags & FACT_QUALITY_FLAGS.TRACK_UNKNOWN) score -= 0.3;\n  if (flags & FACT_QUALITY_FLAGS.COMMENTS_DEGRADED) score -= 0.1;\n  if (flags & FACT_QUALITY_FLAGS.STREAM_REJECTED) score -= 0.1;\n  if (flags & FACT_QUALITY_FLAGS.DELAYED_PAYLOAD) score -= 0.1;\n  return Math.max(0, Number(score.toFixed(2)));\n}\n\nconst FACT_COLUMNS = [\n`,
  `export function qualityScore(flags) {\n  let score = 1;\n  if (flags & FACT_QUALITY_FLAGS.QUEUE_MISSING) score -= 0.2;\n  if (flags & FACT_QUALITY_FLAGS.TRACK_UNKNOWN) score -= 0.3;\n  if (flags & FACT_QUALITY_FLAGS.COMMENTS_DEGRADED) score -= 0.1;\n  if (flags & FACT_QUALITY_FLAGS.STREAM_REJECTED) score -= 0.1;\n  if (flags & FACT_QUALITY_FLAGS.DELAYED_PAYLOAD) score -= 0.1;\n  return Math.max(0, Number(score.toFixed(2)));\n}\n\nexport function validatedStreamCountFromSnapshotResult(snapshotResult) {\n  return integer(snapshotResult?.validated_stream_count\n    ?? snapshotResult?.validatedStreamCount);\n}\n\nconst FACT_COLUMNS = [\n`,
);

replaceOnce(
  'worker/src/minute-facts-store.js',
  `  let validatedStreamCount = integer(input.snapshotResult?.validated_stream_count\n    ?? input.snapshotResult?.validatedStreamCount);\n  if (validatedStreamCount == null && env.DB) {\n    try {\n      const streamState = await env.DB.prepare(\`SELECT last_stream_count FROM sh_snapshot_current\n        WHERE channel_key=?\`).bind(String(channelId)).first();\n      validatedStreamCount = integer(streamState?.last_stream_count);\n    } catch {\n      // The legacy DB remains an optional validation source during rollout.\n    }\n  }\n`,
  `  const validatedStreamCount = validatedStreamCountFromSnapshotResult(input.snapshotResult);\n`,
);

replaceOnce(
  'worker/tests/minute-facts.test.js',
  `  qualityScore,\n  queueStructuralHash,\n`,
  `  qualityScore,\n  queueStructuralHash,\n  validatedStreamCountFromSnapshotResult,\n`,
);

const testPath = 'worker/tests/minute-facts.test.js';
const testSource = readFileSync(testPath, 'utf8');
const testMarker = "test('minute facts never carry a previous validated stream into a missing snapshot result'";
if (!testSource.includes(testMarker)) {
  writeFileSync(testPath, `${testSource.trimEnd()}\n\ntest('minute facts never carry a previous validated stream into a missing snapshot result', () => {\n  assert.equal(validatedStreamCountFromSnapshotResult({ validated_stream_count: 123 }), 123);\n  assert.equal(validatedStreamCountFromSnapshotResult({ validatedStreamCount: 456 }), 456);\n  assert.equal(validatedStreamCountFromSnapshotResult({ validated_stream_count: null }), null);\n  assert.equal(validatedStreamCountFromSnapshotResult(null), null);\n});\n`);
}

const schemaPath = 'database/facts-migrations/001_initial_schema.sql';
const schema = readFileSync(schemaPath, 'utf8');
const schemaMarker = '-- Remove validated stream values that were carried forward from an earlier minute.';
if (!schema.includes(schemaMarker)) {
  writeFileSync(schemaPath, `${schema.trimEnd()}\n\n${schemaMarker}\nUPDATE sh_minute_facts\nSET validated_stream_count=NULL\nWHERE source='live_collector'\n  AND validated_stream_count IS NOT NULL\n  AND (stream_count_rejected=1 OR reported_current_stream_count IS NULL);\n`);
}
