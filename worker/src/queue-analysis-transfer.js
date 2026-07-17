import { payloadHash } from '../../site/functions/lib/ingest-claim.js';

const QUEUE_STRUCTURAL_PAYLOAD = Symbol.for('stationhead.queue.structural-payload');
const QUEUE_LIKE_ANALYSIS = Symbol.for('stationhead.queue.like-analysis');
const QUEUE_TRANSFER_ANALYSIS = Symbol.for('stationhead.queue.transfer-analysis');

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function serializedQueueAnalysis(queue) {
  if (!queue) return null;
  const transfer = objectValue(queue[QUEUE_TRANSFER_ANALYSIS]);
  const structural = objectValue(queue[QUEUE_STRUCTURAL_PAYLOAD]);
  const likes = objectValue(queue?.tracks?.[QUEUE_LIKE_ANALYSIS]);
  if (!structural && !likes && !transfer) return null;
  return {
    structural: structural || transfer?.structural || null,
    likes: likes || transfer?.likes || null,
    structural_hash: transfer?.structural_hash || null,
    likes_hash: transfer?.likes_hash || null,
  };
}

export async function prepareQueueAnalysis(queue) {
  const envelope = serializedQueueAnalysis(queue);
  if (!envelope) return null;
  const [structuralHash, likesHash] = await Promise.all([
    envelope.structural ? payloadHash(envelope.structural) : null,
    envelope.likes?.complete !== false && Array.isArray(envelope.likes?.payload)
      ? payloadHash(envelope.likes.payload)
      : null,
  ]);
  const prepared = {
    ...envelope,
    structural_hash: structuralHash,
    likes_hash: likesHash,
  };
  Object.defineProperty(queue, QUEUE_TRANSFER_ANALYSIS, { value: prepared });
  return prepared;
}

export function restoredQueueTransferAnalysis(queue) {
  return objectValue(queue?.[QUEUE_TRANSFER_ANALYSIS]);
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
  Object.defineProperty(queue, QUEUE_TRANSFER_ANALYSIS, {
    value: {
      structural,
      likes,
      structural_hash: typeof envelope.structural_hash === 'string' ? envelope.structural_hash : null,
      likes_hash: typeof envelope.likes_hash === 'string' ? envelope.likes_hash : null,
    },
  });
  return queue;
}
