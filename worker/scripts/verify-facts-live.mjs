import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workerRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(workerRoot, '..');
const wranglerScript = resolve(workerRoot, 'node_modules/wrangler/bin/wrangler.js');
const outputPath = resolve(repositoryRoot, 'database/facts-live-verification.json');
const databaseName = process.env.FACTS_DATABASE_NAME || 'stationhead-minute';
const attempts = Math.max(1, Math.min(10, Number(process.env.FACTS_VERIFY_ATTEMPTS || 5)));
const delayMs = Math.max(5_000, Number(process.env.FACTS_VERIFY_DELAY_MS || 20_000));
const freshnessMs = Math.max(120_000, Number(process.env.FACTS_VERIFY_FRESHNESS_MS || 15 * 60_000));
const includeRevisionReach = /^(1|true|yes)$/i.test(
  String(process.env.FACTS_VERIFY_REVISION_REACH || '').trim(),
);

function wrangler(args) {
  return execFileSync(process.execPath, [wranglerScript, ...args], {
    cwd: workerRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function parseJsonOutput(output) {
  const text = String(output || '').trim();
  const starts = [text.indexOf('['), text.indexOf('{')].filter((index) => index >= 0);
  if (!starts.length) throw new Error(`Wrangler did not return JSON: ${text.slice(0, 500)}`);
  return JSON.parse(text.slice(Math.min(...starts)));
}

function resultRows(payload) {
  const containers = Array.isArray(payload) ? payload : [payload];
  for (const container of containers) {
    const rows = container?.results || container?.result?.[0]?.results || container?.result?.results;
    if (Array.isArray(rows)) return rows;
  }
  return [];
}

function firstResult(payload) {
  return resultRows(payload)[0] || null;
}

function runQuery(command) {
  return parseJsonOutput(wrangler([
    'd1', 'execute', databaseName,
    '--remote', '--yes', '--json',
    '--command', command,
  ]));
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.ceil(quantile * ordered.length) - 1);
  return ordered[Math.min(rank, ordered.length - 1)];
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function revisionReachSummary(rows) {
  const samples = rows.map((row) => ({
    revision_id: Number(row.revision_id),
    item_count: Number(row.item_count),
    reached_tracks: Number(row.reached_tracks),
    fact_samples: Number(row.fact_samples || 0),
  })).filter((row) => (
    Number.isFinite(row.revision_id)
    && Number.isFinite(row.item_count)
    && row.item_count > 0
    && Number.isFinite(row.reached_tracks)
    && row.reached_tracks > 0
  ));
  const reached = samples.map((row) => row.reached_tracks);
  const utilization = samples.map((row) => Math.min(1, row.reached_tracks / row.item_count));
  const p95 = percentile(reached, 0.95);
  return {
    sample_count: samples.length,
    average_reached_tracks: average(reached),
    median_reached_tracks: percentile(reached, 0.5),
    p90_reached_tracks: percentile(reached, 0.9),
    p95_reached_tracks: p95,
    p99_reached_tracks: percentile(reached, 0.99),
    max_reached_tracks: reached.length ? Math.max(...reached) : null,
    average_revision_item_count: average(samples.map((row) => row.item_count)),
    average_utilization: average(utilization),
    suggested_initial_tracks: samples.length >= 20 && p95 != null
      ? Math.max(10, Math.min(40, p95 + 2))
      : 20,
    suggestion_basis: samples.length >= 20 ? 'recent-closed-revision-p95-plus-2' : 'insufficient-samples-fallback',
  };
}

function loadRevisionReach() {
  const revisionColumns = new Set(resultRows(runQuery(
    "SELECT name FROM pragma_table_info('sh_queue_revisions')",
  )).map((row) => String(row.name)));
  const itemCountExpression = revisionColumns.has('total_item_count')
    ? 'COALESCE(r.total_item_count,r.item_count)'
    : 'r.item_count';
  const payload = runQuery(`WITH recent_revisions AS (
      SELECT r.id,r.channel_id,r.session_id,r.effective_at,
        ${itemCountExpression} AS item_count,
        s.status AS session_status
      FROM sh_queue_revisions r
      LEFT JOIN sh_broadcast_sessions s ON s.id=r.session_id
      WHERE r.status='complete' AND r.source='live_collector'
        AND ${itemCountExpression}>0
      ORDER BY r.effective_at DESC,r.id DESC
      LIMIT 500
    ), ordered AS (
      SELECT recent_revisions.*,
        LEAD(effective_at) OVER (
          PARTITION BY channel_id ORDER BY effective_at,id
        ) AS next_effective_at
      FROM recent_revisions
    ), reached AS (
      SELECT o.id AS revision_id,o.item_count,
        MAX(c.queue_position)+1 AS reached_tracks,
        COUNT(c.fact_id) AS fact_samples
      FROM ordered o
      LEFT JOIN sh_minute_fact_context_v2 c
        ON c.queue_revision_id=o.id AND c.queue_position IS NOT NULL
      WHERE o.next_effective_at IS NOT NULL OR o.session_status='ended'
      GROUP BY o.id,o.item_count
    )
    SELECT revision_id,item_count,reached_tracks,fact_samples
    FROM reached
    WHERE reached_tracks IS NOT NULL AND reached_tracks>0
    ORDER BY revision_id DESC
    LIMIT 500`);
  return revisionReachSummary(resultRows(payload));
}

function writeStatus(status) {
  mkdirSync(resolve(repositoryRoot, 'database'), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(status, null, 2)}\n`);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

let last = null;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const payload = runQuery(`WITH latest AS (
        SELECT observed_at,minute_at,source_code
        FROM sh_minute_facts
        ORDER BY observed_at DESC,id DESC
        LIMIT 1
      ), live AS (
        SELECT 1 AS present
        FROM sh_minute_facts
        WHERE source_code=1
        ORDER BY id DESC
        LIMIT 1
      )
      SELECT
        COALESCE((SELECT id FROM sh_minute_facts ORDER BY id DESC LIMIT 1),0) AS fact_count,
        (SELECT observed_at FROM latest) AS last_observed_at,
        (SELECT minute_at FROM latest) AS last_minute_at,
        COALESCE((SELECT present FROM live),0) AS live_fact_count,
        (SELECT COUNT(*) FROM pragma_table_info('sh_tracks') WHERE name='isrc') AS sh_tracks_isrc_column_count,
        (SELECT COUNT(*) FROM pragma_table_info('sh_track_metadata') WHERE name='isrc') AS sh_track_metadata_isrc_column_count,
        (SELECT COUNT(*) FROM pragma_table_info('sh_track_dictionary') WHERE name='isrc') AS track_dictionary_isrc_column_count,
        (SELECT COUNT(*) FROM pragma_table_info('sh_track_dictionary') WHERE name='thumbnail_url') AS track_dictionary_thumbnail_column_count,
        (SELECT COUNT(*) FROM pragma_table_info('sh_track_stats_by_isrc') WHERE name='latest_bite_count') AS track_stats_bite_column_count,
        (SELECT COUNT(*) FROM pragma_table_info('sh_queue_revisions') WHERE name='materialized_item_count') AS revision_materialized_count_column_count,
        (SELECT COUNT(*) FROM pragma_table_info('sh_queue_revisions') WHERE name='coverage_complete') AS revision_coverage_column_count,
        (SELECT COUNT(*) FROM pragma_table_info('sh_queue_revisions') WHERE name='source_job_id') AS revision_source_job_column_count,
        (SELECT COUNT(*) FROM pragma_table_info('sh_queue_revisions') WHERE name='source_visible_count') AS revision_source_visible_column_count,
        (SELECT COUNT(*) FROM pragma_table_info('sh_queue_revisions') WHERE name='last_materialized_at') AS revision_checkpoint_column_count`);
    const row = firstResult(payload) || {};
    const now = Date.now();
    let revisionReach = null;
    let revisionReachError = null;
    if (includeRevisionReach) {
      try {
        revisionReach = loadRevisionReach();
      } catch (error) {
        revisionReachError = String(error?.message || error).slice(0, 1000);
      }
    }
    last = {
      result: 'pending',
      database_name: databaseName,
      attempt,
      fact_count: Number(row.fact_count || 0),
      live_fact_count: Number(row.live_fact_count || 0),
      last_observed_at: Number(row.last_observed_at || 0) || null,
      last_minute_at: Number(row.last_minute_at || 0) || null,
      sh_tracks_isrc_present: Number(row.sh_tracks_isrc_column_count || 0) > 0,
      sh_track_metadata_isrc_present: Number(row.sh_track_metadata_isrc_column_count || 0) > 0,
      track_dictionary_present: Number(row.track_dictionary_isrc_column_count || 0) > 0,
      track_dictionary_thumbnail_present: Number(row.track_dictionary_thumbnail_column_count || 0) > 0,
      track_stats_by_isrc_present: Number(row.track_stats_bite_column_count || 0) > 0,
      revision_materialized_count_present: Number(row.revision_materialized_count_column_count || 0) > 0,
      revision_coverage_present: Number(row.revision_coverage_column_count || 0) > 0,
      revision_source_job_present: Number(row.revision_source_job_column_count || 0) > 0,
      revision_source_visible_present: Number(row.revision_source_visible_column_count || 0) > 0,
      revision_checkpoint_present: Number(row.revision_checkpoint_column_count || 0) > 0,
      revision_reach_enabled: includeRevisionReach,
      revision_reach: revisionReach,
      revision_reach_error: revisionReachError,
      checked_at: new Date(now).toISOString(),
    };
    const recent = last.last_observed_at != null && now - last.last_observed_at <= freshnessMs;
    const requiredSchemaPresent = last.sh_tracks_isrc_present
      && last.sh_track_metadata_isrc_present
      && last.track_dictionary_present
      && last.track_dictionary_thumbnail_present
      && last.track_stats_by_isrc_present
      && last.revision_materialized_count_present
      && last.revision_coverage_present
      && last.revision_source_job_present
      && last.revision_source_visible_present
      && last.revision_checkpoint_present;
    if (last.live_fact_count > 0 && recent && requiredSchemaPresent) {
      last.result = 'success';
      writeStatus(last);
      console.log(JSON.stringify(last));
      process.exit(0);
    }
  } catch (error) {
    last = {
      result: 'query-failed',
      database_name: databaseName,
      attempt,
      error: String(error?.message || error).slice(0, 1000),
      checked_at: new Date().toISOString(),
    };
  }
  writeStatus(last);
  if (attempt < attempts) await sleep(delayMs);
}

writeStatus({ ...last, result: last?.result === 'query-failed' ? 'query-failed' : 'live-fact-or-schema-not-ready' });
throw new Error(`Live minute fact verification failed: ${JSON.stringify(last)}`);
