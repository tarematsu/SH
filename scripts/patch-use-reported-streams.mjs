import { readFileSync, writeFileSync } from 'node:fs';

function edit(path, transform) {
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`No changes made to ${path}`);
  writeFileSync(path, after);
}

function replaceRequired(source, pattern, replacement, label) {
  const next = source.replace(pattern, replacement);
  if (next === source) throw new Error(`Missing pattern: ${label}`);
  return next;
}

edit('site/functions/lib/d1-lean-ingest.js', (source) => {
  let next = source;
  next = replaceRequired(next,
    /const STREAM_MIN_RISE_LIMIT = 50_000;\nconst STREAM_MIN_DROP_LIMIT = 10_000;\nconst STREAM_RISE_PER_MINUTE = 10_000;\n/,
    '',
    'stream validation constants');
  next = replaceRequired(next,
    /function snapshotHashPayload\(data, validatedStreamCount, compactRaw\)/,
    'function snapshotHashPayload(data, reportedStreamCount, compactRaw)',
    'snapshot hash signature');
  next = replaceRequired(next,
    /validated_stream_count: validatedStreamCount,/,
    'reported_stream_count: reportedStreamCount,',
    'snapshot hash validated field');
  next = replaceRequired(next,
    /function streamCandidates\(data\) \{[\s\S]*?\n\}\n\nexport function validatedStreamCount\(data, current, observedAt\) \{[\s\S]*?\n\}\n\nexport async function saveLeanSnapshot/,
    `export function reportedStreamCount(data) {\n  const value = num(data?.current_stream_count);\n  return value != null && value >= 0 ? value : null;\n}\n\nexport async function saveLeanSnapshot`,
    'stream validation functions');
  next = replaceRequired(next,
    /SELECT payload_hash,last_snapshot_at,last_stream_count,last_stream_at/,
    'SELECT payload_hash,last_snapshot_at',
    'snapshot current select');
  next = replaceRequired(next,
    /const streamCount = validatedStreamCount\(data, current, observedAt\);\n  const streamRejected = streamCount == null && streamCandidates\(data\)\.length > 0;/,
    'const streamCount = reportedStreamCount(data);',
    'snapshot stream calculation');
  next = replaceRequired(next,
    /return \{\n      inserted: false,\n      skipped: true,\n      streamRejected,\n      validatedStreamCount: streamCount,\n      validated_stream_count: streamCount,\n    \};/,
    `return {\n      inserted: false,\n      skipped: true,\n      reportedStreamCount: streamCount,\n      reported_stream_count: streamCount,\n    };`,
    'skipped snapshot result');
  next = replaceRequired(next,
    /num\(data\?\.current_stream_count\), streamCount, num\(data\?\.host_account_id\)/,
    'num(data?.current_stream_count), null, num(data?.host_account_id)',
    'snapshot validated storage');
  next = replaceRequired(next,
    /last_stream_count=COALESCE\(excluded\.last_stream_count,sh_snapshot_current\.last_stream_count\),\n      last_stream_at=CASE WHEN excluded\.last_stream_count IS NOT NULL\n        THEN excluded\.last_stream_at ELSE sh_snapshot_current\.last_stream_at END,/,
    'last_stream_count=NULL,last_stream_at=NULL,',
    'snapshot current stream state');
  next = replaceRequired(next,
    /streamCount,\n        streamCount != null \? observedAt : null,/,
    'null,\n        null,',
    'snapshot current bind values');
  next = replaceRequired(next,
    /return \{\n    inserted: true,\n    skipped: false,\n    streamRejected,\n    validatedStreamCount: streamCount,\n    validated_stream_count: streamCount,\n  \};/,
    `return {\n    inserted: true,\n    skipped: false,\n    reportedStreamCount: streamCount,\n    reported_stream_count: streamCount,\n  };`,
    'inserted snapshot result');
  return next;
});

edit('worker/src/minute-facts-store.js', (source) => {
  let next = source;
  next = replaceRequired(next,
    /export function validatedStreamCountFromSnapshotResult\(snapshotResult\) \{[\s\S]*?\n\}\n\n/,
    '',
    'validated snapshot result helper');
  next = replaceRequired(next,
    /  if \(input\.snapshotResult\?\.stream_rejected \|\| input\.snapshotResult\?\.streamRejected\) \{\n    flags \|= FACT_QUALITY_FLAGS\.STREAM_REJECTED;\n  \}\n/,
    '',
    'stream rejection flag');
  next = replaceRequired(next,
    /\n  const validatedStreamCount = validatedStreamCountFromSnapshotResult\(input\.snapshotResult\);\n/,
    '\n',
    'validated stream local');
  next = replaceRequired(next,
    /validated_stream_count: validatedStreamCount,/,
    'validated_stream_count: null,',
    'live fact validated field');
  next = replaceRequired(next,
    /stream_count_rejected: flags & FACT_QUALITY_FLAGS\.STREAM_REJECTED \? 1 : 0,/,
    'stream_count_rejected: 0,',
    'live fact rejected field');
  return next;
});

edit('worker/src/minute-facts-backfill.js', (source) => replaceRequired(source,
  /validated_stream_count: integer\(row\.total_stream_count\),/,
  'validated_stream_count: null,',
  'legacy validated field'));

edit('worker/tests/minute-facts.test.js', (source) => {
  let next = source;
  next = next.replace(/\s*validatedStreamCountFromSnapshotResult,\n/, '\n');
  next = next.replace(/\ntest\('minute facts never carry a previous validated stream[\s\S]*?\n\}\);\n?/, '\n');
  if (next === source) throw new Error('minute facts validated test not removed');
  return next;
});

edit('site/tests/stream-continuity.integration.test.js', () => `import assert from 'node:assert/strict';\nimport test from 'node:test';\n\nimport { reportedStreamCount } from '../functions/lib/d1-lean-ingest.js';\n\ntest('uses Stationhead current_stream_count as the total stream count', () => {\n  assert.equal(reportedStreamCount({ current_stream_count: 1_234_567 }), 1_234_567);\n  assert.equal(reportedStreamCount({ current_stream_count: 0 }), 0);\n});\n\ntest('never substitutes total_listens for the total stream count', () => {\n  assert.equal(reportedStreamCount({ total_listens: 950_000 }), null);\n  assert.equal(reportedStreamCount({ current_stream_count: null, total_listens: 950_000 }), null);\n});\n\ntest('rejects only structurally invalid reported stream values', () => {\n  assert.equal(reportedStreamCount({ current_stream_count: -1 }), null);\n  assert.equal(reportedStreamCount({ current_stream_count: 'not-a-number' }), null);\n});\n`);

edit('site/functions/api/history-migrated.js', (source) => {
  let next = source;
  next = replaceRequired(next,
    /CASE WHEN f\.source='live_collector' THEN f\.reported_current_stream_count\n      ELSE COALESCE\(f\.reported_current_stream_count,f\.reported_total_listens\) END\n      AS reported_stream_count,\n    f\.validated_stream_count,\n    f\.stream_count_rejected,/,
    `CASE WHEN f.source='live_collector' THEN f.reported_current_stream_count\n      ELSE COALESCE(f.reported_current_stream_count,f.reported_total_listens) END\n      AS total_stream_count,`,
    'history stream fields');
  return next;
});

edit('site/public/history/migrated.html', (source) => {
  let next = source;
  next = replaceRequired(next,
    '累計リスナー数と再生数は別項目として表示し、推定値と直接取得値も区別します。',
    '累計リスナー数と総再生数は別項目として表示します。総再生数はStationheadの報告値をそのまま使用します。',
    'history note');
  next = replaceRequired(next,
    '<th>現在リスナー</th><th>累計リスナー</th><th>報告再生数</th><th>検証済み再生数</th>',
    '<th>現在リスナー</th><th>累計リスナー</th><th>総再生数</th>',
    'history stream headers');
  return next;
});

edit('site/public/history/migrated.js', (source) => {
  let next = source;
  next = next.replace("    [64, '再生数棄却'],\n", '');
  next = replaceRequired(next, 'td.colSpan = 17;', 'td.colSpan = 16;', 'empty colspan');
  next = next.replace(/\n      const streamWarning = row\.stream_count_rejected \?[^\n]*\n/, '\n');
  next = replaceRequired(next,
    `        cell(formatNumber(row.cumulative_listener_count), 'これまで訪れた累計リスナー数'),\n        cell(formatNumber(row.reported_stream_count), streamWarning),\n        cell(formatNumber(row.validated_stream_count), streamWarning),`,
    `        cell(formatNumber(row.cumulative_listener_count), 'これまで訪れた累計リスナー数'),\n        cell(formatNumber(row.total_stream_count), 'Stationheadが報告した総再生数'),`,
    'history stream cells');
  next = replaceRequired(next,
    `'reported_stream_count','validated_stream_count','stream_count_rejected',`,
    `'total_stream_count',`,
    'csv stream headers');
  next = replaceRequired(next,
    `row.reported_stream_count, row.validated_stream_count, row.stream_count_rejected,`,
    `row.total_stream_count,`,
    'csv stream values');
  return next;
});

edit('site/tests/history-migrated.test.js', (source) => {
  let next = source;
  next = replaceRequired(next,
    `test('history separates cumulative listeners from reported stream counts', () => {\n  const sql = minuteFactsRowsSql();\n  assert.match(sql, /CASE WHEN f\\.source='live_collector' THEN f\\.reported_total_listens ELSE NULL END/);\n  assert.match(sql, /AS cumulative_listener_count/);\n  assert.match(sql, /CASE WHEN f\\.source='live_collector' THEN f\\.reported_current_stream_count/);\n  assert.match(sql, /COALESCE\\(f\\.reported_current_stream_count,f\\.reported_total_listens\\)/);\n  assert.match(sql, /AS reported_stream_count/);\n});`,
    `test('history separates cumulative listeners from Stationhead total streams', () => {\n  const sql = minuteFactsRowsSql();\n  assert.match(sql, /CASE WHEN f\\.source='live_collector' THEN f\\.reported_total_listens ELSE NULL END/);\n  assert.match(sql, /AS cumulative_listener_count/);\n  assert.match(sql, /CASE WHEN f\\.source='live_collector' THEN f\\.reported_current_stream_count/);\n  assert.match(sql, /COALESCE\\(f\\.reported_current_stream_count,f\\.reported_total_listens\\)/);\n  assert.match(sql, /AS total_stream_count/);\n  assert.doesNotMatch(sql, /f\\.validated_stream_count/);\n});`,
    'history stream test');
  return next;
});

edit('database/facts-migrations/001_initial_schema.sql', (source) => {
  const marker = '-- Do not retain derived stream validation values.';
  if (source.includes(marker)) return source;
  return `${source.trimEnd()}\n\n${marker}\nUPDATE sh_minute_facts\nSET validated_stream_count=NULL,\n    stream_count_rejected=0,\n    quality_score=MIN(1,quality_score+CASE WHEN (quality_flags & 64)<>0 THEN 0.1 ELSE 0 END),\n    quality_flags=quality_flags & ~64;\n`;
});
