import { combinedAbortSignal } from './request-signal.js';

const RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const USER_AGENT = 'stationhead-monitor/1.0 (https://github.com/tarematsu/SH)';

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export function normalizeIsrc(value) {
  const normalized = String(value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalized) ? normalized : null;
}

export function musicBrainzRecordingMetadata(payload, isrc, fetchedAt = Date.now()) {
  const recordings = Array.isArray(payload?.recordings) ? payload.recordings : [];
  const recording = recordings.find((item) => text(item?.title)) || null;
  if (!recording) return null;
  const artists = (Array.isArray(recording['artist-credit']) ? recording['artist-credit'] : [])
    .map((credit) => text(credit?.name || credit?.artist?.name))
    .filter(Boolean);
  const title = text(recording.title);
  const artist = artists.join(' & ') || null;
  if (!title || !artist) return null;
  return {
    isrc,
    title,
    artist,
    source: 'musicbrainz',
    fetched_at: fetchedAt,
    raw_json: JSON.stringify({ recording_id: recording.id || null }),
  };
}

export async function fetchIsrcMetadata(isrc, config = {}) {
  const normalized = normalizeIsrc(isrc);
  if (!normalized) return null;
  const url = `https://musicbrainz.org/ws/2/isrc/${encodeURIComponent(normalized)}?inc=artist-credits&fmt=json`;
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': USER_AGENT,
    },
    signal: combinedAbortSignal(config.collectionSignal, config.requestTimeoutMs),
  }).catch(() => null);
  if (!response?.ok) return null;
  const payload = await response.json().catch(() => null);
  return musicBrainzRecordingMetadata(payload, normalized);
}

async function applyIsrcMetadataToTracks(db, row) {
  if (!row?.title || !row?.artist) return;
  await db.prepare(`UPDATE sh_tracks SET
      title=CASE WHEN title IS NULL OR TRIM(title)='' OR title=spotify_id THEN ? ELSE title END,
      artist=CASE WHEN artist IS NULL OR TRIM(artist)='' OR artist=spotify_id
        OR artist GLOB 'JP[A-Z0-9]*' THEN ? ELSE artist END
    WHERE UPPER(REPLACE(isrc,'-',''))=?`)
    .bind(row.title, row.artist, row.isrc).run();
}

async function persistIsrcMetadata(db, row) {
  await db.prepare(`INSERT INTO sh_isrc_metadata(isrc,title,artist,source,fetched_at,raw_json)
    VALUES(?,?,?,?,?,?) ON CONFLICT(isrc) DO UPDATE SET
      title=COALESCE(excluded.title,sh_isrc_metadata.title),
      artist=COALESCE(excluded.artist,sh_isrc_metadata.artist),
      source=excluded.source,
      fetched_at=MAX(excluded.fetched_at,sh_isrc_metadata.fetched_at),
      raw_json=COALESCE(excluded.raw_json,sh_isrc_metadata.raw_json)`)
    .bind(row.isrc, row.title, row.artist, row.source, row.fetched_at, row.raw_json).run();
  await applyIsrcMetadataToTracks(db, row);
}

export async function enrichIsrcTracks(env, queue, config = {}, dependencies = {}) {
  const db = env?.MINUTE_DB || env?.DB;
  if (!db) return { saved: 0, attempted: 0 };
  const configuredLimit = config.isrcMetadataLimit ?? env?.ISRC_METADATA_LIMIT ?? 0;
  const limit = Math.max(0, Math.min(1, Math.floor(Number(configuredLimit) || 0)));
  if (!limit) return { saved: 0, attempted: 0 };

  const candidates = [...new Set((queue?.tracks || []).map((track) => normalizeIsrc(track?.isrc)).filter(Boolean))];
  if (!candidates.length) return { saved: 0, attempted: 0 };
  const now = Date.now();
  const placeholders = candidates.map(() => '?').join(',');
  let stored;
  try {
    stored = await db.prepare(`SELECT isrc,title,artist,fetched_at FROM sh_isrc_metadata
      WHERE isrc IN (${placeholders})`).bind(...candidates).all();
  } catch {
    return { saved: 0, attempted: 0, skipped: 'isrc-metadata-table-missing' };
  }
  const storedByIsrc = new Map((stored.results || []).map((row) => [String(row.isrc), row]));
  for (const row of stored.results || []) await applyIsrcMetadataToTracks(db, row);
  const retryable = candidates.filter((isrc) => {
    const row = storedByIsrc.get(isrc);
    if (text(row?.title) && text(row?.artist)) return false;
    return now - Number(row?.fetched_at || 0) >= RETRY_MS;
  }).slice(0, limit);
  if (!retryable.length) return { saved: 0, attempted: 0 };

  const fetchMetadata = dependencies.fetchMetadata || fetchIsrcMetadata;
  let saved = 0;
  for (const isrc of retryable) {
    const metadata = await fetchMetadata(isrc, config);
    const row = metadata || {
      isrc,
      title: null,
      artist: null,
      source: 'musicbrainz_not_found',
      fetched_at: now,
      raw_json: null,
    };
    await persistIsrcMetadata(db, row);
    if (metadata) saved += 1;
  }
  return { saved, attempted: retryable.length };
}
