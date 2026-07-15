const CACHE_CONTROL = 'public, max-age=20, s-maxage=30, stale-while-revalidate=90';
import { FACTS_FRESH_MS } from '../lib/dashboard-facts.js';

const STALE_AFTER_MS = FACTS_FRESH_MS;

export const FACTS_RECOVERY_SQL = `WITH latest AS (
  SELECT channel_id,MAX(minute_at) AS latest_at FROM sh_minute_facts
), ranked AS (
  SELECT f.id,f.minute_at,f.observed_at,f.listener_count,f.online_member_count,
    COALESCE((SELECT d.last_total_member_count FROM sh_total_member_daily d
      WHERE d.channel_id=f.channel_id AND d.day_at=(f.observed_at/86400000)*86400000
      ORDER BY d.last_observed_at DESC,d.host_key LIMIT 1),f.total_member_count)
      AS total_member_count,f.reported_total_listens AS total_listens,
    f.reported_current_stream_count AS current_stream_count,
    ROW_NUMBER() OVER (
      PARTITION BY CAST(f.minute_at/300000 AS INTEGER)
      ORDER BY f.minute_at DESC,f.id DESC
    ) AS rn
  FROM sh_minute_facts AS f,latest
  WHERE latest.latest_at IS NOT NULL
    AND f.channel_id=latest.channel_id
    AND f.minute_at>=latest.latest_at-86400000
)
SELECT observed_at,listener_count,online_member_count,total_member_count,
  total_listens,current_stream_count
FROM ranked WHERE rn=1 ORDER BY observed_at ASC LIMIT 300`;

export const COLLECTOR_LATEST_SQL = `SELECT observed_at
FROM sh_channel_snapshots
ORDER BY observed_at DESC,id DESC
LIMIT 1`;

function json(data, status = 200, cache = CACHE_CONTROL) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache,
      'vary': 'accept-encoding',
    },
  });
}

export async function onRequestGet({ env }) {
  if (!env.MINUTE_DB) {
    return json({ ok: false, error: 'MINUTE_DB binding missing' }, 500, 'no-store');
  }

  try {
    const result = await env.MINUTE_DB.prepare(FACTS_RECOVERY_SQL).all();

    const rows = result.results || [];
    const latestObservedAt = Number(rows.at(-1)?.observed_at || 0) || null;
    const generatedAt = Date.now();
    let collectorLatestObservedAt = null;
    if (env.DB) {
      try {
        const collectorLatest = await env.DB.prepare(COLLECTOR_LATEST_SQL).first();
        collectorLatestObservedAt = Number(collectorLatest?.observed_at || 0) || null;
      } catch (error) {
        if (!/no such table|no such view/i.test(String(error?.message || ''))) throw error;
      }
    }
    const readModelStale = !latestObservedAt || generatedAt - latestObservedAt > STALE_AFTER_MS;
    const collectorStale = !collectorLatestObservedAt
      || generatedAt - collectorLatestObservedAt > STALE_AFTER_MS;
    return json({
      ok: true,
      generated_at: generatedAt,
      storage_source: 'facts-db',
      latest_observed_at: latestObservedAt,
      stale: collectorStale,
      read_model_stale: readModelStale,
      collector_latest_observed_at: collectorLatestObservedAt,
      rows,
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'dashboard recovery error' }, 500, 'no-store');
  }
}
