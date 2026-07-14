import { readAuthState } from './auth-state.js';
import { health as collectorHealth } from './collector-http.js';
import { jsonResponse as json } from './shared.js';

const STATE_ID = 'stationhead';

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
  const state = await readAuthState(env, STATE_ID);
  const base = await collectorHealth(withAuthState(env, state));
  return json({ ...base, ...authHealth(state) });
}
