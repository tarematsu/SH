(() => {
  const $ = (id) => document.getElementById(id);
  const state = { rows: [], cursor: null, loading: false };
  const number = new Intl.NumberFormat('ja-JP');

  function todayJst() {
    return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  }

  function dateDaysAgo(days) {
    return new Date(Date.now() + 9 * 3_600_000 - days * 86_400_000).toISOString().slice(0, 10);
  }

  function formatNumber(value) {
    return value == null || value === '' ? '—' : number.format(Number(value));
  }

  function formatTimestamp(value) {
    if (!value) return '—';
    return new Date(Number(value)).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
  }

  function cell(value, title = '') {
    const td = document.createElement('td');
    td.textContent = value == null || value === '' ? '—' : String(value);
    if (title) td.title = title;
    return td;
  }

  function renderRows() {
    const tbody = $('tbody');
    tbody.replaceChildren();
    if (!state.rows.length) {
      const tr = document.createElement('tr');
      tr.className = 'empty-row';
      const td = cell('該当する移行済みデータはありません。');
      td.colSpan = 12;
      tr.append(td);
      tbody.append(tr);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const row of state.rows) {
      const tr = document.createElement('tr');
      const quality = row.quality_score == null ? '—' : Number(row.quality_score).toFixed(2);
      tr.append(
        cell(row.observed_jst || formatTimestamp(row.observed_at)),
        cell(formatNumber(row.listener_count)),
        cell(formatNumber(row.total_stream_count)),
        cell(row.track_title, row.track_title),
        cell(row.artist_name, row.artist_name),
        cell(formatNumber(row.likes)),
        cell(row.comment_velocity == null ? '—' : Number(row.comment_velocity).toFixed(2)),
        cell(row.host_handle, row.host_handle),
        cell(formatNumber(row.total_member_count)),
        cell(row.source_note, row.source_note),
        cell(quality, row.quality_flags || ''),
        cell(row.id),
      );
      fragment.append(tr);
    }
    tbody.append(fragment);
  }

  function renderStats(payload) {
    const progress = payload.progress || {};
    $('migratedRows').textContent = formatNumber(progress.migrated);
    $('remainingRows').textContent = formatNumber(progress.remaining);
    $('progressRate').textContent = `${Number(progress.percent || 0).toFixed(2)}%`;
    const dictionaries = payload.dictionaries || {};
    $('dictionaryRows').innerHTML = `${formatNumber(dictionaries.tracks)}<small>${formatNumber(dictionaries.hosts)} / ${formatNumber(dictionaries.broadcasts)}</small>`;
    $('progressBar').style.width = `${Math.max(0, Math.min(100, Number(progress.percent || 0)))}%`;
    $('firstObserved').textContent = `最初: ${formatTimestamp(payload.first_observed_at)}`;
    $('lastObserved').textContent = `最後: ${formatTimestamp(payload.last_observed_at)}`;
    $('cursorValue').textContent = `cursor: ${formatNumber(payload.backfill_cursor)}`;
    $('periodText').textContent = `${payload.from} ～ ${payload.to}`;
  }

  function buildUrl(cursor = null) {
    const params = new URLSearchParams({
      from: $('from').value,
      to: $('to').value,
      limit: '200',
    });
    const host = $('host').value.trim();
    const track = $('track').value.trim();
    if (host) params.set('host', host);
    if (track) params.set('track', track);
    if (cursor) params.set('cursor', cursor);
    return `/api/history-migrated?${params}`;
  }

  async function load({ append = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    $('load').disabled = true;
    $('more').disabled = true;
    $('notice').classList.remove('error-text');
    $('notice').textContent = append ? '続きを読み込み中…' : '移行済みデータを読み込み中…';
    try {
      const response = await fetch(buildUrl(append ? state.cursor : null), { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      state.rows = append ? state.rows.concat(payload.rows || []) : (payload.rows || []);
      state.cursor = payload.next_cursor || null;
      renderRows();
      renderStats(payload);
      $('more').hidden = !payload.has_more;
      $('notice').textContent = `${state.rows.length.toLocaleString('ja-JP')}件を表示中。保存元: ${payload.storage_source}`;
    } catch (error) {
      if (!append) {
        state.rows = [];
        state.cursor = null;
        renderRows();
      }
      $('notice').classList.add('error-text');
      $('notice').textContent = error?.message || '読み込みに失敗しました。';
      $('more').hidden = true;
    } finally {
      state.loading = false;
      $('load').disabled = false;
      $('more').disabled = false;
    }
  }

  function csvEscape(value) {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function downloadCsv() {
    if (!state.rows.length) return;
    const headers = ['日時JST','リスナー','総再生数','曲名','アーティスト','いいね','コメント勢い','ホスト','メンバー','放送名','品質','品質フラグ','legacy_id'];
    const rows = state.rows.map((row) => [
      row.observed_jst || formatTimestamp(row.observed_at), row.listener_count, row.total_stream_count,
      row.track_title, row.artist_name, row.likes, row.comment_velocity, row.host_handle,
      row.total_member_count, row.source_note, row.quality_score, row.quality_flags, row.id,
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    link.download = `migrated-legacy-${$('from').value}-${$('to').value}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function applyPreset(button) {
    document.querySelectorAll('[data-days]').forEach((item) => item.classList.toggle('active', item === button));
    const days = button.dataset.days;
    $('to').value = todayJst();
    $('from').value = days === 'all' ? '2024-06-01' : dateDaysAgo(Number(days) - 1);
    load();
  }

  $('to').value = todayJst();
  $('load').addEventListener('click', () => load());
  $('more').addEventListener('click', () => load({ append: true }));
  $('csv').addEventListener('click', downloadCsv);
  document.querySelectorAll('[data-days]').forEach((button) => button.addEventListener('click', () => applyPreset(button)));
  for (const id of ['host', 'track']) {
    $(id).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') load();
    });
  }
  load();
})();
