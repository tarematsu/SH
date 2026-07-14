import { readAuthState } from './auth-state.js';
import { jsonResponse as json } from './shared.js';

const STATE_ID = 'buddy46';

export function withAuthState(env, state) {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === '__shAuthState') return state;
      return Reflect.get(target, property, receiver);
    },
  });
}

export function authHealth(state) {
  return {
    auth_method: 'direct-api',
    auth_session_ready: Boolean(state?.authToken && state?.deviceUid),
    auth_token_expires_at: state?.tokenExpiresAt || null,
    auth_last_attempt_at: state?.lastAttemptAt || null,
    auth_last_success_at: state?.lastSuccessAt || null,
    auth_last_error: state?.lastError || null,
    browser_binding: false,
    browser_session_ready: Boolean(state?.authToken && state?.deviceUid),
    browser_token_expires_at: state?.tokenExpiresAt || null,
    browser_last_auth_attempt_at: state?.lastAttemptAt || null,
    browser_last_auth_success_at: state?.lastSuccessAt || null,
    browser_last_auth_error: state?.lastError || null,
  };
}

export async function readOptimizedHealth(env) {
  if (!env?.OTHER_DB || !env?.FACTS_DB) return json({ ok: false, error: 'health bindings missing' }, 503);
  const state = await readAuthState({ ...env, DB: env.OTHER_DB }, STATE_ID);
  const collectorId = String(env.COLLECTOR_ID || 'cloudflare-worker').trim() || 'cloudflare-worker';
  const [collector, latest] = await Promise.all([
    env.FACTS_DB.prepare(`SELECT last_run_at,last_success_at,last_error_present,updated_at
      FROM sh_collector_read_model WHERE collector_id=? LIMIT 1`).bind(collectorId).first(),
    env.FACTS_DB.prepare(`SELECT f.channel_id,c.station_id,f.observed_at
      FROM sh_minute_facts f
      LEFT JOIN sh_minute_fact_context c ON c.fact_id=f.id
      ORDER BY f.minute_at DESC,f.id DESC LIMIT 1`).first(),
  ]);
  const base = {
    ok: true,
    configured: Boolean(state?.authToken && state?.deviceUid),
    token_expires_at: state?.tokenExpiresAt || null,
    last_run_at: collector?.last_run_at || null,
    last_success_at: collector?.last_success_at || null,
    last_error: collector?.last_error_present ? 'present' : null,
    channel_id: latest?.channel_id || null,
    station_id: latest?.station_id || null,
    updated_at: collector?.updated_at || latest?.observed_at || null,
  };
  return json({ ...base, ...authHealth(state) });
}
