import { bestText, canonical, cleanText, looksLikeId, looksLikePlaceholder } from './track-history-text.js';

const ID_FIELDS = [
  ['isrc', 'isrc'],
  ['spotify_id', 'spotify'],
  ['stationhead_track_id', 'stationhead'],
  ['queue_track_id', 'queue'],
];

const positiveCount = (value) => Number.isFinite(Number(value)) && Number(value) > 0
  ? Number(value)
  : 1;
const finiteTime = (value, fallback = null) => Number.isFinite(Number(value))
  ? Number(value)
  : fallback;
const finiteLikeCount = (value) => Number.isFinite(Number(value)) && Number(value) >= 0
  ? Number(value)
  : null;
const normalizedId = (field, value) => {
  const id = cleanText(value);
  if (!id || looksLikePlaceholder(id)) return null;
  return field === 'isrc' ? id.toUpperCase() : id;
};
const rowIdentifiers = (row) => ID_FIELDS.flatMap(([field, prefix]) => {
  const value = normalizedId(field, row?.[field]);
  return value ? [{ field, prefix, value, token: `${prefix}:${value}` }] : [];
});

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

function mergeAliases(entries, unionFindState) {
  const owners = new Map();
  entries.forEach((entry, index) => {
    const aliases = entry.identifiers.map((item) => `${entry.playDate}|id:${item.token}`);
    if (entry.titleResolved && entry.artist) {
      aliases.push(`${entry.playDate}|name:${canonical(entry.title)}|artist:${canonical(entry.artist)}`);
    }
    for (const alias of aliases) {
      const owner = owners.get(alias);
      if (owner == null) owners.set(alias, index);
      else unionFindState.union(index, owner);
    }
  });
}

const firstValue = (values) => values?.size ? values.values().next().value : null;

function aggregateEntries(entries, unionFindState) {
  const merged = new Map();
  entries.forEach((entry, index) => {
    const root = unionFindState.find(index);
    const playCount = positiveCount(entry.row.play_count);
    const first = finiteTime(entry.row.first_played_at, finiteTime(entry.row.played_at));
    const last = finiteTime(entry.row.last_played_at, finiteTime(entry.row.played_at));
    const likeCount = finiteLikeCount(entry.row.like_count);
    let current = merged.get(root);
    if (!current) {
      current = {
        play_date: entry.playDate,
        title: entry.titleResolved ? entry.title : '曲情報なし',
        artist: entry.artist,
        spotify_url: entry.row.spotify_url || null,
        play_count: 0,
        like_count: null,
        first_played_at: null,
        last_played_at: null,
        ids: new Map(ID_FIELDS.map(([field]) => [field, new Set()])),
      };
      merged.set(root, current);
    }
    current.play_count += playCount;
    if (likeCount != null) {
      current.like_count = current.like_count == null
        ? likeCount
        : Math.max(current.like_count, likeCount);
    }
    if (first != null) current.first_played_at = current.first_played_at == null
      ? first
      : Math.min(current.first_played_at, first);
    if (last != null) current.last_played_at = current.last_played_at == null
      ? last
      : Math.max(current.last_played_at, last);
    if (!current.spotify_url && entry.row.spotify_url) current.spotify_url = entry.row.spotify_url;
    for (const id of entry.identifiers) current.ids.get(id.field).add(id.value);
  });

  return [...merged.values()].map((current) => {
    const isrc = firstValue(current.ids.get('isrc'));
    const spotifyId = firstValue(current.ids.get('spotify_id'));
    const stationheadTrackId = firstValue(current.ids.get('stationhead_track_id'));
    const queueTrackId = firstValue(current.ids.get('queue_track_id'));
    const strongest = isrc
      ? `isrc:${isrc}`
      : spotifyId
        ? `spotify:${spotifyId}`
        : stationheadTrackId
          ? `stationhead:${stationheadTrackId}`
          : queueTrackId
            ? `queue:${queueTrackId}`
            : `name:${canonical(current.title)}|artist:${canonical(current.artist)}`;
    const sourceKeys = ID_FIELDS.flatMap(([field, prefix]) =>
      [...current.ids.get(field)].map((value) => `${prefix}:${value}`));
    return {
      play_date: current.play_date,
      track_key: strongest,
      title: current.title,
      artist: current.artist,
      spotify_id: spotifyId,
      isrc,
      stationhead_track_id: stationheadTrackId,
      queue_track_id: queueTrackId,
      spotify_url: current.spotify_url,
      play_count: current.play_count,
      like_count: current.like_count,
      first_played_at: current.first_played_at,
      last_played_at: current.last_played_at,
      source_ids: [
        ...current.ids.get('spotify_id'),
        ...current.ids.get('isrc'),
      ],
      source_keys: sourceKeys,
    };
  });
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
  const state = unionFind(entries.length);
  mergeAliases(entries, state);
  return aggregateEntries(entries, state).sort((left, right) =>
    right.play_date.localeCompare(left.play_date)
      || right.play_count - left.play_count
      || left.title.localeCompare(right.title, 'ja'));
}
