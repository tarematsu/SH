import { bestText, canonical, looksLikeId } from './track-history-text.js';

export function mergeTrackRows(rows) {
  const merged = new Map();
  for (const row of rows) {
    const title = bestText(row.title, row.raw_title, row.display_title, row.spotify_id, row.isrc) || '曲情報なし';
    const artist = bestText(row.artist, row.raw_artist);
    const resolved = title !== '曲情報なし' && !looksLikeId(title);
    const identity = resolved
      ? `name:${canonical(title)}|artist:${canonical(artist)}`
      : `id:${row.spotify_id || row.isrc || row.apple_music_id || row.stationhead_track_id || row.queue_track_id || row.position}`;
    const key = `${row.play_date}|${identity}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, {
        play_date: row.play_date,
        track_key: identity,
        title,
        artist,
        spotify_url: row.spotify_url || null,
        play_count: 1,
        first_played_at: row.played_at,
        last_played_at: row.played_at,
        source_ids: [row.spotify_id, row.apple_music_id, row.isrc].filter(Boolean),
      });
      continue;
    }
    current.play_count += 1;
    current.first_played_at = Math.min(current.first_played_at, row.played_at);
    current.last_played_at = Math.max(current.last_played_at, row.played_at);
    if ((!current.artist || looksLikeId(current.artist)) && artist) current.artist = artist;
    if ((!current.title || looksLikeId(current.title)) && title) current.title = title;
    if (!current.spotify_url && row.spotify_url) current.spotify_url = row.spotify_url;
    for (const id of [row.spotify_id, row.apple_music_id, row.isrc]) {
      if (id && !current.source_ids.includes(id)) current.source_ids.push(id);
    }
  }
  return [...merged.values()].sort((a, b) =>
    b.play_date.localeCompare(a.play_date)
    || b.play_count - a.play_count
    || a.title.localeCompare(b.title, 'ja')
  );
}
