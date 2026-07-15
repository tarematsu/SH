(() => {
  'use strict';

  const DASHBOARD_URL = '/api/dashboard?history=0';
  const HISTORY_URL = '/api/dashboard-history';
  const CACHE_KEY = 'sh.dashboard-lite.v1';
  const HISTORY_LIMIT = 300;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const integer = new Intl.NumberFormat('ja-JP');
  const compact = new Intl.NumberFormat('ja-JP', { notation: 'compact', maximumFractionDigits: 1 });
  const dateTime = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const etaTime = new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });

  const state = {
    payload: null,
    history: [],
    queue: [],
    queueTotal: 0,
    queueRevision: '',
    refreshing: false,
    loadingMore: false,
    abortController: null,
    playbackIndex: -1,
    selectedChartIndex: -1,
    chart: null,
  };

  const byId = (id) => document.getElementById(id);
  const finite = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const formatNumber = (value) => finite(value) == null ? '-' : integer.format(Number(value));
  const formatDuration = (value) => {
    const seconds = Math.max(0, Math.floor((finite(value) || 0) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const safeDate = (value, formatter = dateTime) => {
    const timestamp = finite(value);
    return timestamp && timestamp > 0 ? formatter.format(new Date(timestamp)) : '-';
  };

  function setText(id, value) {
    const node = byId(id);
    if (node && node.textContent !== String(value)) node.textContent = String(value);
  }

  function reducedImage(source, size = 200) {
    const value = String(source || '').trim();
    if (!value) return '';
    try {
      const url = new URL(value, location.href);
      if (/stationhead-production1-images\.s3\.amazonaws\.com$/i.test(url.hostname)) {
        url.pathname = url.pathname.replace(/\/(?:76|200|340|672|800|960)\//, `/${size <= 76 ? 76 : 200}/`);
      } else if (/i\.scdn\.co$/i.test(url.hostname)) {
        url.pathname = url.pathname.replace(/ab67616d0000(?:b273|01e02|04851)/i, size <= 100 ? 'ab67616d00004851' : 'ab67616d0000b273');
      } else if (/mosaic\.scdn\.co$/i.test(url.hostname)) {
        url.pathname = url.pathname.replace(/\/(?:640|300|60)\//, size <= 100 ? '/60/' : '/300/');
      }
      return url.href;
    } catch {
      return value;
    }
  }

  function setImage(id, source, size = 200) {
    const image = byId(id);
    if (!image) return;
    const next = reducedImage(source, size);
    if (!next) {
      image.hidden = true;
      image.removeAttribute('src');
      return;
    }
    if (image.src !== next) image.src = next;
    image.hidden = false;
  }

  function inferredArtist(track) {
    for (const candidate of [track?.artist, track?.artist_name, track?.album_artist, track?.performer, track?.subtitle]) {
      const value = String(candidate || '').trim();
      if (value && !/^JP[A-Z0-9]{8,}$/i.test(value)) return value;
    }
    const display = String(track?.display_title || '').trim();
    const title = String(track?.title || '').trim();
    for (const separator of [' — ', ' – ', ' - ', ' · ', ' • ']) {
      const index = display.lastIndexOf(separator);
      if (index <= 0) continue;
      const left = display.slice(0, index).trim();
      const right = display.slice(index + separator.length).trim();
      if (!left || !right) continue;
      if (!title || left === title) return right;
      if (right === title) return left;
    }
    return '';
  }

  function spotifyUrl(track) {
    const value = track?.spotify_url || (track?.spotify_id ? `https://open.spotify.com/track/${track.spotify_id}` : '');
    if (!value) return '';
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && /(^|\.)spotify\.com$/i.test(url.hostname) ? url.href : '';
    } catch {
      return '';
    }
  }

  function renderDelta(id, value) {
    const node = byId(id);
    if (!node) return;
    const number = finite(value);
    if (number == null) {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    const sign = number > 0 ? '+' : number < 0 ? '−' : '±';
    node.textContent = `前日 ${sign}${formatNumber(Math.abs(number))}`;
    node.className = `delta ${number > 0 ? 'positive' : number < 0 ? 'negative' : ''}`.trim();
    node.hidden = false;
  }

  function renderHeader(payload) {
    const latest = payload?.latest || {};
    setText('channelName', latest.channel_name || 'Buddies');
    setText('description', latest.description || latest.artist_name || '');
    setText('updated', `最終取得 ${safeDate(latest.observed_at)}`);
    setImage('channelImage', latest.channel_image || latest.logo_image, 76);
    if (latest.accent_color) document.documentElement.style.setProperty('--accent', latest.accent_color);

    const broadcasting = latest.is_broadcasting !== 0 && latest.is_broadcasting !== false;
    setText('liveState', broadcasting ? '配信中' : '配信停止中');
    byId('liveDot')?.classList.toggle('on', broadcasting);
  }

  function renderMetrics(payload) {
    const latest = payload?.latest || {};
    setText('online', formatNumber(latest.online_member_count));
    setText('members', formatNumber(latest.total_member_count));
    setText('totalListens', formatNumber(latest.total_listens));
    renderDelta('membersDelta', payload?.daily_change?.total_member_count);
    renderDelta('listensDelta', payload?.daily_change?.total_listens);
  }

  function playbackView() {
    const payload = state.payload;
    const queue = state.queue;
    if (!payload || !queue.length) return { index: -1, progress: 0, duration: 0 };
    let index = queue.findIndex((track) => track?.is_current);
    if (index < 0) index = 0;
    const status = payload.queue_status || {};
    const playing = status.playing ?? (payload.latest?.is_broadcasting !== 0 && payload.latest?.is_broadcasting !== false && !status.is_paused);
    const anchor = finite(status.anchor_at);
    let progress = playing && anchor != null
      ? Math.max(0, Date.now() - anchor)
      : Math.max(0, finite(queue[index]?.progress_ms) || 0);

    while (index < queue.length - 1) {
      const duration = Math.max(0, finite(queue[index]?.duration_ms) || 0);
      if (!duration || progress < duration) break;
      progress -= duration;
      index += 1;
    }
    const duration = Math.max(0, finite(queue[index]?.duration_ms) || 0);
    return { index, progress: duration ? Math.min(progress, duration) : progress, duration };
  }

  function renderHost() {
    const host = byId('host');
    if (!host) return;
    const handle = String(state.payload?.latest?.host_handle || '').replace(/^@/, '').trim();
    host.replaceChildren();
    if (!handle) return;
    const label = document.createElement('span');
    label.textContent = '配信ホスト ';
    const link = document.createElement('a');
    link.href = `https://stationhead.com/${encodeURIComponent(handle)}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `@${handle}`;
    host.append(label, link);
  }

  function renderNowPlaying(force = false) {
    const view = playbackView();
    const track = view.index >= 0 ? state.queue[view.index] : null;
    if (!force && view.index === state.playbackIndex) {
      updatePlaybackProgress(view);
      return;
    }
    state.playbackIndex = view.index;
    renderHost();

    const link = byId('nowPlayingLink');
    if (!track) {
      setText('trackTitle', 'キュー情報がありません');
      setText('trackArtist', '');
      setText('trackTime', '-');
      setImage('trackImage', '');
      link?.removeAttribute('href');
      link?.setAttribute('aria-disabled', 'true');
      byId('spotifyHint').hidden = true;
      updatePlaybackProgress(view);
      return;
    }

    setText('trackTitle', track.title || track.display_title || track.spotify_id || '曲名不明');
    setText('trackArtist', inferredArtist(track));
    setImage('trackImage', track.thumbnail_url, 200);
    const url = spotifyUrl(track);
    if (url) {
      link.href = url;
      link.setAttribute('aria-disabled', 'false');
      byId('spotifyHint').hidden = false;
    } else {
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
      byId('spotifyHint').hidden = true;
    }
    updatePlaybackProgress(view);
    renderQueue();
  }

  function updatePlaybackProgress(view = playbackView()) {
    const percent = view.duration > 0 ? Math.min(100, view.progress / view.duration * 100) : 0;
    setText('trackTime', `${formatDuration(view.progress)} / ${formatDuration(view.duration)}`);
    const bar = byId('trackBar');
    if (bar) bar.style.width = `${percent}%`;
  }

  function queueItem(track, index) {
    const link = document.createElement('a');
    link.className = 'queue-item';
    const url = spotifyUrl(track);
    link.href = url || '#';
    if (url) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    } else {
      link.addEventListener('click', (event) => event.preventDefault());
    }

    const position = document.createElement('span');
    position.className = 'queue-index';
    position.textContent = String(index + 1);
    const image = document.createElement('img');
    image.className = 'queue-thumb';
    image.alt = '';
    image.width = 42;
    image.height = 42;
    image.loading = 'lazy';
    image.decoding = 'async';
    const source = reducedImage(track?.thumbnail_url, 76);
    if (source) image.src = source;
    else image.hidden = true;
    const copy = document.createElement('span');
    copy.className = 'queue-copy';
    const title = document.createElement('strong');
    title.textContent = track?.title || track?.display_title || track?.spotify_id || '曲名不明';
    const artist = document.createElement('small');
    artist.textContent = inferredArtist(track);
    copy.append(title, artist);
    const duration = document.createElement('span');
    duration.className = 'queue-duration';
    duration.textContent = formatDuration(track?.duration_ms);
    link.append(position, image, copy, duration);
    return link;
  }

  function renderQueue() {
    const box = byId('queue');
    const more = byId('queueMore');
    if (!box || !more) return;
    const current = playbackView().index;
    const upcoming = state.queue.slice(Math.max(0, current + 1));
    const loaded = state.queue.length;
    const remaining = Math.max(0, state.queueTotal - loaded);
    setText('queueCount', remaining > 0 ? `${formatNumber(state.queueTotal)}曲 / ${formatNumber(loaded)}曲読込` : `${formatNumber(state.queueTotal || loaded)}曲`);
    box.replaceChildren(...upcoming.map((track, index) => queueItem(track, index)));
    if (!upcoming.length) {
      const empty = document.createElement('p');
      empty.className = 'subtle';
      empty.textContent = remaining > 0 ? '続きを読み込めます。' : '次の曲はありません。';
      box.append(empty);
    }
    more.hidden = remaining <= 0;
    more.disabled = state.loadingMore;
    more.textContent = state.loadingMore ? '読み込み中...' : `続きを読み込む（残り${formatNumber(remaining)}曲）`;
  }

  async function loadMoreQueue() {
    if (state.loadingMore || state.queue.length >= state.queueTotal) return;
    state.loadingMore = true;
    renderQueue();
    try {
      const response = await fetch(`/api/dashboard-queue?offset=${state.queue.length}&limit=20`, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`queue API ${response.status}`);
      const payload = await response.json();
      if (!payload.ok) throw new Error(payload.error || 'queue API error');
      state.queue.push(...(Array.isArray(payload.queue) ? payload.queue : []));
      state.queueTotal = finite(payload.total_items) || state.queueTotal;
    } catch (error) {
      showStatus('キューの続きを取得できませんでした。');
      console.error(error);
    } finally {
      state.loadingMore = false;
      renderQueue();
    }
  }

  function renderGoal(payload) {
    const latest = payload?.latest || {};
    const current = finite(latest.current_stream_count);
    const goal = finite(latest.stream_goal) || 0;
    const percent = goal > 0 && current != null ? Math.min(100, current / goal * 100) : 0;
    setText('streamCount', formatNumber(current));
    setText('streamGoal', formatNumber(goal));
    setText('goalPercent', `${percent.toFixed(2)}%`);
    setText('goalRemaining', goal > 0 && current != null ? `残り ${formatNumber(Math.max(0, goal - current))}` : '-');
    const bar = byId('goalBar');
    if (bar) bar.style.width = `${percent}%`;

    const prediction = payload?.goal_prediction;
    if (prediction?.eta && finite(prediction.rate_per_hour) > 0) {
      setText('goalEta', safeDate(prediction.eta, etaTime));
      setText('goalRate', `平均 +${formatNumber(Math.round(prediction.rate_per_hour))} /時`);
    } else {
      setText('goalEta', current != null && goal > 0 && current >= goal ? '目標達成済み' : '予測データ不足');
      setText('goalRate', '最低15分以上の履歴が必要です');
    }

    const milestones = byId('goalMilestones');
    if (!milestones) return;
    const rows = (Array.isArray(payload?.goal_predictions) ? payload.goal_predictions : [])
      .filter((item) => finite(item?.goal) != null && finite(item?.eta) != null)
      .sort((left, right) => Number(left.goal) - Number(right.goal))
      .slice(0, 4);
    milestones.replaceChildren(...rows.map((item) => {
      const node = document.createElement('span');
      node.className = 'milestone';
      node.textContent = `${compact.format(Number(item.goal))} · ${safeDate(item.eta, etaTime)}`;
      return node;
    }));
  }

  function historyRowFromLatest(payload) {
    const latest = payload?.latest || {};
    const observed = finite(latest.observed_at);
    if (!observed) return null;
    return {
      observed_at: observed,
      listener_count: finite(latest.listener_count),
      online_member_count: finite(latest.online_member_count),
      total_member_count: finite(latest.total_member_count),
      total_listens: finite(latest.total_listens),
      current_stream_count: finite(latest.current_stream_count),
      comment_velocity: finite(latest.comment_velocity),
    };
  }

  function mergeLatestIntoHistory(payload) {
    const row = historyRowFromLatest(payload);
    if (!row) return;
    const index = state.history.findIndex((item) => Number(item.observed_at) === row.observed_at);
    if (index >= 0) state.history[index] = { ...state.history[index], ...row };
    else state.history.push(row);
    const cutoff = Date.now() - DAY_MS;
    state.history = state.history
      .filter((item) => finite(item?.observed_at) >= cutoff)
      .sort((left, right) => Number(left.observed_at) - Number(right.observed_at))
      .slice(-HISTORY_LIMIT);
  }

  function downsample(rows, maximum = 240) {
    const valid = rows.filter((row) => finite(row?.observed_at) != null);
    if (valid.length <= maximum) return valid;
    const step = (valid.length - 1) / (maximum - 1);
    return Array.from({ length: maximum }, (_, index) => valid[Math.round(index * step)]);
  }

  function chartComment(row) {
    for (const candidate of [row?.comment_velocity, row?.comment_velocity_max, row?.comment_count_delta]) {
      const value = finite(candidate);
      if (value != null) return Math.max(0, value);
    }
    return 0;
  }

  function drawChart() {
    const canvas = byId('chart');
    if (!canvas) return;
    const rows = downsample(state.history);
    if (!rows.length) return;
    const bounds = canvas.getBoundingClientRect();
    const width = Math.max(300, Math.round(bounds.width || 900));
    const height = Math.max(240, Math.min(360, Math.round(width * .42)));
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const css = getComputedStyle(document.documentElement);
    const colors = {
      online: css.getPropertyValue('--accent').trim() || '#ff6f9f',
      stream: css.getPropertyValue('--accent-2').trim() || '#9b8cff',
      comment: css.getPropertyValue('--comment').trim() || '#55d6be',
      muted: css.getPropertyValue('--muted').trim() || '#9da8ba',
    };
    const padding = { left: 42, right: 58, top: 16, bottom: 42 };
    const plotWidth = Math.max(1, width - padding.left - padding.right);
    const plotHeight = Math.max(1, height - padding.top - padding.bottom);
    const times = rows.map((row) => Number(row.observed_at));
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const span = Math.max(1, maxTime - minTime);
    const x = times.map((time) => padding.left + plotWidth * (time - minTime) / span);
    const onlineValues = rows.map((row) => finite(row.online_member_count)).filter((value) => value != null);
    const streamValues = rows.map((row) => finite(row.current_stream_count)).filter((value) => value != null);
    const comments = rows.map(chartComment);
    const scale = (values, minimumPadding) => {
      if (!values.length) return { min: 0, max: 1, range: 1 };
      const rawMin = Math.min(...values);
      const rawMax = Math.max(...values);
      const extra = Math.max(minimumPadding, (rawMax - rawMin) * .08);
      const min = Math.max(0, rawMin - extra);
      const max = rawMax + extra;
      return { min, max, range: Math.max(1, max - min) };
    };
    const onlineScale = scale(onlineValues, 4);
    const streamScale = scale(streamValues, 10);
    const y = (value, currentScale) => height - padding.bottom - (value - currentScale.min) * plotHeight / currentScale.range;

    context.font = '11px system-ui';
    context.lineWidth = 1;
    context.strokeStyle = 'rgba(255,255,255,.08)';
    for (let index = 0; index <= 4; index += 1) {
      const vertical = padding.top + plotHeight * index / 4;
      context.beginPath();
      context.moveTo(padding.left, vertical);
      context.lineTo(width - padding.right, vertical);
      context.stroke();
      context.fillStyle = colors.online;
      context.fillText(String(Math.round(onlineScale.max - onlineScale.range * index / 4)), 4, vertical + 4);
      context.fillStyle = colors.stream;
      context.fillText(compact.format(Math.round(streamScale.max - streamScale.range * index / 4)), width - padding.right + 8, vertical + 4);
    }

    const commentMax = Math.max(0, ...comments);
    if (commentMax > 0) {
      context.fillStyle = colors.comment;
      comments.forEach((value, index) => {
        if (value <= 0) return;
        const gap = index ? x[index] - x[index - 1] : 8;
        const barWidth = Math.max(2, Math.min(12, gap * .65));
        const barHeight = Math.max(3, plotHeight * value / commentMax);
        context.globalAlpha = .42;
        context.fillRect(x[index] - barWidth / 2, height - padding.bottom - barHeight, barWidth, barHeight);
      });
      context.globalAlpha = 1;
    }

    const drawLine = (key, currentScale, color) => {
      context.beginPath();
      context.strokeStyle = color;
      context.lineWidth = 2.25;
      context.lineJoin = 'round';
      context.lineCap = 'round';
      let started = false;
      rows.forEach((row, index) => {
        const value = finite(row[key]);
        if (value == null) { started = false; return; }
        const pointY = y(value, currentScale);
        if (!started) { context.moveTo(x[index], pointY); started = true; }
        else context.lineTo(x[index], pointY);
      });
      context.stroke();
    };
    drawLine('online_member_count', onlineScale, colors.online);
    drawLine('current_stream_count', streamScale, colors.stream);

    context.fillStyle = colors.muted;
    context.textBaseline = 'top';
    const tickCount = Math.max(4, Math.min(9, Math.floor(plotWidth / 75)));
    for (let index = 0; index < tickCount; index += 1) {
      const rowIndex = Math.round((rows.length - 1) * index / Math.max(1, tickCount - 1));
      const label = new Date(times[rowIndex]).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
      const measured = context.measureText(label).width;
      const pointX = Math.max(padding.left, Math.min(width - padding.right - measured, x[rowIndex] - measured / 2));
      context.fillText(label, pointX, height - padding.bottom + 12);
    }

    if (state.selectedChartIndex >= 0 && state.selectedChartIndex < rows.length) {
      const selectedX = x[state.selectedChartIndex];
      context.save();
      context.strokeStyle = 'rgba(255,255,255,.7)';
      context.setLineDash([4, 4]);
      context.beginPath();
      context.moveTo(selectedX, padding.top);
      context.lineTo(selectedX, height - padding.bottom);
      context.stroke();
      context.restore();
    }
    state.chart = { rows, x };
  }

  function selectChartPoint(event) {
    if (!state.chart?.x?.length) return;
    const bounds = byId('chart').getBoundingClientRect();
    const pointer = event.clientX - bounds.left;
    let selected = 0;
    let distance = Infinity;
    state.chart.x.forEach((point, index) => {
      const next = Math.abs(point - pointer);
      if (next < distance) { distance = next; selected = index; }
    });
    state.selectedChartIndex = selected;
    const row = state.chart.rows[selected];
    const detail = byId('chartDetail');
    if (detail) {
      detail.textContent = `${safeDate(row.observed_at)}　オンライン ${formatNumber(row.online_member_count)}人　再生数 ${formatNumber(row.current_stream_count)}　コメント勢い ${formatNumber(chartComment(row))}件 / 2分`;
    }
    drawChart();
  }

  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), payload: state.payload, history: state.history }));
    } catch {
      // Storage can be unavailable in private browsing. The live view still works.
    }
  }

  function restoreCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (!cached || Date.now() - Number(cached.savedAt || 0) > 6 * 60 * 60 * 1000) return;
      if (cached.payload?.ok) applyPayload(cached.payload, { save: false });
      if (Array.isArray(cached.history)) {
        state.history = cached.history.slice(-HISTORY_LIMIT);
        mergeLatestIntoHistory(state.payload);
        requestAnimationFrame(drawChart);
      }
    } catch {
      localStorage.removeItem(CACHE_KEY);
    }
  }

  function applyPayload(payload, { save = true } = {}) {
    state.payload = payload;
    const incomingQueue = Array.isArray(payload.queue) ? payload.queue : [];
    state.queue = incomingQueue;
    state.queueTotal = finite(payload.queue_status?.total_items) || incomingQueue.length;
    state.queueRevision = String(payload.queue_revision || '');
    state.playbackIndex = -1;
    renderHeader(payload);
    renderMetrics(payload);
    renderGoal(payload);
    renderNowPlaying(true);
    renderQueue();
    mergeLatestIntoHistory(payload);
    requestAnimationFrame(drawChart);
    if (save) saveCache();
  }

  async function fetchHistory() {
    const response = await fetch(HISTORY_URL, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`history API ${response.status}`);
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || 'history API error');
    state.history = (Array.isArray(payload.history) ? payload.history : [])
      .filter((row) => finite(row?.observed_at) != null)
      .slice(-HISTORY_LIMIT);
    mergeLatestIntoHistory(state.payload);
    state.selectedChartIndex = -1;
    requestAnimationFrame(drawChart);
    saveCache();
  }

  function showStatus(message, timeout = 5000) {
    const node = byId('statusMessage');
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
    clearTimeout(showStatus.timer);
    showStatus.timer = setTimeout(() => { node.hidden = true; }, timeout);
  }

  async function refreshDashboard() {
    if (state.refreshing || document.hidden) return;
    state.refreshing = true;
    state.abortController?.abort();
    state.abortController = new AbortController();
    try {
      const response = await fetch(DASHBOARD_URL, {
        signal: state.abortController.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`dashboard API ${response.status}`);
      const payload = await response.json();
      if (!payload.ok) throw new Error(payload.error || 'dashboard API error');
      applyPayload(payload);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.error(error);
        showStatus(state.payload ? '更新に失敗しました。保存済みの表示を継続します。' : 'データを取得できませんでした。');
        if (!state.payload) setText('description', 'データ取得に失敗しました。次回更新で再試行します。');
      }
    } finally {
      state.refreshing = false;
    }
  }

  function start() {
    restoreCache();
    byId('queueMore')?.addEventListener('click', loadMoreQueue);
    byId('chart')?.addEventListener('pointerup', selectChartPoint);
    refreshDashboard();
    fetchHistory().catch((error) => {
      console.error(error);
      if (!state.history.length) showStatus('履歴グラフを取得できませんでした。');
    });
    setInterval(() => {
      if (!document.hidden) refreshDashboard();
    }, 60_000);
    setInterval(() => {
      if (!document.hidden) renderNowPlaying();
    }, 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) state.abortController?.abort();
      else refreshDashboard();
    });
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(drawChart, 150);
    }, { passive: true });
  }

  start();
})();
