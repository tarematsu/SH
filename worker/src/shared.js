import { enrichIsrcTracks } from './isrc-metadata.js';
import { enrichTracks as enrichSpotifyTracks } from './track-metadata.js';

export { createShReadFetch } from './sh-read-cache.js';
export {
  cleanSpotifyTitle,
  finiteNumber,
  highResolutionArtwork,
  jsonNoStoreResponse,
  jsonResponse,
  jwtExpiryMs,
  normalizeBearer,
  normalizeComments,
  positiveNumber,
  timedFetch,
} from './shared-utils.js';
export {
  fetchTrackMetadata,
  isrcMetadataRepairRows,
  metadataNeedsRefresh,
  resetTrackMetadataQueueCache,
} from './track-metadata.js';

export async function enrichTracks(env, ingestFn, queue, observedAt, config = {}) {
  const spotifySaved = await enrichSpotifyTracks(env, ingestFn, queue, observedAt, config);
  const isrc = await enrichIsrcTracks(env, queue, config);
  if (isrc.attempted || isrc.saved) {
    console.log(JSON.stringify({
      event: 'isrc_track_metadata_enriched',
      attempted: isrc.attempted,
      saved: isrc.saved,
    }));
  }
  return spotifySaved;
}
