import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dashboard = readFileSync(new URL('../functions/api/dashboard.js', import.meta.url), 'utf8');
const dailySummaries = readFileSync(new URL('../functions/lib/dashboard-daily-summaries.js', import.meta.url), 'utf8');
const tracks = readFileSync(new URL('../functions/api/track-history.js', import.meta.url), 'utf8');
const ranking = readFileSync(new URL('../functions/lib/track-ranking.js', import.meta.url), 'utf8');
const publication = readFileSync(new URL('../../worker/src/pages-read-model-publication.js', import.meta.url), 'utf8');
const trackRefresh = readFileSync(new URL('../../worker/src/pages-track-history-read-model.js', import.meta.url), 'utf8');
const orchestration = readFileSync(new URL('../../worker/src/pages-read-model-refresh.js', import.meta.url), 'utf8');
const maintenance = readFileSync(new URL('../../worker/src/scheduled-maintenance.js', import.meta.url), 'utf8');

test('dashboard composes completed daily summaries through a focused loader', () => {
  assert.match(dashboard, /loadDashboardDailySummaries/);
  assert.match(dashboard, /daily_summaries/);
  assert.match(dailySummaries, /FROM sh_daily_summary/);
  assert.match(dailySummaries, /OTHER_DB|loadDashboardDailySummaries/);
  assert.doesNotMatch(dashboard, /FROM sh_daily_summary/);
});

test('Pages track history reads materialized rows and integrated ranking status', () => {
  assert.match(tracks, /FROM sh_pages_track_history_read_model/);
  assert.match(tracks, /model_key='track-history-status'/);
  assert.match(tracks, /ranking_summary/);
  assert.match(tracks, /ranking_scope/);
  assert.match(tracks, /worker_materialized_read_model/);
});

test('Worker read-model responsibilities are split without adding a Worker', () => {
  assert.match(ranking, /FROM sh_track_counter_current/);
  assert.match(trackRefresh, /loadTrackRanking/);
  assert.match(trackRefresh, /ranking_summary/);
  assert.match(trackRefresh, /sh_pages_track_history_read_model/);
  assert.match(publication, /sh_pages_response_manifest/);
  assert.match(publication, /materializePagesVariants/);
  assert.match(orchestration, /refreshTrackHistoryReadModel/);
  assert.match(maintenance, /refreshPagesReadModels/);
});
