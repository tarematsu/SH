import { HISTORY_24H_SQL } from './dashboard-legacy.mjs';
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
  if (!env.FACTS_DB && !env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);
  try {
    let result;
    let storageSource;
    try {
      if (!env.FACTS_DB) throw new Error('FACTS_DB binding missing');
      const facts = await loadFactsDashboard(env.FACTS_DB);
      if (!factsAreFresh(facts.latest)) throw new Error('FACTS_DB telemetry is stale');
      result = { results: facts.history };
      storageSource = 'facts-db';
    } catch (factsError) {
      if (!env.DB) throw factsError;
      console.error(JSON.stringify({
        event: 'dashboard_history_facts_fallback',
        error: String(factsError?.message || factsError),
      }));
      result = await env.DB.prepare(HISTORY_24H_SQL).all();
      storageSource = 'legacy-db';
    }
    return json({
      ok: true,
      generated_at: Date.now(),
      storage_source: storageSource,
      history: result.results || [],
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'dashboard history error' }, 500);
  }
}
