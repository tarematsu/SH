import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const daily = readFileSync(new URL('../functions/api/dashboard-daily-changes.js', import.meta.url), 'utf8');
const likes = readFileSync(new URL('../functions/api/like-ranking.js', import.meta.url), 'utf8');
const tracks = readFileSync(new URL('../functions/api/track-history.js', import.meta.url), 'utf8');
const refresh = readFileSync(new URL('../../worker/src/pages-read-model-refresh.js', import.meta.url), 'utf8');
const maintenance = readFileSync(new URL('../../worker/src/scheduled-maintenance.js', import.meta.url), 'utf8');

test('Pages daily changes reads completed daily summaries without aggregating minute facts', () => {
  const handler = daily.slice(daily.indexOf('export async function onRequestGet'));
  assert.match(daily, /FROM sh_daily_summary/);
  assert.match(handler, /OTHER_DB/);
  assert.doesNotMatch(handler, /FROM sh_minute_facts|sh_total_member_daily|difference\(/);
});

test('Pages like ranking reads a completed payload instead of ranking counters', () => {
  const handler = likes.slice(likes.indexOf('export async function onRequestGet'));
  assert.match(handler, /FROM sh_pages_payload_read_model/);
  assert.doesNotMatch(handler, /sh_track_counter_current|ROW_NUMBER\(\) OVER|loadLikeRanking/);
});

test('Pages track history reads materialized rows without source snapshot reconstruction', () => {
  assert.match(tracks, /FROM sh_pages_track_history_read_model/);
  assert.doesNotMatch(tracks, /sh_queue_items|sh_queue_snapshots|sh_channel_snapshots|mergeTrackRows|refreshMissingMetadata/);
});

test('Worker owns refresh of all migrated Pages read models', () => {
  assert.match(refresh, /refreshDailyChanges/);
  assert.match(refresh, /refreshLikeRanking/);
  assert.match(refresh, /refreshTrackHistory/);
  assert.match(refresh, /sh_pages_payload_read_model/);
  assert.match(refresh, /sh_pages_track_history_read_model/);
  assert.match(maintenance, /refreshPagesReadModels/);
});
