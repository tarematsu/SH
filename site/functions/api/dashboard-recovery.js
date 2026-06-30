const CACHE_CONTROL = 'public, max-age=20, s-maxage=30, stale-while-revalidate=90';
const STALE_AFTER_MS = 10 * 60 * 1000;

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
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, 'no-store');

  try {
    const result = await env.DB.prepare(`WITH latest AS (
      SELECT MAX(observed_at) AS latest_at FROM sh_channel_snapshots
    ), ranked AS (
      SELECT observed_at,listener_count,online_member_count,total_member_count,
        total_listens,current_stream_count,stream_goal,
        ROW_NUMBER() OVER (
          PARTITION BY CAST(observed_at/300000 AS INTEGER)
          ORDER BY observed_at DESC,id DESC
        ) AS rn
      FROM sh_channel_snapshots,latest
      WHERE latest.latest_at IS NOT NULL
        AND observed_at>=latest.latest_at-86400000
    )
    SELECT observed_at,listener_count,online_member_count,total_member_count,
      total_listens,current_stream_count,stream_goal
    FROM ranked WHERE rn=1 ORDER BY observed_at ASC LIMIT 300`).all();

    const rows = result.results || [];
    const latestObservedAt = Number(rows.at(-1)?.observed_at || 0) || null;
    const generatedAt = Date.now();
    return json({
      ok: true,
      generated_at: generatedAt,
      latest_observed_at: latestObservedAt,
      stale: !latestObservedAt || generatedAt - latestObservedAt > STALE_AFTER_MS,
      rows,
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'dashboard recovery error' }, 500, 'no-store');
  }
}
