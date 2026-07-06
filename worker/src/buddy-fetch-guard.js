import { collectBuddyPlaybackReady } from './buddy-runtime.js';

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return Boolean(value);
}

export function validateBuddyQueuePayload(payload, expectedAlias = 'buddy46') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Stationhead buddy playback response is not an object');
  }

  const actualAlias = String(payload.alias || payload.channel_alias || '').trim().toLowerCase();
  if (actualAlias && actualAlias !== String(expectedAlias).trim().toLowerCase()) {
    throw new Error(`Stationhead alias mismatch: expected ${expectedAlias}, received ${actualAlias}`);
  }

  const station = payload.current_station || {};
  const broadcasting = booleanValue(station.is_broadcasting ?? payload.is_broadcasting);
  const queue = station.queue || payload.queue || null;
  if (broadcasting && !queue) {
    throw new Error('Stationhead buddy playback response is broadcasting without a queue');
  }
  if (
    broadcasting
    && !Object.prototype.hasOwnProperty.call(queue, 'queue_tracks')
    && !Object.prototype.hasOwnProperty.call(queue, 'tracks')
  ) {
    throw new Error('Stationhead buddy playback response is missing queue tracks');
  }
  const tracks = queue?.queue_tracks ?? queue?.tracks;
  if (tracks !== undefined && !Array.isArray(tracks)) {
    throw new Error('Stationhead buddy playback queue tracks are not an array');
  }
  return payload;
}

export function createBuddyGuardedFetch(baseFetch = fetch, expectedAlias = 'buddy46') {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (!response?.ok) return response;

    const url = new URL(typeof input === 'string' ? input : input.url);
    const match = url.pathname.match(/\/channels\/alias\/([^/]+)$/i);
    if (!match || decodeURIComponent(match[1]).toLowerCase() !== expectedAlias.toLowerCase()) {
      return response;
    }

    const payload = await response.clone().json();
    validateBuddyQueuePayload(payload, expectedAlias);
    return response;
  };
}

export function collectBuddyPlaybackGuarded(env, observedAt = Date.now(), dependencies = {}) {
  const alias = String(env?.BUDDY_PLAYBACK_ALIAS || 'buddy46').trim().toLowerCase() || 'buddy46';
  const baseFetch = dependencies.fetch || fetch;
  return collectBuddyPlaybackReady(env, observedAt, {
    ...dependencies,
    fetch: createBuddyGuardedFetch(baseFetch, alias),
  });
}
