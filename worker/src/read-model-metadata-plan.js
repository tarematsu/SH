function normalizedIdentity(value) {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function hasTrackIdentity(track) {
  return Boolean(
    String(track?.spotify_id || '').trim()
      || normalizedIdentity(track?.isrc),
  );
}

function hydrationGap(queue) {
  const tracks = queue?.tracks;
  if (!Array.isArray(tracks)) return false;
  const trackCount = tracks.length;
  for (let index = 0; index < trackCount; index += 1) {
    const track = tracks[index];
    if (!track || typeof track !== 'object') continue;
    if (!track.title || !track.artist || !track.thumbnail_url) return true;
  }
  return false;
}

function preservationGap(queue) {
  const tracks = queue?.tracks;
  if (!Array.isArray(tracks)) return false;
  const trackCount = tracks.length;
  for (let index = 0; index < trackCount; index += 1) {
    const track = tracks[index];
    if (!track || typeof track !== 'object' || !hasTrackIdentity(track)) continue;
    if (!track.title || !track.artist || !track.album_name || !track.thumbnail_url) return true;
  }
  return false;
}

export function queueNeedsHydration(queue) {
  return hydrationGap(queue);
}

export function queueNeedsPreservation(queue) {
  return preservationGap(queue);
}

export function readModelNeedsHydration(readModel) {
  return queueNeedsHydration(readModel?.queue?.value);
}

export function readModelNeedsPreservation(readModel) {
  return queueNeedsPreservation(readModel?.queue?.value);
}
