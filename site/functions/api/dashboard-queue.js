import { num } from '../lib/api-utils.js';
import { computePlayback as computePlaybackWithAnchors, normalizePlaybackTrack } from '../lib/playback.js';
import { LATEST_QUEUE_WITH_ITEMS_SQL, parseLatestQueueRows } from '../lib/latest-queue.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 40;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    vary: 'accept-encoding',
  },
});

function boundedInteger(value, fallback, min, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ ok: false, error: 'DB binding missing' }, 500);
  try {
    const url = new URL(request.url);
    const offset = boundedInteger(url.searchParams.get('offset'), 11, 0, 200);
    const limit = boundedInteger(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const result = await db.prepare(LATEST_QUEUE_WITH_ITEMS_SQL).all();
    const { latestQueue, queue } = parseLatestQueueRows(result.results || []);
    const generatedAt = Date.now();
    const playback = computePlaybackWithAnchors(queue, generatedAt);
    const startIndex = Math.max(0, playback.currentIndex);
    const absoluteOffset = startIndex + offset;
    const window = queue.slice(absoluteOffset, absoluteOffset + limit);
    const tracks = window.map((track, index) => (
      normalizePlaybackTrack(track, absoluteOffset + index, playback)
    ));
    return json({
      ok: true,
      generated_at: generatedAt,
      queue_observed_at: num(latestQueue?.observed_at),
      offset,
      limit,
      loaded_items: Math.min(queue.length - startIndex, offset + tracks.length),
      total_items: queue.length,
      has_more: absoluteOffset + tracks.length < queue.length,
      queue: tracks,
    });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'dashboard queue error' }, 500);
  }
}
