import {
  bestText,
  canonical,
  cleanText,
  looksLikeId,
  looksLikePlaceholder,
} from './track-history-text.js';

const ID_FIELDS = [
  ['isrc', 'isrc'],
  ['spotify_id', 'spotify'],
  ['apple_music_id', 'apple'],
  ['stationhead_track_id', 'stationhead'],
  ['queue_track_id', 'queue'],
];

function positiveCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 1;
}

function finiteTime(value, fallback = null) {
  const time = Number(value);
  return Number.isFinite(time) ? time : fallback;
}

function normalizedId(field, value) {
  const id = cleanText(value);
  if (!id || looksLikePlaceholder(id)) return null;
  return field === 'isrc' ? id.toUpperCase() : id;
}

function rowIdentifiers(row) {
  const identifiers = [];
  for (const [field, prefix] of ID_FIELDS) {
    const value = normalizedId(field, row?.[field]);
    if (value) identifiers.push({ field, prefix, value, token: `${prefix}:${value}` });
  }
  return identifiers;
}

function unionFind(size) {
  const parent = Array.from({ length: size }, (_, index) => index);
  const rank = new Uint8Array(size);
  const find = (value) => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const union = (left, right) => {
    let a = find(left);
    let b = find(right);
    if (a === b) return a;
    if (rank[a] < rank[b]) [a, b] = [b, a];
    parent[b] = a;
    if (rank[a] === rank[b]) rank[a] += 1;
    return a;
  };
  return { find, union };
}

function mergeAliases(entries, uf) {
  const owners = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const aliases = entry.identifiers.map((item) => `${entry.playDate}|id:${item.token}`);
    if (entry.titleResolved && entry.artist) {
      aliases.push(`${entry.playDate}|name:${canonical(entry.title)}|artist:${canonical(entry.artist)}`);
    }
    for (const alias of aliases) {
      const owner = owners.get(alias);
      if (owner == null) owners.set(alias, index);
      else uf.union(index, owner);
    }
  }
}

function mergeUniqueTitleFallbacks(entries, uf) {
  const components = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const root = uf.find(index);
    let component = components.get(root);
    if (!component) {
      component = {
        root,
        playDate: entries[index].playDate,
        titles: new Set(),
        artists: new Set(),
        hasIdentifiers: false,
      };
      components.set(root, component);
    }
    const entry = entries[index];
    if (entry.titleResolved) component.titles.add(canonical(entry.title));
    if (entry.artist) component.artists.add(canonical(entry.artist));
    if (entry.identifiers.length) component.hasIdentifiers = true;
  }

  const resolvedByTitle = new Map();
  for (const component of components.values()) {
    if (!component.artists.size) continue;
    for (const title of component.titles) {
      const key = `${component.playDate}|${title}`;
      let roots = resolvedByTitle.get(key);
      if (!roots) {
        roots = new Set();
        resolvedByTitle.set(key, roots);
      }
      roots.add(component.root);
    }
  }

  for (const component of components.values()) {
    if (component.artists.size || component.hasIdentifiers || component.titles.size !== 1) continue;
    const title = component.titles.values().next().value;
    const candidates = resolvedByTitle.get(`${component.playDate}|${title}`);
    if (candidates?.size === 1) uf.union(component.root, candidates.values().next().value);
  }
}

function firstValue(values) {
  return values?.size ? values.values().next().value : null;
}

function aggregateEntries(entries, uf) {
  const merged = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const root = uf.find(index);
    const playCount = positiveCount(entry.row.play_count);
    const firstPlayedAt = finiteTime(entry.row.first_played_at, finiteTime(entry.row.played_at));
    const lastPlayedAt = finiteTime(entry.row.last_played_at, finiteTime(entry.row.played_at));
    let current = merged.get(root);
    if (!current) {
      current = {
        play_date: entry.playDate,
        title: entry.titleResolved ? entry.title : '曲情報なし',
        artist: entry.artist,
        spotify_url: entry.row.spotify_url || null,
        play_count: 0,
        first_played_at: null,
        last_played_at: null,
        ids: new Map(ID_FIELDS.map(([field]) => [field, new Set()])),
      };
      merged.set(root, current);
    }

    current.play_count += playCount;
    if (firstPlayedAt != null) {
      current.first_played_at = current.first_played_at == null
        ? firstPlayedAt : Math.min(current.first_played_at, firstPlayedAt);
    }
    if (lastPlayedAt != null) {
      current.last_played_at = current.last_played_at == null
        ? lastPlayedAt : Math.max(current.last_played_at, lastPlayedAt);
    }
    current.title = bestText(current.title, entry.title) || current.title;
    current.artist = bestText(current.artist, entry.artist);
    if (!current.spotify_url && entry.row.spotify_url) current.spotify_url = entry.row.spotify_url;
    for (const identifier of entry.identifiers) current.ids.get(identifier.field).add(identifier.value);
  }

  const output = [];
  for (const current of merged.values()) {
    const isrc = firstValue(current.ids.get('isrc'));
    const spotifyId = firstValue(current.ids.get('spotify_id'));
    const appleMusicId = firstValue(current.ids.get('apple_music_id'));
    const stationheadTrackId = firstValue(current.ids.get('stationhead_track_id'));
    const queueTrackId = firstValue(current.ids.get('queue_track_id'));
    const strongest = isrc ? `isrc:${isrc}`
      : spotifyId ? `spotify:${spotifyId}`
        : appleMusicId ? `apple:${appleMusicId}`
          : stationheadTrackId ? `stationhead:${stationheadTrackId}`
            : queueTrackId ? `queue:${queueTrackId}`
              : `name:${canonical(current.title)}|artist:${canonical(current.artist)}`;
    output.push({
      play_date: current.play_date,
      track_key: strongest,
      title: current.title,
      artist: current.artist,
      spotify_id: spotifyId,
      apple_music_id: appleMusicId,
      isrc,
      stationhead_track_id: stationheadTrackId,
      queue_track_id: queueTrackId,
      spotify_url: current.spotify_url,
      play_count: current.play_count,
      first_played_at: current.first_played_at,
      last_played_at: current.last_played_at,
      source_ids: [
        ...current.ids.get('spotify_id'),
        ...current.ids.get('apple_music_id'),
        ...current.ids.get('isrc'),
      ],
    });
  }
  return output;
}

export function mergeTrackRows(rows) {
  const entries = (rows || []).map((row) => {
    const title = bestText(row.title, row.raw_title, row.display_title, row.spotify_id, row.isrc);
    const artist = bestText(row.artist, row.raw_artist);
    return {
      row,
      playDate: row.play_date,
      title: title || '曲情報なし',
      titleResolved: Boolean(title && title !== '曲情報なし' && !looksLikeId(title)),
      artist,
      identifiers: rowIdentifiers(row),
    };
  });
  if (!entries.length) return [];

  const uf = unionFind(entries.length);
  mergeAliases(entries, uf);
  mergeUniqueTitleFallbacks(entries, uf);
  return aggregateEntries(entries, uf).sort((a, b) =>
    b.play_date.localeCompare(a.play_date)
    || b.play_count - a.play_count
    || a.title.localeCompare(b.title, 'ja')
  );
}
