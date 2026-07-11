(() => {
  const $ = (id) => document.getElementById(id);
  const state = { rows: [], cursor: null, loading: false };
  const number = new Intl.NumberFormat('ja-JP');
  const sourceLabels = {
    live_collector: 'ライブ',
    legacy_normalized: '軽量化済み',
    legacy_raw: '直接移行',
  };
  const qualityFlags = [
    [2, 'queue欠落'],
    [8, '曲不明'],
    [16, '曲推定'],
    [32, 'コメント劣化'],
    [128, '遅延payload'],
    [256, '配信外'],
    [512, '一時停止'],
    [1024, 'レガシー品質低下'],
  ];

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

  function formatRatio(current, total) {
    if (current == null && total == null) return '—';
    return `${formatNumber(current)} / ${formatNumber(total)}`;
  }

  function formatQueue(row) {
    if (!row.queue_available) return '取得なし';
    const position = row.queue_position == null ? '—' : Number(row.queue_position) + 1;
    const total = row.queue_track_count == null ? row.revision_item_count : row.queue_track_count;
    return `${position} / ${formatNumber(total)}`;
  }

  function qualityText(row) {
    const score = row.quality_score == null ? '—' : Number(row.quality_score).toFixed(2);
    const flags = Number(row.quality_flags || 0);
    const labels = qualityFlags.filter(([bit]) => (flags & bit) !== 0).map(([, label]) => label);
    return { score, detail: labels.length ? labels.join('、') : '問題なし' };
  }

  function cell(value, title = '', className = '') {
    const td = document.createElement('td');
    td.textContent = value == null || value === '' ? '—' : String(value);
    if (title) td.title = title;
    if (className) td.className = className;
    return td;
  }

  function statusCell(row) {
    const broadcasting = row.is_broadcasting == null ? '不明' : (Number(row.is_broadcasting) === 1 ? '配信中' : '配信外');
    const paused = Number(row.is_paused || 0) === 1 ? ' / 停止' : '';
    return cell(`${broadcasting}${paused}`, '', Number(row.is_broadcasting) === 1 ? 'status-on' : 'status-off');
  }

  function renderRows() {
    const tbody = $('tbody');
    tbody.replaceChildren();
    if (!state.rows.length) {
      const tr = document.createElement('tr');
      tr.className = 'empty-row';
      const td = cell('該当する毎分データはありません。');
      td.colSpan = 16;
      tr.append(td);
      tbody.append(tr);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const row of state.rows) {
      const tr = document.createElement('tr');
      const quality = qualityText(row);
      const source = sourceLabels[row.source] || row.source || '—';
      const sourceDetail = `${row.source || ''}${row.source_record_id ? ` / record ${row.source_record_id}` : ''}`;
      const detection = row.track_detection_method || 'unknown';
      const confidence = row.track_confidence == null ? '' : ` ${(Number(row.track_confidence) * 100).toFixed(0)}%`;
      tr.append(
        cell(formatTimestamp(row.minute_at || row.observed_at)),
        cell(source, sourceDetail, `source-${row.source || 'unknown'}`),
        statusCell(row),
        cell(formatNumber(row.listener_count)),
        cell(formatNumber(row.cumulative_listener_count), 'これまで訪れた累計リスナー数'),
        cell(formatNumber(row.total_stream_count), 'Stationheadが報告した総再生数'),
        cell(row.track_title, row.isrc || row.spotify_id || '', 'text-cell'),
        cell(row.artist_name, row.artist_name, 'text-cell'),
        cell(formatNumber(row.track_bite_count)),
        cell(row.host_handle, row.host_handle, 'text-cell'),
        cell(formatRatio(row.online_member_count, row.total_member_count)),
        cell(formatRatio(row.comment_count, row.comment_total), row.comments_degraded ? 'コメント取得が劣化しています' : ''),
        cell(formatQueue(row), `revision ${row.queue_revision_id || '—'} / ${row.revision_status || '—'}`),
        cell(`${detection}${confidence}`, `schedule_valid=${row.schedule_valid}`),
        cell(quality.score, quality.detail),
        cell(row.id),
      );
      fragment.append(tr);
    }
    tbody.append(fragment);
  }

  function renderStats(payload) {
    const summary = payload.summary || {};
    const catalog = payload.catalog || {};
    const migration = payload.migration || {};
    $('totalRows').textContent = formatNumber(summary.total);
    $('liveRows').textContent = formatNumber(summary.live);
    $('legacyRows').innerHTML = `${formatNumber(summary.legacy)}<small>${formatNumber(summary.legacy_normalized)} / ${formatNumber(summary.legacy_raw)}</small>`;
    $('catalogRows').innerHTML = `${formatNumber(catalog.tracks)}<small>${formatNumber(catalog.hosts)} / ${formatNumber(catalog.sessions)}</small>`;
    $('firstObserved').textContent = `最初: ${formatTimestamp(payload.first_observed_at)}`;
    $('lastObserved').textContent = `最後: ${formatTimestamp(payload.last_observed_at)}`;
    $('migrationPhase').textContent = `移行: ${migration.phase || '未開始'}`;
    $('migrationRows').textContent = `移行行: ${formatNumber(migration.migrated_rows)} / error ${formatNumber(migration.error_rows)}`;
    $('migrationCursor').textContent = `cursor: ${formatTimestamp(migration.cursor_observed_at)} / ID ${formatNumber(migration.cursor_source_id)}`;
    $('revisionRows').textContent = `revision: ${formatNumber(catalog.revisions)}`;
    $('periodText').textContent = `${payload.from} ～ ${payload.to}`;
    const error = $('migrationError');
    error.hidden = !migration.last_error;
    error.textContent = migration.last_error ? `移行エラー: ${migration.last_error}` : '';
    error.classList.toggle('error-text', Boolean(migration.last_error));
  }

  function buildUrl(cursor = null) {
    const params = new URLSearchParams({
      from: $('from').value,
      to: $('to').value,
      limit: '200',
    });
    const source = $('source').value;
    const host = $('host').value.trim();
    const track = $('track').value.trim();
    if (source) params.set('source', source);
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
    $('notice').textContent = append ? '続きを読み込み中…' : 'Stationhead-DBを読み込み中…';
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
    const headers = [
      '日時JST','minute_at','observed_at','received_at','source','source_priority','source_record_id',
      'channel_id','station_id','配信中','一時停止','listener_count','cumulative_listener_count',
      'total_stream_count',
      '曲名','アーティスト','ISRC','spotify_id','track_bite_count','ホスト','online_member_count','total_member_count','guest_count',
      'comment_count','comment_total','comments_degraded','queue_id','queue_revision_id','queue_position','queue_track_count',
      'track_detection_method','track_confidence','schedule_valid','quality_score','quality_flags','fact_id',
    ];
    const rows = state.rows.map((row) => [
      formatTimestamp(row.minute_at || row.observed_at), row.minute_at, row.observed_at, row.received_at,
      row.source, row.source_priority, row.source_record_id, row.channel_id, row.station_id,
      row.is_broadcasting, row.is_paused, row.listener_count, row.cumulative_listener_count,
      row.total_stream_count,
      row.track_title, row.artist_name, row.isrc, row.spotify_id, row.track_bite_count, row.host_handle,
      row.online_member_count, row.total_member_count, row.guest_count, row.comment_count, row.comment_total, row.comments_degraded,
      row.queue_id, row.queue_revision_id, row.queue_position, row.queue_track_count, row.track_detection_method,
      row.track_confidence, row.schedule_valid, row.quality_score, row.quality_flags, row.id,
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    link.download = `stationhead-db-minute-facts-${$('from').value}-${$('to').value}.csv`;
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
  $('from').value = dateDaysAgo(29);
  $('load').addEventListener('click', () => load());
  $('more').addEventListener('click', () => load({ append: true }));
  $('csv').addEventListener('click', downloadCsv);
  document.querySelectorAll('[data-days]').forEach((button) => button.addEventListener('click', () => applyPreset(button)));
  for (const id of ['host', 'track']) {
    $(id).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') load();
    });
  }
  $('source').addEventListener('change', () => load());
  load();
})();
