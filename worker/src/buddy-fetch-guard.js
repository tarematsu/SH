function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
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

function unwrapPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  return payload.channel
    || payload.data?.channel
    || payload.data
    || payload.result?.channel
    || payload.result
    || payload;
}

function handleStationUrl(sourceUrl, alias) {
  const url = new URL(sourceUrl.toString());
  url.pathname = `/station/handle/${encodeURIComponent(alias)}/guest`;
  url.search = '';
  return url;
}

function accountHandleMatches(value, expectedAlias) {
  return String(value || '').trim().toLowerCase() === String(expectedAlias || '').trim().toLowerCase();
}

function broadcasterAccount(item) {
  return item?.account || (item?.handle ? item : null) || null;
}

function broadcasterHandleMatch(items, expectedAlias) {
  if (!Array.isArray(items)) return null;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (accountHandleMatches(broadcasterAccount(item)?.handle, expectedAlias)) return item;
  }
  return null;
}

function hasExpectedAccountHandle(source, expectedAlias) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  if (accountHandleMatches(source.account?.handle, expectedAlias)) return true;
  if (accountHandleMatches(source.host?.handle, expectedAlias)) return true;
  if (accountHandleMatches(source.host?.account?.handle, expectedAlias)) return true;
  return Boolean(
    broadcasterHandleMatch(source.broadcast?.broadcasters, expectedAlias)
    || broadcasterHandleMatch(source.current_station?.broadcast?.broadcasters, expectedAlias),
  );
}

function hostBroadcaster(source, expectedAlias) {
  const matched = broadcasterHandleMatch(source?.broadcast?.broadcasters, expectedAlias)
    || broadcasterHandleMatch(source?.current_station?.broadcast?.broadcasters, expectedAlias);
  if (matched) {
    if (matched.is_host !== undefined) return matched;
    return { ...matched, is_host: true };
  }
  const account = source?.account || source?.host?.account || (source?.host?.handle ? source.host : null);
  if (!account) return null;
  return {
    is_host: true,
    account_id: source?.account_id ?? source?.host_account_id ?? account.id ?? null,
    account,
  };
}

function stationIdFromShareUrl(value) {
  const match = String(value || '').match(/station\/(\d+)/i);
  return match ? Number(match[1]) : null;
}

function attachHostBroadcaster(station, source, expectedAlias) {
  const broadcaster = hostBroadcaster(source, expectedAlias);
  if (!broadcaster) return;
  const broadcast = station.broadcast || source.broadcast || {};
  const broadcasters = Array.isArray(broadcast.broadcasters) ? broadcast.broadcasters : null;
  if (!broadcasters?.length) {
    broadcast.broadcasters = [broadcaster];
  } else if (!broadcasterHandleMatch(broadcasters, expectedAlias)) {
    broadcast.broadcasters = [broadcaster, ...broadcasters];
  }
  station.broadcast = broadcast;
}

function adaptHandleStationPayload(source, expectedAlias) {
  const expected = String(expectedAlias || 'buddy46').trim().toLowerCase() || 'buddy46';
  const queue = source?.current_station?.queue || source?.queue || null;
  const station = source?.current_station
    || source?.station
    || source?.broadcast?.station
    || {};
  const stationId = station.id
    ?? source.current_station_id
    ?? queue?.station_id
    ?? source.station_id
    ?? source.id
    ?? stationIdFromShareUrl(source.share_url);
  station.id = stationId;
  if (!present(station.is_broadcasting) && present(source.is_broadcasting)) {
    station.is_broadcasting = source.is_broadcasting;
  }
  if (!station.queue && queue) station.queue = queue;
  attachHostBroadcaster(station, source, expected);
  source.alias = expected;
  source.channel_alias = expected;
  if (!present(source.current_station_id)) source.current_station_id = stationId;
  source.current_station = station;
  return source;
}

export function normalizeBuddyQueuePayload(payload, expectedAlias = 'buddy46') {
  const source = unwrapPayload(payload);
  if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
  const expected = String(expectedAlias || 'buddy46').trim().toLowerCase() || 'buddy46';
  const expectedHandle = hasExpectedAccountHandle(source, expected);
  const normalized = expectedHandle ? adaptHandleStationPayload(source, expected) : source;
  const sourceAlias = String(
    normalized.alias
      || normalized.channel_alias
      || normalized.slug
      || expected,
  ).trim().toLowerCase() || expected;
  normalized.alias = expectedHandle ? expected : sourceAlias;
  normalized.channel_alias = normalized.alias;

  let station = normalized.current_station
    || normalized.station
    || normalized.broadcast?.station
    || null;
  if (!station && (normalized.current_station_id || normalized.queue || normalized.id)) {
    station = {
      id: normalized.current_station_id ?? normalized.queue?.station_id ?? normalized.id,
      is_broadcasting: normalized.is_broadcasting,
      queue: normalized.queue,
    };
  }

  if (station && typeof station === 'object' && !Array.isArray(station)) {
    if (!station.queue && normalized.queue) station.queue = normalized.queue;
    if (!present(station.id)) {
      station.id = normalized.current_station_id
        ?? normalized.queue?.station_id
        ?? normalized.station_id
        ?? normalized.id
        ?? stationIdFromShareUrl(normalized.share_url);
    }
    if (!present(station.is_broadcasting) && present(normalized.is_broadcasting)) {
      station.is_broadcasting = normalized.is_broadcasting;
    }
    normalized.current_station = station;
  }
  return normalized;
}

export function validateBuddyQueuePayload(payload, expectedAlias = 'buddy46') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Stationhead buddy playback response is not an object');
  }

  const actualAlias = String(payload.alias || payload.channel_alias || '').trim().toLowerCase();
  if (!actualAlias) throw new Error('Stationhead buddy playback response is missing channel alias');
  if (actualAlias !== String(expectedAlias).trim().toLowerCase()) {
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
    const value = requestUrl(input);
    if (!value) return baseFetch(input, init);
    const url = new URL(value);
    const channelMatch = url.pathname.match(/\/channels\/alias\/([^/]+)$/i);
    const handleMatch = url.pathname.match(/\/station\/handle\/([^/]+)\/guest$/i);
    const requestedAlias = decodeURIComponent(channelMatch?.[1] || handleMatch?.[1] || '').toLowerCase();
    if (requestedAlias !== expectedAlias.toLowerCase()) {
      return baseFetch(input, init);
    }

    const requestUrlValue = channelMatch ? handleStationUrl(url, expectedAlias).toString() : url.toString();
    const response = await baseFetch(requestUrlValue, {
      ...init,
      method: 'POST',
      body: '',
    });
    if (!response?.ok) return response;

    const payload = normalizeBuddyQueuePayload(await response.clone().json(), expectedAlias);
    validateBuddyQueuePayload(payload, expectedAlias);
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.delete('content-length');
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
