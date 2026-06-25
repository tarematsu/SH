
let lastHistoryRows = [];
let refreshInFlight = false;
let refreshAbortController = null;
let resizeTimer = null;
let lastRenderSignature = '';
let nowPlayingTimer = null;
let nowPlayingState = null;
let playbackQueue = [];
let simulatedCurrentIndex = -1;
let currentNowPlayingHost = {};
let mainChartState = null;
let selectedMainChartIndex = null;

const el = (id) => document.getElementById(id);
const number = (value) => value == null ? '-' : Number(value).toLocaleString('ja-JP');
const dateTime = (value) => value ? new Date(Number(value)).toLocaleString('ja-JP', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '-';
const etaDateTime = (value) => value ? new Date(Number(value)).toLocaleString('ja-JP', { month:'long', day:'numeric', weekday:'short', hour:'2-digit', minute:'2-digit' }) : '予測データ不足';
const duration = (ms) => {
  const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
const escapeText = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('\"', '&quot;')
  .replaceAll("'", '&#39;');

function inferredArtist(track) {
  const candidates = [
    track?.artist,
    track?.artist_name,
    track?.album_artist,
    track?.performer,
    track?.subtitle,
    Array.isArray(track?.artists) ? track.artists.map((item) => item?.name || item).filter(Boolean).join('、') : '',
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value && !/^JP[A-Z0-9]{8,}$/i.test(value)) return value;
  }

  const display = String(track?.display_title || '').trim();
  const title = String(track?.title || '').trim();
  if (!display) return '';

  for (const separator of [' — ', ' – ', ' - ', ' · ', ' • ', ' / ']) {
    const index = display.lastIndexOf(separator);
    if (index <= 0) continue;
    const left = display.slice(0, index).trim();
    const right = display.slice(index + separator.length).trim();
    if (!left || !right) continue;
    if (/^JP[A-Z0-9]{8,}$/i.test(left) || /^JP[A-Z0-9]{8,}$/i.test(right)) continue;
    if (!title || left === title || display.startsWith(`${title}${separator}`)) return right;
    if (right === title || display.endsWith(`${separator}${title}`)) return left;
  }

  const byMatch = display.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch && (!title || byMatch[1].trim() === title)) return byMatch[2].trim();
  return '';
}


function renderDailyDelta(elementId, value) {
  const node = el(elementId);
  if (!node) return;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  const sign = n > 0 ? '+' : n < 0 ? '−' : '±';
  node.textContent = `前日 ${sign}${number(Math.abs(n))}`;
  node.className = `daily-delta ${n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral'}`;
  node.hidden = false;
}

function setImage(element, src) {
  if (src) { element.src = src; element.hidden = false; }
  else element.hidden = true;
}

function downsampleRows(rows, maxPoints = 240) {
  if (!Array.isArray(rows)) return [];
  const valid = rows.filter(row => Number.isFinite(Number(row?.observed_at)));
  if (valid.length <= maxPoints) return valid;
  const step = (valid.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, i) => valid[Math.round(i * step)]);
}

function drawChart(rows = lastHistoryRows, selectionIndex = selectedMainChartIndex) {
  const canvas = el('chart');
  if (!canvas) return;

  const sampled = downsampleRows(rows);
  if (!sampled.length) return;
  lastHistoryRows = sampled;

  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.round(rect.width || canvas.clientWidth || 1000));
  const height = Math.max(260, Math.min(380, Math.round(width * 0.32)));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);

  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = { left: 48, right: 76, top: 20, bottom: 50 };
  const plotWidth = Math.max(1, width - pad.left - pad.right);
  const plotHeight = Math.max(1, height - pad.top - pad.bottom);
  const onlineValues = sampled.map((row) => Number(row.online_member_count)).filter(Number.isFinite);
  const playValues = sampled.map((row) => Number(row.current_stream_count)).filter(Number.isFinite);
  if (!onlineValues.length && !playValues.length) return;

  const times = sampled.map((row) => Number(row.observed_at));
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const timeSpan = Math.max(1, maxTime - minTime);
  const xPositions = times.map((time, index) => Number.isFinite(time)
    ? pad.left + plotWidth * (time - minTime) / timeSpan
    : pad.left + plotWidth * index / Math.max(1, sampled.length - 1));

  const intervals = times.slice(1).map((time, index) => time - times[index]).filter((value) => value > 0).sort((a, b) => a - b);
  const medianInterval = intervals.length ? intervals[Math.floor(intervals.length / 2)] : 60_000;
  const gapThreshold = Math.max(5 * 60_000, medianInterval * 4);

  const rangeFor = (values, minimumPadding = 1) => {
    if (!values.length) return { min: 0, max: 1, range: 1 };
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const padding = Math.max(minimumPadding, (rawMax - rawMin) * 0.08);
    const min = Math.max(0, rawMin - padding);
    const max = rawMax + padding;
    return { min, max, range: Math.max(1, max - min) };
  };

  const onlineScale = rangeFor(onlineValues, 5);
  const playScale = rangeFor(playValues, 10);
  const styles = getComputedStyle(document.documentElement);
  const muted = styles.getPropertyValue('--muted').trim() || '#aaa3b5';
  const onlineColor = styles.getPropertyValue('--accent').trim() || '#ff7aa8';
  const playColor = styles.getPropertyValue('--accent-2').trim() || '#9c7bf4';
  const compact = new Intl.NumberFormat('ja-JP', { notation: 'compact', maximumFractionDigits: 1 });

  ctx.font = '12px system-ui';
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const ratio = i / 4;
    const y = pad.top + plotHeight * ratio;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();

    ctx.fillStyle = onlineColor;
    ctx.fillText(String(Math.round(onlineScale.max - onlineScale.range * ratio)), 5, y + 4);
    ctx.fillStyle = playColor;
    ctx.fillText(compact.format(Math.round(playScale.max - playScale.range * ratio)), width - pad.right + 9, y + 4);
  }

  const yFor = (value, scale) => height - pad.bottom - (value - scale.min) * plotHeight / scale.range;
  const drawSeries = (key, scale, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let started = false;
    sampled.forEach((row, index) => {
      const value = Number(row[key]);
      const temporalGap = index > 0 && times[index] - times[index - 1] > gapThreshold;
      if (!Number.isFinite(value) || temporalGap) started = false;
      if (!Number.isFinite(value)) return;
      const x = xPositions[index];
      const y = yFor(value, scale);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  if (onlineValues.length) drawSeries('online_member_count', onlineScale, onlineColor);
  if (playValues.length) drawSeries('current_stream_count', playScale, playColor);

  // 横軸は表示幅に応じて時刻数を増減し、重なりを避ける。
  const tickTarget = Math.max(5, Math.min(14, Math.floor(plotWidth / 72)));
  const tickIndices = [...new Set(Array.from({ length: tickTarget }, (_, i) =>
    Math.round((sampled.length - 1) * i / Math.max(1, tickTarget - 1))))];
  ctx.font = '11px system-ui';
  ctx.fillStyle = muted;
  ctx.textBaseline = 'top';
  let lastRight = -Infinity;
  tickIndices.forEach((index, tickPosition) => {
    const date = new Date(times[index]);
    const crossesDate = new Date(minTime).toLocaleDateString('ja-JP') !== new Date(maxTime).toLocaleDateString('ja-JP');
    const label = crossesDate
      ? date.toLocaleString('ja-JP', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })
      : date.toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit' });
    const measured = ctx.measureText(label).width;
    const x = Math.max(pad.left, Math.min(width - pad.right - measured, xPositions[index] - measured / 2));
    const isLast = tickPosition === tickIndices.length - 1;
    if (x > lastRight + 7 || isLast) {
      ctx.fillText(label, x, height - pad.bottom + 12);
      lastRight = x + measured;
    }
  });

  if (Number.isInteger(selectionIndex) && selectionIndex >= 0 && selectionIndex < sampled.length) {
    const x = xPositions[selectionIndex];
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.65)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, height - pad.bottom);
    ctx.stroke();
    ctx.restore();

    const online = Number(sampled[selectionIndex].online_member_count);
    const plays = Number(sampled[selectionIndex].current_stream_count);
    if (Number.isFinite(online)) {
      ctx.beginPath(); ctx.fillStyle = '#fff'; ctx.arc(x, yFor(online, onlineScale), 5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.fillStyle = onlineColor; ctx.arc(x, yFor(online, onlineScale), 3, 0, Math.PI * 2); ctx.fill();
    }
    if (Number.isFinite(plays)) {
      ctx.beginPath(); ctx.fillStyle = '#fff'; ctx.arc(x, yFor(plays, playScale), 5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.fillStyle = playColor; ctx.arc(x, yFor(plays, playScale), 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  mainChartState = { sampled, xPositions };
}

function showMainChartDetail(index) {
  if (!mainChartState || !Number.isInteger(index)) return;
  const row = mainChartState.sampled[index];
  if (!row) return;
  selectedMainChartIndex = index;
  const detail = el('mainChartDetail');
  if (detail) {
    detail.innerHTML = `<time>${escapeText(new Date(Number(row.observed_at)).toLocaleString('ja-JP', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' }))}</time>` +
      `<div><span>オンライン</span><strong>${number(row.online_member_count)}人</strong></div>` +
      `<div><span>再生数</span><strong>${number(row.current_stream_count)}</strong></div>`;
  }
  drawChart(lastHistoryRows, index);
}

function selectMainChartPoint(event) {
  if (!mainChartState?.xPositions?.length) return;
  const rect = el('chart').getBoundingClientRect();
  const x = event.clientX - rect.left;
  let nearest = 0;
  let distance = Infinity;
  mainChartState.xPositions.forEach((pointX, index) => {
    const next = Math.abs(pointX - x);
    if (next < distance) { distance = next; nearest = index; }
  });
  showMainChartDetail(nearest);
}

function stopNowPlayingTimer() {
  if (nowPlayingTimer) clearInterval(nowPlayingTimer);
  nowPlayingTimer = null;
}

function currentSimulatedTrack() {
  return simulatedCurrentIndex >= 0 ? playbackQueue[simulatedCurrentIndex] || null : null;
}

function openTrackOnSpotify(track) {
  const spotifyUrl = track?.spotify_url || (track?.spotify_id ? `https://open.spotify.com/track/${track.spotify_id}` : '');
  if (spotifyUrl) window.open(spotifyUrl, '_blank', 'noopener,noreferrer');
}

function renderNowDisplay(track, progressMs = 0, host = {}) {
  const box = el('nowPlaying');
  if (!box) return;
  if (!track) {
    box.className = 'now-content empty';
    box.removeAttribute('role');
    box.removeAttribute('tabindex');
    box.removeAttribute('title');
    box.onclick = null;
    box.onkeydown = null;
    box.textContent = 'キュー情報がありません';
    return;
  }

  const title = track.title || track.display_title || track.spotify_id || '曲名不明';
  const artist = inferredArtist(track);
  const spotifyUrl = track.spotify_url || (track.spotify_id ? `https://open.spotify.com/track/${track.spotify_id}` : '');
  const durationMs = Math.max(0, Number(track.duration_ms) || 0);
  const safeProgress = Math.min(durationMs || Infinity, Math.max(0, Number(progressMs) || 0));
  const progress = durationMs ? Math.min(100, safeProgress / durationMs * 100) : 0;

  box.className = `now-content${spotifyUrl ? ' clickable' : ''}`;
  if (spotifyUrl) {
    box.setAttribute('role', 'link');
    box.setAttribute('tabindex', '0');
    box.setAttribute('title', 'Spotifyで開く');
  } else {
    box.removeAttribute('role');
    box.removeAttribute('tabindex');
    box.removeAttribute('title');
  }

  box.innerHTML = `
    <img class="cover" src="${track.thumbnail_url || ''}" alt="" ${track.thumbnail_url ? '' : 'hidden'}>
    <div class="track-copy">
      <h3>${escapeText(title)}</h3>
      ${artist ? `<p>${escapeText(artist)}</p>` : ''}
      <div class="track-meta"><span id="nowPlayingTime">${duration(safeProgress)} / ${duration(durationMs)}</span></div>
      <div class="progress track-progress"><i id="nowPlayingBar" style="width:${progress}%"></i></div>
      ${spotifyUrl ? '<small class="spotify-open-hint">クリックしてSpotifyで開く</small>' : ''}
    </div>
    <div class="now-host">
      <img class="host-avatar" src="${host.image || ''}" alt="" ${host.image ? '' : 'hidden'}>
      <div class="host-copy">
        <small>配信ホスト</small>
        <strong>${escapeText(host.handle ? `@${host.handle}` : '-')}</strong>
      </div>
    </div>`;

  if (spotifyUrl) {
    box.onclick = () => openTrackOnSpotify(track);
    box.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openTrackOnSpotify(track);
      }
    };
  } else {
    box.onclick = null;
    box.onkeydown = null;
  }
}

function renderSimulatedQueue() {
  const queueForDisplay = playbackQueue.map((track, index) => ({
    ...track,
    is_current: index === simulatedCurrentIndex,
  }));
  renderQueue(queueForDisplay, playbackQueue.length);
}

function advanceSimulatedTrack(carryMs = 0) {
  if (simulatedCurrentIndex < 0) return false;
  let nextIndex = simulatedCurrentIndex + 1;
  let remaining = Math.max(0, carryMs);

  while (nextIndex < playbackQueue.length) {
    const nextDuration = Math.max(0, Number(playbackQueue[nextIndex]?.duration_ms) || 0);
    if (!nextDuration || remaining < nextDuration) break;
    remaining -= nextDuration;
    nextIndex += 1;
  }

  if (nextIndex >= playbackQueue.length) {
    nowPlayingState = null;
    simulatedCurrentIndex = -1;
    currentNowPlayingHost = {};
    renderNowDisplay(null);
    renderSimulatedQueue();
    return false;
  }

  simulatedCurrentIndex = nextIndex;
  nowPlayingState = {
    baseProgressMs: remaining,
    durationMs: Math.max(0, Number(playbackQueue[nextIndex]?.duration_ms) || 0),
    renderedAt: Date.now(),
  };
  renderNowDisplay(currentSimulatedTrack(), remaining, currentNowPlayingHost);
  renderSimulatedQueue();
  return true;
}

function updateNowPlayingProgress() {
  if (!nowPlayingState) return;
  const elapsed = Date.now() - nowPlayingState.renderedAt;
  let currentMs = Math.max(0, nowPlayingState.baseProgressMs + elapsed);

  if (nowPlayingState.durationMs > 0 && currentMs >= nowPlayingState.durationMs) {
    const carryMs = currentMs - nowPlayingState.durationMs;
    if (!advanceSimulatedTrack(carryMs)) return;
    currentMs = nowPlayingState.baseProgressMs;
  }

  const percent = nowPlayingState.durationMs
    ? Math.min(100, currentMs / nowPlayingState.durationMs * 100)
    : 0;
  const time = el('nowPlayingTime');
  const bar = el('nowPlayingBar');
  if (time) time.textContent = `${duration(currentMs)} / ${duration(nowPlayingState.durationMs)}`;
  if (bar) bar.style.width = `${percent}%`;
}

function renderNow(track, queue = [], currentIndex = 0, host = {}) {
  stopNowPlayingTimer();
  playbackQueue = Array.isArray(queue) ? queue.slice() : [];
  simulatedCurrentIndex = track ? Math.max(0, currentIndex) : -1;
  currentNowPlayingHost = track ? { ...host } : {};

  if (!track) {
    nowPlayingState = null;
    currentNowPlayingHost = {};
    renderNowDisplay(null);
    renderSimulatedQueue();
    return;
  }

  const durationMs = Math.max(0, Number(track.duration_ms) || 0);
  const baseProgressMs = Math.min(durationMs || Infinity, Math.max(0, Number(track.progress_ms) || 0));
  nowPlayingState = { baseProgressMs, durationMs, renderedAt: Date.now() };
  renderNowDisplay(track, baseProgressMs, host);
  renderSimulatedQueue();
  updateNowPlayingProgress();
  nowPlayingTimer = setInterval(updateNowPlayingProgress, 1000);
}

function renderQueue(queue, totalItems) {
  el('queueCount').textContent = `${number(totalItems ?? queue.length)}曲`;
  const upcoming = queue.filter(t => !t.is_current);
  const box = el('queue');
  if (!upcoming.length) { box.innerHTML = '<p class="muted">次の曲はありません。</p>'; return; }
  box.replaceChildren(...upcoming.map((track, index) => {
    const row = document.createElement('a');
    row.className = 'queue-item';
    row.href = track.spotify_url || '#';
    row.target = track.spotify_url ? '_blank' : '';
    row.rel = 'noopener';
    row.innerHTML = `
      <span class="queue-no">${index + 1}</span>
      <img src="${track.thumbnail_url || ''}" alt="" ${track.thumbnail_url ? '' : 'hidden'}>
      <span class="queue-copy"><strong>${escapeText(track.title || track.display_title || track.spotify_id || '曲名不明')}</strong>${inferredArtist(track) ? `<small>${escapeText(inferredArtist(track))}</small>` : ''}</span>
      <span class="queue-duration">${duration(track.duration_ms)}</span>`;
    return row;
  }));
}

function renderPrediction(prediction, current, goal) {
  const eta = el('goalEta');
  const rate = el('goalRate');
  if (!eta || !rate) return;

  if (!prediction) {
    eta.textContent = current >= goal && goal > 0 ? '目標達成済み' : '予測データ不足';
    rate.textContent = '最低15分以上の履歴が必要です';
    return;
  }
  eta.textContent = etaDateTime(prediction.eta);
  rate.textContent = `平均 +${number(Math.round(prediction.rate_per_hour))} /時`;
}

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  refreshAbortController?.abort();
  refreshAbortController = new AbortController();

  try {
    const response = await fetch('/api/dashboard', {
      cache: 'no-store',
      signal: refreshAbortController.signal,
      headers: { 'accept': 'application/json' },
    });
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'API error');
    const latest = data.latest || {};

    el('channelName').textContent = latest.channel_name || 'Buddies';
    el('description').textContent = latest.description || latest.artist_name || '';
    setImage(el('channelImage'), latest.channel_image || latest.logo_image);
    if (latest.accent_color) document.documentElement.style.setProperty('--accent', latest.accent_color);

    el('online').textContent = number(latest.online_member_count);
    el('members').textContent = number(latest.total_member_count);
    el('totalListens').textContent = number(latest.total_listens);
    renderDailyDelta('membersDelta', data.daily_change?.total_member_count);
    renderDailyDelta('listensDelta', data.daily_change?.total_listens);
    el('updated').textContent = `最終取得 ${dateTime(latest.observed_at)}`;

    const count = Number(latest.current_stream_count) || 0;
    const goal = Number(latest.stream_goal) || 0;
    const pct = goal ? Math.min(100, count / goal * 100) : 0;
    el('streamCount').textContent = number(count);
    el('streamGoal').textContent = number(goal);
    el('goalBar').style.width = `${pct}%`;
    el('goalPercent').textContent = `${pct.toFixed(2)}%`;
    el('goalRemaining').textContent = goal ? `残り ${number(Math.max(0, goal - count))}` : '-';
    renderPrediction(data.goal_prediction, count, goal);

    const queue = Array.isArray(data.queue) ? data.queue : [];
    const foundCurrentIndex = queue.findIndex(t => t.is_current);
    const currentIndex = foundCurrentIndex >= 0 ? foundCurrentIndex : (queue.length ? 0 : -1);
    const current = currentIndex >= 0 ? queue[currentIndex] : null;
    renderNow(current, queue, currentIndex, { handle: latest.host_handle, image: latest.host_image });

    const history = Array.isArray(data.history) ? data.history : [];
    if (history.length) {
      const signature = `${history.length}:${history[0]?.observed_at}:${history.at(-1)?.observed_at}:${history.at(-1)?.online_member_count}:${history.at(-1)?.current_stream_count}`;
      if (signature !== lastRenderSignature) {
        lastRenderSignature = signature;
        selectedMainChartIndex = null;
        lastHistoryRows = history;
        requestAnimationFrame(() => drawChart(history));
      }
    }
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error(error);
      const description = el('description');
      if (description && description.textContent === '読み込み中...') {
        description.textContent = 'データ取得に失敗しました。次回更新で再試行します。';
      }
    }
    // 失敗時は前回表示・前回グラフをそのまま維持
  } finally {
    refreshInFlight = false;
  }
}

el('chart')?.addEventListener('pointerup', selectMainChartPoint);

refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 60_000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => drawChart(lastHistoryRows), 180);
}, { passive: true });
