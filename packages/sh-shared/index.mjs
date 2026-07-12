// Shared normalization helpers used by both collector/ (Node.js CLI) and
// worker/src (Cloudflare Worker). These are pure, value-based functions with
// no dependency on either runtime's environment (no `process.env`, no
// Workers `env` bindings) so they can be safely imported from both.

export function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function positiveNumber(value, fallback) {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function highResolutionArtwork(url) {
  return url
    ? String(url)
      .replace(/\/\d+x\d+bb\./, '/600x600bb.')
      .replace(/\/\d+x\d+-\d+\./, '/600x600-75.')
    : null;
}

export function cleanSpotifyTitle(rawTitle) {
  const cleaned = String(rawTitle || '')
    .replace(/\s*\|\s*Spotify\s*$/i, '')
    .replace(/\s*-\s*song and lyrics by\s*/i, ' \u2014 ')
    .trim();
  const parts = cleaned.split(/\s+[\u2014\u2013]\s+/);
  const title = parts[0] || rawTitle || null;
  const artist = parts.length > 1 ? parts.slice(1).join(' \u2014 ') : null;
  const displayTitle = cleaned || rawTitle || null;
  return {
    title,
    artist,
    // Both casings are provided: collector call sites read `display_title`,
    // worker call sites read `displayTitle`.
    display_title: displayTitle,
    displayTitle,
  };
}

function commentIdentity(comment) {
  if (comment?.comment_id != null) return `numeric:${comment.comment_id}`;
  const raw = String(comment?.id ?? '').trim();
  return raw ? `raw:${raw}` : null;
}

export function normalizeComments(payload, stationId, { finite } = {}) {
  const toFinite = finite || finiteNumber;
  const candidates = [payload, payload?.items, payload?.data?.items, payload?.chats?.items, payload?.chats];
  const items = candidates.find(Array.isArray) || [];
  const normalized = items.map((chat) => {
    const rawId = chat?.comment_id ?? chat?.id;
    return {
      comment_id: toFinite(rawId),
      id: rawId,
      station_id: toFinite(chat?.station_id ?? stationId),
      account_id: toFinite(chat?.account_id ?? chat?.account?.id),
      handle: chat?.account?.handle ?? null,
      text: chat?.text ?? null,
      text_with_xml: chat?.text_with_xml ?? null,
      chat_time: toFinite(chat?.chat_time),
      chat_time_ms: toFinite(chat?.chat_time_ms),
      all_access_chat: chat?.all_access_chat ?? null,
      boost_chat: chat?.boost_chat ?? null,
      followers: toFinite(chat?.account?.followers),
      following: toFinite(chat?.account?.following),
      active_stream_days: toFinite(chat?.active_stream_days ?? chat?.account?.active_stream_days),
      emoji: chat?.account?.emoji ?? null,
      raw: chat,
    };
  }).filter((comment) => comment.comment_id != null || comment.id != null);

  const seen = new Set();
  const out = [];
  for (const comment of normalized) {
    const identity = commentIdentity(comment);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    out.push(comment);
  }
  return out;
}
