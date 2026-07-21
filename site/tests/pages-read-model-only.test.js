import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const daily = readFileSync(new URL('../functions/api/dashboard-daily-changes.js', import.meta.url), 'utf8');
const tracks = readFileSync(new URL('../functions/api/track-history.js', import.meta.url), 'utf8');
const ranking = readFileSync(new URL('../functions/lib/track-ranking.js', import.meta.url), 'utf8');
const refresh = readFileSync(new URL('../../worker/src/pages-read-model-refresh.js', import.meta.url), 'utf8');
const maintenance = readFileSync(new URL('../../worker/src/scheduled-maintenance.js', import.meta.url), 'utf8');

test('Pages daily changes reads completed daily summaries without aggregating minute facts', () => {
  const handler = daily.slice(daily.indexOf('export async function onRequestGet'));
  assert.match(daily, /FROM sh_daily_summary/);
  assert.match(handler, /OTHER_DB/);
  assert.doesNotMatch(handler, /FROM sh_minute_facts|sh_total_member_daily|difference\(/);
});

test('Pages track history reads materialized rows and integrated ranking status only', () => {
  assert.match(tracks, /FROM sh_pages_track_history_read_model/);
  assert.match(tracks, /model_key='track-history-status'/);
  assert.match(tracks, /ranking_summary/);
  assert.doesNotMatch(tracks, /sh_queue_items|sh_queue_snapshots|sh_channel_snapshots|mergeTrackRows|sh_track_counter_current/);
  assert.equal(existsSync(new URL('../functions/api/like-ranking.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('../functions/api/track-likes.js', import.meta.url)), false);
});

test('Worker owns ranking computation as part of track history refresh', () => {
  assert.match(ranking, /FROM sh_track_counter_current/);
  assert.match(refresh, /loadTrackRanking/);
  assert.match(refresh, /ranking_summary/);
  assert.match(refresh, /refreshTrackHistory/);
  assert.match(refresh, /sh_pages_payload_read_model/);
  assert.match(refresh, /sh_pages_track_history_read_model/);
  assert.doesNotMatch(refresh, /refreshLikeRanking|like-ranking|track-likes/);
  assert.match(maintenance, /refreshPagesReadModels/);
});
