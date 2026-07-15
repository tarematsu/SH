(() => {
  'use strict';

  const CACHE_PREFIX = 'sh.like-ranking.v2:';
  const CACHE_MS = 10 * 60_000;
  const number = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
  const dateTime = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const shortDate = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' });

  const state = { rows: [], summary: {}, weekRows: [], controller: null, weekFrom: '', weekTo: '' };
  const el = (id) => document.getElementById(id);
  const finite = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const fmt = (value) => finite(value) == null ? '—' : number.format(Number(value));
  const todayUtc = () => new Date().toISOString().slice(0, 10);

  function mondayUtc(value = todayUtc()) {
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString().slice(0, 10);
  }

  function setNotice(text, error = false) {
    el('notice').textContent = text;
    el('notice').classList.toggle('error', error);
  }

  function readCache(url) {
    try {
      const cached = JSON.parse(sessionStorage.getItem(`${CACHE_PREFIX}${url}`) || 'null');
      return cached && Date.now() - Number(cached.at || 0) < CACHE_MS ? cached.data : null;
    } catch {
      return null;
    }
  }

  function writeCache(url, data) {
    try {
      sessionStorage.setItem(`${CACHE_PREFIX}${url}`, JSON.stringify({ at: Date.now(), data }));
    } catch {
      // The page remains usable without browser storage.
    }
  }

  async function fetchJson(url, signal, force) {
    if (force) sessionStorage.removeItem(`${CACHE_PREFIX}${url}`);
    const cached = force ? null : readCache(url);
    if (cached) return { data: cached, cached: true };
    const response = await fetch(url, { signal, headers: { accept: 'application/json' } });
    const data = await response.json();
    if (!response.ok || !data?.ok) throw new Error(data?.error || `API ${response.status}`);
    writeCache(url, data);
    return { data, cached: false };
  }

  function normalizeText(value) {
    return String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function identityKeys(row) {
    const keys = [];
    const spotify = normalizeText(row?.spotify_id);
    const isrc = normalizeText(row?.isrc);
    const title = normalizeText(row?.title || row?.display_title || row?.raw_title);
    const artist = normalizeText(row?.artist || row?.raw_artist);
    const stationhead = normalizeText(row?.stationhead_track_id);
    if (spotify) keys.push(`spotify:${spotify}`);
    if (isrc) keys.push(`isrc:${isrc}`);
    if (title) keys.push(`title:${title}|${artist}`);
    if (stationhead) keys.push(`stationhead:${stationhead}`);
    return [...new Set(keys)];
  }

  function attachWeeklyPlays(likeRows, weekRows) {
    const parent = new Map();
    const ensure = (key) => { if (!parent.has(key)) parent.set(key, key); };
    const find = (key) => {
      ensure(key);
      let root = key;
      while (parent.get(root) !== root) root = parent.get(root);
      let current = key;
      while (parent.get(current) !== current) {
        const next = parent.get(current);
        parent.set(current, root);
        current = next;
      }
      return root;
    };
    const union = (left, right) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
    };

    for (const row of [...likeRows, ...weekRows]) {
      const keys = identityKeys(row);
      if (!keys.length) continue;
      keys.forEach(ensure);
      for (let index = 1; index < keys.length; index += 1) union(keys[0], keys[index]);
    }

    const totals = new Map();
    for (const row of weekRows) {
      const key = identityKeys(row)[0];
      if (!key) continue;
      const root = find(key);
      totals.set(root, (totals.get(root) || 0) + (finite(row.play_count) || 0));
    }

    return likeRows.map((row) => {
      const key = identityKeys(row)[0];
      return { ...row, week_play_count: key ? totals.get(find(key)) || 0 : 0 };
    });
  }

  function trackName(row) {
    return row.title || row.isrc || row.spotify_id || row.track_identity || '曲名不明';
  }

  function artistName(row) {
    return row.artist || '—';
  }

  function renderSummary() {
    el('trackCount').textContent = fmt(state.summary.track_count || 0);
    el('maxLikes').textContent = fmt(state.summary.max_like_count || 0);
    el('weekPlays').textContent = fmt(state.summary.week_play_count || 0);
    el('latestAt').textContent = state.summary.latest_observed_at
      ? shortDate.format(new Date(Number(state.summary.latest_observed_at)))
      : '—';
  }

  function metric(label, value) {
    const box = document.createElement('span');
    box.append(document.createTextNode(label));
    const strong = document.createElement('b');
    strong.textContent = value;
    box.appendChild(strong);
    return box;
  }

  function renderRanking() {
    const list = el('rankingList');
    list.replaceChildren();
    const rows = state.rows.slice(0, 50);
    if (!rows.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-ranking';
      empty.textContent = 'データがありません。';
      list.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      const item = document.createElement('li');
      item.className = 'like-rank-item';

      const rank = document.createElement('strong');
      rank.className = 'like-rank-number';
      rank.textContent = String(row.rank);

      const content = document.createElement('div');
      content.className = 'like-rank-content';
      const heading = document.createElement('div');
      heading.className = 'like-rank-heading';
      const title = document.createElement('span');
      title.textContent = trackName(row);
      heading.appendChild(title);
      const artist = document.createElement('small');
      artist.textContent = artistName(row);
      content.append(heading, artist);

      const metrics = document.createElement('div');
      metrics.className = 'like-rank-metrics';
      metrics.append(
        metric('最新いいね', fmt(row.latest_like_count)),
        metric('今週再生', `${fmt(row.week_play_count)}回`),
      );

      item.append(rank, content, metrics);
      fragment.appendChild(item);
    }
    list.appendChild(fragment);
  }

  function renderTable() {
    const body = el('tbody');
    body.replaceChildren();
    if (!state.rows.length) {
      const row = document.createElement('tr');
      row.className = 'empty-row';
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.textContent = 'データがありません。';
      row.appendChild(cell);
      body.appendChild(row);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of state.rows) {
      const row = document.createElement('tr');
      const values = [
        item.rank,
        trackName(item),
        artistName(item),
        fmt(item.latest_like_count),
        `${fmt(item.week_play_count)}回`,
        item.latest_observed_at ? dateTime.format(new Date(Number(item.latest_observed_at))) : '—',
      ];
      for (const value of values) {
        const cell = document.createElement('td');
        cell.textContent = String(value);
        row.appendChild(cell);
      }
      fragment.appendChild(row);
    }
    body.appendChild(fragment);
  }

  function render() {
    renderSummary();
    renderRanking();
    renderTable();
  }

  async function load({ force = false } = {}) {
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    el('load').disabled = true;
    setNotice('読み込み中…');

    const weekFrom = mondayUtc();
    const weekTo = todayUtc();
    state.weekFrom = weekFrom;
    state.weekTo = weekTo;
    const likeUrl = '/api/like-ranking?limit=500';
    const trackUrl = `/api/track-history?${new URLSearchParams({ from: weekFrom, to: weekTo, limit: '5000' })}`;

    try {
      const [likeResult, trackResult] = await Promise.all([
        fetchJson(likeUrl, controller.signal, force),
        fetchJson(trackUrl, controller.signal, force),
      ]);
      if (controller.signal.aborted) return;

      const likeRows = Array.isArray(likeResult.data.rows) ? likeResult.data.rows : [];
      const weekRows = Array.isArray(trackResult.data.rows) ? trackResult.data.rows : [];
      state.rows = attachWeeklyPlays(likeRows, weekRows);
      state.weekRows = weekRows;
      const weekPlayCount = state.rows.reduce((sum, row) => sum + (finite(row.week_play_count) || 0), 0);
      state.summary = {
        ...(likeResult.data.summary || {}),
        week_play_count: weekPlayCount,
      };
      render();
      const cached = likeResult.cached && trackResult.cached ? ' · キャッシュ' : '';
      setNotice(`${fmt(state.rows.length)}曲 · 今週 ${weekFrom.replaceAll('-', '/')}〜${weekTo.replaceAll('-', '/')}${cached}`);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      state.rows = [];
      state.weekRows = [];
      state.summary = {};
      render();
      setNotice(`取得失敗: ${error.message}`, true);
    } finally {
      if (state.controller === controller) state.controller = null;
      el('load').disabled = false;
    }
  }

  function exportCsv() {
    const header = ['順位', '曲名', 'アーティスト', '最新いいね', '今週再生', '最終観測'];
    const lines = [header, ...state.rows.map((row) => [
      row.rank,
      trackName(row),
      artistName(row),
      row.latest_like_count,
      row.week_play_count,
      row.latest_observed_at ? new Date(Number(row.latest_observed_at)).toISOString() : '',
    ])].map((line) => line.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(','));
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `sh-like-ranking-${state.weekFrom}-${state.weekTo}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  el('load').addEventListener('click', () => load({ force: true }));
  el('csv').addEventListener('click', exportCsv);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) state.controller?.abort();
  });
  load();
})();
