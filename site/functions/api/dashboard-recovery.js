const CACHE_CONTROL = 'public, max-age=20, s-maxage=30, stale-while-revalidate=90';
const STALE_AFTER_MS = 10 * 60 * 1000;

export const FACTS_RECOVERY_SQL = `WITH latest AS (
  SELECT channel_id,MAX(minute_at) AS latest_at FROM sh_minute_facts
), ranked AS (
  SELECT f.id,f.minute_at,f.observed_at,f.listener_count,f.online_member_count,
    f.total_member_count,f.reported_total_listens AS total_listens,
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
    return json({
      ok: true,
      generated_at: generatedAt,
      storage_source: 'facts-db',
      latest_observed_at: latestObservedAt,
      stale: !latestObservedAt || generatedAt - latestObservedAt > STALE_AFTER_MS,
      rows,
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'dashboard recovery error' }, 500, 'no-store');
  }
}
