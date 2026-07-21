import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const daily = readFileSync(new URL('../functions/api/dashboard-daily-changes.js', import.meta.url), 'utf8');
const tracks = readFileSync(new URL('../functions/api/track-history.js', import.meta.url), 'utf8');
const ranking = readFileSync(new URL('../functions/lib/track-ranking.js', import.meta.url), 'utf8');
const refresh = readFileSync(new URL('../../worker/src/pages-read-model-refresh.js', import.meta.url), 'utf8');
const maintenance = readFileSync(new URL('../../worker/src/scheduled-maintenance.js', import.meta.url), 'utf8');

test('Pages daily changes reads completed daily summaries', () => {
  const handler = daily.slice(daily.indexOf('export async function onRequestGet'));
  assert.match(daily, /FROM sh_daily_summary/);
  assert.match(handler, /OTHER_DB/);
  assert.match(daily, /reported_current_stream_count/);
});

test('Pages track history reads materialized rows and integrated ranking status', () => {
  assert.match(tracks, /FROM sh_pages_track_history_read_model/);
  assert.match(tracks, /model_key='track-history-status'/);
  assert.match(tracks, /ranking_summary/);
  assert.match(tracks, /ranking_scope/);
  assert.match(tracks, /worker_materialized_read_model/);
});

test('Worker owns ranking computation as part of track history refresh', () => {
  assert.match(ranking, /FROM sh_track_counter_current/);
  assert.match(refresh, /loadTrackRanking/);
  assert.match(refresh, /ranking_summary/);
  assert.match(refresh, /refreshTrackHistory/);
  assert.match(refresh, /sh_pages_payload_read_model/);
  assert.match(refresh, /sh_pages_track_history_read_model/);
  assert.match(maintenance, /refreshPagesReadModels/);
});
