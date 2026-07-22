import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dashboard = readFileSync(new URL('../functions/api/dashboard.js', import.meta.url), 'utf8');
const dailySummaries = readFileSync(new URL('../functions/lib/dashboard-daily-summaries.js', import.meta.url), 'utf8');
const tracks = readFileSync(new URL('../functions/api/track-history.js', import.meta.url), 'utf8');
const ranking = readFileSync(new URL('../functions/lib/track-ranking.js', import.meta.url), 'utf8');
const trackStage = readFileSync(new URL('../../worker/src/pages-track-history-stage.js', import.meta.url), 'utf8');
const publication = readFileSync(new URL('../../worker/src/pages-track-history-publication-queue.js', import.meta.url), 'utf8');
const dispatch = readFileSync(new URL('../../worker/src/pages-read-model-dispatch.js', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../../worker/src/minute-enrichment-optimized-entry.js', import.meta.url), 'utf8');
const workers = readFileSync(new URL('../../worker/scripts/cloudflare-workers.mjs', import.meta.url), 'utf8');

test('dashboard composes completed daily summaries through a focused loader', () => {
  assert.match(dashboard, /loadDashboardDailySummaries/);
  assert.match(dashboard, /daily_summaries/);
  assert.match(dailySummaries, /FROM sh_daily_summary/);
  assert.doesNotMatch(dashboard, /FROM sh_daily_summary/);
});

test('Pages track history reads materialized rows and integrated ranking status', () => {
  assert.match(tracks, /FROM sh_pages_track_history_read_model/);
  assert.match(tracks, /model_key='track-history-status'/);
  assert.match(tracks, /ranking_summary/);
  assert.match(tracks, /ranking_scope/);
  assert.match(tracks, /worker_materialized_read_model/);
});

test('track-history generation has one shard and publication pipeline inside minute enrichment', () => {
  assert.match(ranking, /FROM sh_track_counter_current/);
  assert.match(trackStage, /loadTrackRanking/);
  assert.match(trackStage, /ranking_summary/);
  assert.match(trackStage, /sh_pages_track_history_read_model/);
  assert.match(publication, /processTrackHistoryPublicationTask/);
  assert.match(dispatch, /pages-track-history-split-cycle/);
  assert.match(entry, /runPagesReadModelCron/);
});

test('module splitting does not increase the deployed Worker count', () => {
  const activeBlock = workers.slice(workers.indexOf('ACTIVE_WORKER_NAMES'), workers.indexOf('RETIRED_WORKER_NAMES'));
  assert.equal((activeBlock.match(/'sh-/g) || []).length, 4);
});
