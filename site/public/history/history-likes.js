(() => {
  'use strict';

  const DAY_MS = 86_400_000;
  const CACHE_PREFIX = 'sh.like-ranking.v1:';
  const CACHE_MS = 10 * 60_000;
  const number = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
  const dateTime = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  const state = { rows: [], summary: {}, controller: null };
  const el = (id) => document.getElementById(id);
  const finite = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const fmt = (value) => finite(value) == null ? '—' : number.format(Number(value));
  const todayUtc = () => new Date().toISOString().slice(0, 10);

  function dateDaysAgo(days) {
    return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  }

  function setNotice(text, error = false) {
    el('notice').textContent = text;
    el('notice').classList.toggle('error', error);
  }

  function applyPreset(days) {
    el('to').value = todayUtc();
    el('from').value = days === 'all' ? '2024-05-01' : dateDaysAgo(Number(days));
    document.querySelectorAll('#rangePresets button').forEach((button) => {
      button.classList.toggle('active', button.dataset.days === String(days));
    });
  }

  function requestUrl() {
    return `/api/like-ranking?${new URLSearchParams({
      from: el('from').value,
      to: el('to').value,
      sort: el('sort').value,
      limit: '500',
    })}`;
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
      // Ranking remains available when session storage is unavailable.
    }
  }

  function trackName(row) {
    return row.title || row.isrc || row.spotify_id || row.track_identity || '曲名不明';
  }

  function artistName(row) {
    return row.artist || '—';
  }

  function rankingValue(row) {
    if (el('sort').value === 'peak') return finite(row.peak_like_count) || 0;
    if (el('sort').value === 'average') return finite(row.average_like_count) || 0;
    return finite(row.total_like_count) || 0;
  }

  function rankingLabel(row) {
    if (el('sort').value === 'peak') return `${fmt(row.peak_like_count)} いいね`;
    if (el('sort').value === 'average') return `平均 ${fmt(row.average_like_count)}`;
    return `${fmt(row.total_like_count)} いいね`;
  }

  function renderSummary() {
    el('totalLikes').textContent = fmt(state.summary.total_like_count || 0);
    el('trackCount').textContent = fmt(state.summary.track_count || 0);
    el('occurrenceCount').textContent = fmt(state.summary.occurrence_count || 0);
    el('peakLikes').textContent = fmt(state.summary.peak_like_count || 0);
  }

  function renderRanking() {
    const list = el('rankingList');
    list.replaceChildren();
    const rows = state.rows.slice(0, 30);
    const maximum = Math.max(1, ...rows.map(rankingValue));
    if (!rows.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-ranking';
      empty.textContent = '表示できるいいねデータがありません。';
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
      const value = document.createElement('b');
      value.textContent = rankingLabel(row);
      heading.append(title, value);

      const meta = document.createElement('small');
      meta.textContent = `${artistName(row)} · ${fmt(row.occurrence_count)}回再生 · 最高${fmt(row.peak_like_count)}`;
      const bar = document.createElement('div');
      bar.className = 'like-rank-bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.max(2, rankingValue(row) / maximum * 100)}%`;
      bar.appendChild(fill);
      content.append(heading, meta, bar);
      item.append(rank, content);
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
      cell.colSpan = 8;
      cell.textContent = '表示できるいいねデータがありません。';
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
        fmt(item.total_like_count),
        fmt(item.peak_like_count),
        fmt(item.average_like_count),
        fmt(item.occurrence_count),
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
    const url = requestUrl();
    el('load').disabled = true;
    setNotice('いいねランキングを読み込み中…');
    try {
      if (force) sessionStorage.removeItem(`${CACHE_PREFIX}${url}`);
      let data = force ? null : readCache(url);
      const cached = Boolean(data);
      if (!data) {
        const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
        data = await response.json();
        if (!response.ok || !data?.ok) throw new Error(data?.error || `API ${response.status}`);
        writeCache(url, data);
      }
      if (controller.signal.aborted) return;
      state.rows = Array.isArray(data.rows) ? data.rows : [];
      state.summary = data.summary || {};
      render();
      const setup = data.setup_required ? ' · FACTS DBのカウンターテーブル未準備' : '';
      setNotice(`${data.from}〜${data.to} · ${fmt(state.rows.length)}曲を表示${cached ? ' · キャッシュ' : ''}${setup}`);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      state.rows = [];
      state.summary = {};
      render();
      setNotice(`いいねランキングを取得できませんでした: ${error.message}`, true);
    } finally {
      if (state.controller === controller) state.controller = null;
      el('load').disabled = false;
    }
  }

  function exportCsv() {
    const header = ['順位', '曲名', 'アーティスト', '合計いいね', '1回最高', '1回平均', '再生発生数', '最終観測'];
    const lines = [header, ...state.rows.map((row) => [
      row.rank,
      trackName(row),
      artistName(row),
      row.total_like_count,
      row.peak_like_count,
      row.average_like_count,
      row.occurrence_count,
      row.latest_observed_at ? new Date(Number(row.latest_observed_at)).toISOString() : '',
    ])].map((line) => line.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(','));
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `sh-like-ranking-${el('from').value}-${el('to').value}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function start() {
    applyPreset('30');
    document.querySelectorAll('#rangePresets button').forEach((button) => {
      button.addEventListener('click', () => {
        applyPreset(button.dataset.days);
        load();
      });
    });
    el('sort').addEventListener('change', () => load());
    el('load').addEventListener('click', () => load({ force: true }));
    el('csv').addEventListener('click', exportCsv);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) state.controller?.abort();
    });
    load();
  }

  start();
})();
