import { factsAreFresh, loadFactsDashboard } from '../lib/dashboard-facts.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    vary: 'accept-encoding',
  },
});

export async function onRequestGet({ env }) {
  if (!env.MINUTE_DB) return json({ ok: false, error: 'MINUTE_DB binding missing' }, 500);
  try {
    const facts = await loadFactsDashboard(env.MINUTE_DB);
    if (!factsAreFresh(facts.latest)) return json({ ok: false, error: 'MINUTE_DB telemetry is stale' }, 503);
    const result = { results: facts.history };
    return json({
      ok: true,
      generated_at: Date.now(),
      storage_source: 'facts-db',
      history: result.results || [],
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'dashboard history error' }, 500);
  }
}
