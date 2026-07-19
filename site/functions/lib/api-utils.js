export function json(data, status = 200, cache = null, extraHeaders = {}) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  };
  if (cache) {
    headers['cache-control'] = cache;
    headers.vary = headers.vary || 'accept-encoding';
  }
  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}

export function authorized(request, env) {
  const expected = env.INGEST_SECRET;
  const auth = request.headers.get('authori' + 'zation') || '';
  return Boolean(expected) && auth === `${'Bear'}er ${expected}`;
}

export function ingestAccessError(request, env) {
  if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);
  return null;
}

export async function readJsonBody(request, options = {}) {
  try {
    const source = options.clone ? request.clone() : request;
    return { ok: true, body: await source.json() };
  } catch (error) {
    return { ok: false, error };
  }
}

export function observedAtFrom(body, fallback) {
  const observedAt = num(body?.observed_at);
  if (observedAt != null) return observedAt;
  return arguments.length >= 2 ? fallback : Date.now();
}

export function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function isRealIsoDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const timestamp = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().slice(0, 10) === text;
}

export function bool(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return 1;
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return 0;
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value === 0 ? 0 : 1;
  }
  return null;
}

export function text(value) {
  return value === undefined || value === null ? null : String(value);
}

export function normalizedPlaybackKey(key) {
  return String(key || '').replace(/[_\s-]+/g, '').toLowerCase();
}

export function isAppleMusicKey(key) {
  const normalized = normalizedPlaybackKey(key);
  return normalized === 'apple' || normalized.includes('applemusic');
}

export function isPreviewKey(key) {
  const normalized = normalizedPlaybackKey(key);
  return normalized === 'preview' || normalized === 'previewurl';
}

export function shouldStripPlaybackKey(key) {
  return isAppleMusicKey(key) || isPreviewKey(key);
}

export function isUnusedPublicPlaybackKey(key) {
  const normalized = normalizedPlaybackKey(key);
  return normalized === 'deezer'
    || normalized === 'deezerid'
    || normalized === 'stationheadtrackid'
    || normalized === 'displaytitle'
    || normalized === 'queueid'
    || normalized === 'queuetrackid'
    || normalized === 'isrc'
    || normalized === 'metadatafetchedat'
    || normalized === 'rawjson'
    || normalized === 'metadatarawjson'
    || normalized === 'responsetimestamp'
    || normalized === 'type';
}

export function shouldStripPublicPlaybackKey(key) {
  return shouldStripPlaybackKey(key) || isUnusedPublicPlaybackKey(key);
}

function copyPriorObjectEntries(entries, stop) {
  const output = {};
  for (let index = 0; index < stop; index += 1) {
    const [key, child] = entries[index];
    output[key] = child;
  }
  return output;
}

function stripArrayFields(value, shouldStripKey) {
  let output = null;
  for (let index = 0; index < value.length; index += 1) {
    const child = value[index];
    const stripped = stripFields(child, shouldStripKey);
    if (output) {
      output.push(stripped);
    } else if (stripped !== child) {
      output = value.slice(0, index);
      output.push(stripped);
    }
  }
  return output || value;
}

function stripObjectFields(value, shouldStripKey) {
  const entries = Object.entries(value);
  let output = null;
  for (let index = 0; index < entries.length; index += 1) {
    const [key, child] = entries[index];
    if (shouldStripKey(key)) {
      output ||= copyPriorObjectEntries(entries, index);
      continue;
    }
    const stripped = stripFields(child, shouldStripKey);
    if (output) {
      output[key] = stripped;
    } else if (stripped !== child) {
      output = copyPriorObjectEntries(entries, index);
      output[key] = stripped;
    }
  }
  return output || value;
}

function stripFields(value, shouldStripKey) {
  if (Array.isArray(value)) return stripArrayFields(value, shouldStripKey);
  if (!value || typeof value !== 'object') return value;
  return stripObjectFields(value, shouldStripKey);
}

export function stripPlaybackFields(value) {
  return stripFields(value, shouldStripPlaybackKey);
}

export function stripPlaybackPublicFields(value) {
  return stripFields(value, shouldStripPublicPlaybackKey);
}

export function stripAppleMusicFields(value) {
  return stripPlaybackFields(value);
}

function playbackJsonReplacer(key, child) {
  return shouldStripPlaybackKey(key) ? undefined : child;
}

export function rawJson(value) {
  return JSON.stringify(value ?? null, playbackJsonReplacer);
}
