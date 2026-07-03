import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const foundation = await readFile(new URL('../database/migrations/003_email_stream_snapshots.sql', import.meta.url), 'utf8');
const weekly = await readFile(new URL('../database/migrations/006_email_weekly_summary.sql', import.meta.url), 'utf8');
const runtime = await readFile(new URL('../database/migrations/016_email_stream_runtime.sql', import.meta.url), 'utf8');

test('email stream table is created before migrations that install its triggers and index', () => {
  assert.match(foundation, /CREATE TABLE IF NOT EXISTS sh_email_stream_snapshots/i);
  assert.match(weekly, /ON sh_email_stream_snapshots/i);
  assert.match(runtime, /ON sh_email_stream_snapshots/i);
  assert.ok('003_email_stream_snapshots.sql' < '006_email_weekly_summary.sql');
  assert.ok('003_email_stream_snapshots.sql' < '016_email_stream_runtime.sql');
});

test('foundation schema contains every column written by the email recap Worker', () => {
  for (const column of [
    'source_key', 'week_of', 'email_sent_at', 'effective_at', 'stream_count',
    'source', 'validation_status', 'timing_basis', 'timing_offset_minutes',
    'reference_source', 'estimated_stream_count', 'difference',
    'relative_difference', 'nearest_distance_minutes', 'validation_notes', 'imported_at',
  ]) {
    assert.match(foundation, new RegExp(`\\b${column}\\b`, 'i'), column);
  }
});
