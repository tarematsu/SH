import commentsWorker from './comments-entry.js';

const activeCommentsEnvs = new WeakMap();

function compactTrackIdentities(tracks) {
  const compactTracks = new Array(tracks.length);
  let compactCount = 0;
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    if (!track || typeof track !== 'object') continue;
    const spotifyId = track.spotify_id;
    const isrc = track.isrc;
    if (spotifyId == null) {
      if (isrc != null) compactTracks[compactCount++] = { isrc };
      continue;
    }
    compactTracks[compactCount++] = isrc == null
      ? { spotify_id: spotifyId }
      : { spotify_id: spotifyId, isrc };
  }
  compactTracks.length = compactCount;
  return compactTracks;
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
          tracks: compactTrackIdentities(tracks),
        },
      },
    },
  };
}

export function compactCommentsEnv(env) {
  const metadataQueue = env?.TRACK_METADATA_QUEUE;
  if (typeof metadataQueue?.send !== 'function') return env;

  const cached = activeCommentsEnvs.get(env);
  if (cached?.metadataQueue === metadataQueue) return cached.active;

  const active = Object.create(env);
  Object.defineProperty(active, 'TRACK_METADATA_QUEUE', {
    enumerable: false,
    value: {
      send(body, options) {
        return metadataQueue.send(compactCommittedMetadataMessage(body), options);
      },
    },
  });
  activeCommentsEnvs.set(env, { metadataQueue, active });
  return active;
}

export default {
  queue(batch, env, ctx) {
    return commentsWorker.queue(batch, compactCommentsEnv(env), ctx);
  },
  fetch: commentsWorker.fetch,
};
