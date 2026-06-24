const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=20, s-maxage=30, stale-while-revalidate=90',
  },
});

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);

  try {
    const result = await env.DB.prepare(`
      SELECT
        CAST(observed_at / 300000 AS INTEGER) * 300000 AS bucket_at,
        MAX(COALESCE(comment_velocity, 0)) AS comment_velocity
      FROM sh_channel_snapshots
      WHERE observed_at >= unixepoch('now', '-24 hours') * 1000
      GROUP BY CAST(observed_at / 300000 AS INTEGER)
      ORDER BY bucket_at ASC
      LIMIT 300
    `).all();

    return json({
      ok: true,
      generated_at: Date.now(),
      bucket_minutes: 5,
      velocity_window_minutes: 2,
      rows: result.results || [],
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'comment velocity error' }, 500);
  }
}
