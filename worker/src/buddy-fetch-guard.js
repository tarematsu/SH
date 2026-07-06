function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return Boolean(value);
}

function present(value) {
  return value !== undefined && value !== null && value !== '';
}

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input?.url;
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
  const broadcastingValue = station.is_broadcasting ?? payload.is_broadcasting;
  const broadcastingKnown = present(broadcastingValue);
  const broadcasting = booleanValue(broadcastingValue);
  const queue = station.queue || payload.queue || null;
  if (!queue && !broadcastingKnown) {
    throw new Error('Stationhead buddy playback response is missing broadcasting state and queue');
  }
  if (broadcasting && !queue) {
    throw new Error('Stationhead buddy playback response is broadcasting without a queue');
  }

  const hasQueueTracks = Boolean(queue)
    && Object.prototype.hasOwnProperty.call(queue, 'queue_tracks');
  const hasTracks = Boolean(queue)
    && Object.prototype.hasOwnProperty.call(queue, 'tracks');
  if (broadcasting && !hasQueueTracks && !hasTracks) {
    throw new Error('Stationhead buddy playback response is missing queue tracks');
  }
  const tracks = hasQueueTracks ? queue.queue_tracks : hasTracks ? queue.tracks : undefined;
  if ((hasQueueTracks || hasTracks) && !Array.isArray(tracks)) {
    throw new Error('Stationhead buddy playback queue tracks are not an array');
  }
  return payload;
}

export function createBuddyGuardedFetch(baseFetch = fetch, expectedAlias = 'buddy46') {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (!response?.ok) return response;

    const value = requestUrl(input);
    if (!value) return response;
    const url = new URL(value);
    const match = url.pathname.match(/\/channels\/alias\/([^/]+)$/i);
    if (!match || decodeURIComponent(match[1]).toLowerCase() !== expectedAlias.toLowerCase()) {
      return response;
    }

    const payload = await response.clone().json();
    validateBuddyQueuePayload(payload, expectedAlias);
    return response;
  };
}
