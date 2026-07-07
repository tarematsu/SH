import { HISTORY_24H_SQL } from './dashboard-legacy.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    vary: 'accept-encoding',
  },
});

export async function onRequestGet({ env }) {
  const db = env.DB;
  if (!db) return json({ ok: false, error: 'DB binding missing' }, 500);
  try {
    const result = await db.prepare(HISTORY_24H_SQL).all();
    return json({
      ok: true,
      generated_at: Date.now(),
      history: result.results || [],
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'dashboard history error' }, 500);
  }
}
