const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
});

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);

  try {
    const latest = await env.DB.prepare(`
      SELECT s.observed_at,
        EXISTS(
          SELECT 1
          FROM sh_collector_heartbeats h
          WHERE ABS(h.last_seen_at - s.observed_at) <= 5000
        ) AS is_local
      FROM sh_channel_snapshots s
      ORDER BY s.observed_at DESC, s.id DESC
      LIMIT 1
    `).first();

    return json({
      ok: true,
      observed_at: latest?.observed_at ?? null,
      source: latest?.is_local ? 'Local' : 'Cloud',
    });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'source lookup failed' }, 500);
  }
}
