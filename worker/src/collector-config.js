import { jwtExpiryMs, normalizeBearer, positiveNumber as numberValue } from './shared.js';
import { sanitizeFailureDetail } from './collector-failure.js';

export const API_BASE = 'https://production1.stationhead.com';
export const COLLECTOR_VERSION = '1.0.0-worker';
export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

export function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

export function configFromEnv(env) {
  return {
    channelAlias: env.CHANNEL_ALIAS || 'buddies',
    chatLimit: Math.min(numberValue(env.CHAT_LIMIT, 100), 100),
    appVersion: env.STATIONHEAD_APP_VERSION || '1.0.0',
    collectorId: env.COLLECTOR_ID || 'cloudflare-worker',
    metadataLimit: Math.min(numberValue(env.METADATA_LIMIT, 3), 10),
    requestTimeoutMs: Math.min(numberValue(env.REQUEST_TIMEOUT_MS, 15_000), 30_000),
  };
}

export function stationheadHeaders(state, config) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
    authorization: `Bearer ${state.authToken}`,
    'app-platform': 'web',
    'app-version': config.appVersion,
    'content-type': 'application/json',
    origin: 'https://www.stationhead.com',
    referer: 'https://www.stationhead.com/',
    'sth-device-uid': state.deviceUid,
    'user-agent': DEFAULT_USER_AGENT,
  };
}

export async function stationheadJson(state, config, path) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: stationheadHeaders(state, config),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  const refreshed = normalizeBearer(response.headers.get('authorization'));
  if (refreshed && refreshed !== state.authToken) {
    state.authToken = refreshed;
    state.tokenExpiresAt = jwtExpiryMs(refreshed);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 401) {
      throw new Error(`Stationhead session expired (401). Refresh collector/.stationhead-session.json and update Worker secrets. ${body.slice(0, 200)}`);
    }
    throw new Error(`Stationhead API ${response.status}: ${path}${body ? ` | ${body.slice(0, 300)}` : ''}`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Stationhead API invalid JSON: ${path} | ${sanitizeFailureDetail(error?.message || error)}`);
  }
}
