const QUEUE_STRUCTURAL_PAYLOAD = Symbol.for('stationhead.queue.structural-payload');
const QUEUE_LIKE_ANALYSIS = Symbol.for('stationhead.queue.like-analysis');

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function serializedQueueAnalysis(queue) {
  if (!queue) return null;
  const structural = objectValue(queue[QUEUE_STRUCTURAL_PAYLOAD]);
  const likes = objectValue(queue?.tracks?.[QUEUE_LIKE_ANALYSIS]);
  if (!structural && !likes) return null;
  return {
    structural: structural || null,
    likes: likes || null,
  };
}

export function restoreQueueAnalysis(queue, envelope) {
  if (!queue || !envelope) return queue;
  const structural = objectValue(envelope.structural);
  const likes = objectValue(envelope.likes);
  const trackCount = Array.isArray(queue.tracks) ? queue.tracks.length : 0;
  if (structural
      && Array.isArray(structural.tracks)
      && structural.tracks.length === trackCount) {
    Object.defineProperty(queue, QUEUE_STRUCTURAL_PAYLOAD, { value: structural });
  }
  if (likes && Array.isArray(likes.payload) && Array.isArray(queue.tracks)) {
    Object.defineProperty(queue.tracks, QUEUE_LIKE_ANALYSIS, {
      value: {
        complete: likes.complete !== false,
        payload: likes.payload,
      },
    });
  }
  return queue;
}
