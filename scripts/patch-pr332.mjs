import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(path, before, after) {
  const source = readFileSync(path, 'utf8');
  if (!source.includes(before)) throw new Error(`Expected block not found in ${path}`);
  const updated = source.replace(before, after);
  if (updated === source) throw new Error(`No replacement made in ${path}`);
  writeFileSync(path, updated);
}

replaceOnce(
  'site/functions/lib/d1-lean-ingest.js',
  `  const dropLimit = Math.max(STREAM_MIN_DROP_LIMIT, Math.abs(previous) * 0.1);\n  const continuous = candidates.filter((value) => {\n`,
  `  const dropLimit = Math.max(STREAM_MIN_DROP_LIMIT, Math.abs(previous) * 0.1);\n  const rawStreamCount = candidates[0];\n  const cumulativeListeners = num(data?.total_listens);\n  const listenerDelta = cumulativeListeners == null ? null : cumulativeListeners - previous;\n  const previousTracksListeners = listenerDelta != null\n    && listenerDelta <= riseLimit\n    && listenerDelta >= -dropLimit;\n  const streamDelta = rawStreamCount - previous;\n  const streamBreaksContinuity = streamDelta > riseLimit || streamDelta < -dropLimit;\n  if (previousTracksListeners && streamBreaksContinuity) return rawStreamCount;\n\n  const continuous = candidates.filter((value) => {\n`,
);

replaceOnce(
  'site/tests/stream-continuity.integration.test.js',
  `test('rejects an extreme current_stream_count without consulting total_listens', () => {\n  const current = {\n    last_stream_count: 1000000,\n    last_stream_at: 1000000,\n    last_snapshot_at: 1000000,\n  };\n  const value = validatedStreamCount({\n    current_stream_count: 280,\n    total_listens: 1000120,\n  }, current, 1060000);\n  assert.equal(value, null);\n});\n`,
  `test('rejects an extreme current_stream_count when total_listens does not match the baseline', () => {\n  const current = {\n    last_stream_count: 1000000,\n    last_stream_at: 1000000,\n    last_snapshot_at: 1000000,\n  };\n  const value = validatedStreamCount({\n    current_stream_count: 280,\n    total_listens: 315,\n  }, current, 1060000);\n  assert.equal(value, null);\n});\n\ntest('reseeds stream validation when the old baseline was total_listens', () => {\n  const current = {\n    last_stream_count: 1000000,\n    last_stream_at: 1000000,\n    last_snapshot_at: 1000000,\n  };\n  const value = validatedStreamCount({\n    current_stream_count: 340,\n    total_listens: 1000120,\n  }, current, 1060000);\n  assert.equal(value, 340);\n});\n`,
);

replaceOnce(
  'site/public/history/migrated.js',
  `      '曲名','アーティスト','ISRC','spotify_id','track_bite_count','ホスト','online_member_count','total_member_count',\n      'comment_count','comment_total','comments_degraded','queue_id','queue_revision_id','queue_position','queue_track_count',\n`,
  `      '曲名','アーティスト','ISRC','spotify_id','track_bite_count','ホスト','online_member_count','total_member_count','guest_count',\n      'comment_count','comment_total','comments_degraded','queue_id','queue_revision_id','queue_position','queue_track_count',\n`,
);

replaceOnce(
  'site/public/history/migrated.js',
  `      row.online_member_count, row.total_member_count, row.comment_count, row.comment_total, row.comments_degraded,\n`,
  `      row.online_member_count, row.total_member_count, row.guest_count, row.comment_count, row.comment_total, row.comments_degraded,\n`,
);

const schemaPath = 'database/facts-migrations/001_initial_schema.sql';
const schema = readFileSync(schemaPath, 'utf8');
const marker = '-- Repair live rows whose validated stream value came from total_listens.';
if (!schema.includes(marker)) {
  writeFileSync(schemaPath, `${schema.trimEnd()}\n\n${marker}\nUPDATE sh_minute_facts\nSET validated_stream_count=NULL,\n    stream_count_rejected=1,\n    quality_flags=quality_flags | 64,\n    quality_score=MAX(0,quality_score-CASE WHEN (quality_flags & 64)=0 THEN 0.1 ELSE 0 END)\nWHERE source='live_collector'\n  AND reported_current_stream_count IS NOT NULL\n  AND reported_total_listens IS NOT NULL\n  AND validated_stream_count=reported_total_listens\n  AND reported_current_stream_count<>reported_total_listens;\n`);
}
