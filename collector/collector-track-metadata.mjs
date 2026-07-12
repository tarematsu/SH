import { cleanSpotifyTitle, highResolutionArtwork } from 'sh-shared';

export { cleanSpotifyTitle, highResolutionArtwork };

export function createTrackMetadataEnricher({ ingestUrl, ingestSecret, ingest, log }) {
  async function lookupStoredTrackMetadata(ids) {
    if (!ids.length) return new Map();
    const url = new URL(ingestUrl);
    url.searchParams.set('type', 'track_lookup');
    url.searchParams.set('ids', ids.join(','));
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${ingestSecret}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`track lookup failed ${response.status}: ${body.slice(0, 300)}`);
    }
    const data = await response.json();
    return new Map((data.tracks || []).map((t) => [t.spotify_id, t]));
  }

  async function fetchAppleMetadata(track) {
    if (!track?.apple_music_id) return null;
    const storefronts = ['JP', 'US', null];
    for (const country of storefronts) {
      const params = new URLSearchParams({ id: String(track.apple_music_id), entity: 'song' });
      if (country) params.set('country', country);
      const response = await fetch(`https://itunes.apple.com/lookup?${params}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) continue;
      const raw = await response.json();
      const item = (raw.results || []).find((v) => v.kind === 'song' && v.trackName && v.artistName)
        || (raw.results || []).find((v) => v.trackName && v.artistName);
      if (!item) continue;
      return {
        title: item.trackName,
        artist: item.artistName,
        display_title: `${item.trackName} \u2014 ${item.artistName}`,
        thumbnail_url: highResolutionArtwork(item.artworkUrl100 || item.artworkUrl60),
        source: `apple_itunes_lookup_${country || 'default'}`,
        raw,
      };
    }
    return null;
  }

  async function fetchSpotifyMetadata(track) {
    const spotifyId = track?.spotify_id;
    if (!spotifyId) return null;
    const spotifyUrl = `https://open.spotify.com/track/${encodeURIComponent(spotifyId)}`;

    const apple = await fetchAppleMetadata(track).catch((error) => {
      log('warn', `Apple metadata error id=${track.apple_music_id || '-'} ${error.message}`);
      return null;
    });

    let spotifyRaw = null;
    try {
      const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`;
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) spotifyRaw = await response.json();
    } catch (error) {
      log('warn', `Spotify oEmbed error id=${spotifyId} ${error.message}`);
    }

    if (!apple && !spotifyRaw?.title) {
      log('warn', `Track metadata unavailable spotify=${spotifyId} apple=${track.apple_music_id || '-'}`);
      return null;
    }

    const parsed = cleanSpotifyTitle(spotifyRaw?.title);
    const spotifyArtist = String(spotifyRaw?.author_name || spotifyRaw?.author || '').trim() || null;
    const resolvedArtist = apple?.artist || spotifyArtist || parsed.artist || null;
    const resolvedTitle = apple?.title || parsed.title;
    return {
      spotify_id: spotifyId,
      spotify_url: spotifyUrl,
      title: resolvedTitle,
      artist: resolvedArtist,
      display_title: apple?.display_title || (resolvedTitle && resolvedArtist ? `${resolvedTitle} \u2014 ${resolvedArtist}` : parsed.display_title),
      thumbnail_url: apple?.thumbnail_url || spotifyRaw?.thumbnail_url || null,
      source: apple ? 'apple_itunes_lookup+spotify_oembed' : 'spotify_oembed',
      fetched_at: Date.now(),
      raw: { apple: apple?.raw || null, spotify: spotifyRaw },
    };
  }

  async function enrichNewTracks(queue, observedAt) {
    const sourceTracks = [...new Map(
      (queue?.tracks || [])
        .filter((t) => t.spotify_id)
        .map((t) => [t.spotify_id, t])
    ).values()];
    if (!sourceTracks.length) return;

    const stored = await lookupStoredTrackMetadata(sourceTracks.map((t) => t.spotify_id));
    const incomplete = (value) => {
      if (!value) return true;
      const artist = String(value.artist || '').trim();
      return !value.title || !artist || /^JP[A-Z0-9]{8,}$/i.test(artist);
    };
    const missing = sourceTracks.filter((track) => incomplete(stored.get(track.spotify_id)));
    if (!missing.length) {
      log('debug', `track metadata cache hit ${sourceTracks.length}/${sourceTracks.length}`);
      return;
    }

    const tracks = [];
    for (let i = 0; i < missing.length; i += 3) {
      const chunk = missing.slice(i, i + 3);
      const results = await Promise.all(chunk.map((track) => fetchSpotifyMetadata(track).catch((error) => {
        log('warn', `Track metadata error id=${track.spotify_id}`, error.message);
        return null;
      })));
      tracks.push(...results.filter(Boolean));
    }

    if (tracks.length) {
      await ingest('track_metadata', { tracks }, observedAt);
      log('info', `track metadata saved refreshed=${tracks.length} cached=${stored.size}`);
    }
  }

  return { enrichNewTracks };
}
