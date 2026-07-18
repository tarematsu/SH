import commentsWorker from './comments-entry.js';

function compactTrackIdentity(track) {
  if (!track || typeof track !== 'object') return null;
  const compact = {};
  if (track.spotify_id != null) compact.spotify_id = track.spotify_id;
  if (track.isrc != null) compact.isrc = track.isrc;
  return Object.keys(compact).length ? compact : null;
}

export function compactCommittedMetadataMessage(body) {
  if (body?.message_type !== 'stationhead-track-metadata'
      || Number(body?.message_version) !== 1
      || body?.task !== 'committed-enrichment') return body;

  const job = body.job;
  const payload = job?.payload;
  const tracks = payload?.queue?.tracks;
  if (!job?.jobId || !Array.isArray(tracks)) return body;

  return {
    message_type: body.message_type,
    message_version: 1,
    task: body.task,
    job: {
      jobId: job.jobId,
      payload: {
        observedAt: payload.observedAt,
        queue: {
          tracks: tracks.map(compactTrackIdentity).filter(Boolean),
        },
      },
    },
  };
}

export function compactCommentsEnv(env) {
  const metadataQueue = env?.TRACK_METADATA_QUEUE;
  if (!metadataQueue?.send) return env;

  const active = Object.create(env || null);
  Object.defineProperty(active, 'TRACK_METADATA_QUEUE', {
    enumerable: false,
    value: {
      send(body, options) {
        return metadataQueue.send(compactCommittedMetadataMessage(body), options);
      },
    },
  });
  return active;
}

export default {
  queue(batch, env, ctx) {
    return commentsWorker.queue(batch, compactCommentsEnv(env), ctx);
  },
  fetch(request, env, ctx) {
    return commentsWorker.fetch(request, compactCommentsEnv(env), ctx);
  },
};
