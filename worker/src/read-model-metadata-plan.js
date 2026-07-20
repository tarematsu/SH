function normalizedIdentity(value) {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function hasTrackIdentity(track) {
  return Boolean(
    String(track?.spotify_id || '').trim()
      || normalizedIdentity(track?.isrc),
  );
}

function tracksFromQueue(queue) {
  return Array.isArray(queue?.tracks) ? queue.tracks : null;
}

export function queueNeedsHydration(queue) {
  const tracks = tracksFromQueue(queue);
  if (!tracks) return false;
  const trackCount = tracks.length;
  for (let index = 0; index < trackCount; index += 1) {
    const track = tracks[index];
    if (!track || typeof track !== 'object') continue;
    if (!track.title || !track.artist || !track.thumbnail_url) return true;
  }
  return false;
}

export function queueNeedsPreservation(queue) {
  const tracks = tracksFromQueue(queue);
  if (!tracks) return false;
  const trackCount = tracks.length;
  for (let index = 0; index < trackCount; index += 1) {
    const track = tracks[index];
    if (!track || typeof track !== 'object' || !hasTrackIdentity(track)) continue;
    if (!track.title || !track.artist || !track.album_name || !track.thumbnail_url) return true;
  }
  return false;
}

export function readModelMetadataTask(readModel) {
  const tracks = tracksFromQueue(readModel?.queue?.value);
  if (!tracks) return null;
  let preserve = false;
  const trackCount = tracks.length;
  for (let index = 0; index < trackCount; index += 1) {
    const track = tracks[index];
    if (!track || typeof track !== 'object') continue;
    if (!track.title || !track.artist || !track.thumbnail_url) return 'read-model-hydration';
    if (!track.album_name && hasTrackIdentity(track)) preserve = true;
  }
  return preserve ? 'read-model-preserve' : null;
}

export function readModelNeedsHydration(readModel) {
  return queueNeedsHydration(readModel?.queue?.value);
}

export function readModelNeedsPreservation(readModel) {
  return queueNeedsPreservation(readModel?.queue?.value);
}
