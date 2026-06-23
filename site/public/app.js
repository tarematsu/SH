
let lastHistoryRows = [];
let refreshInFlight = false;
let refreshAbortController = null;
let resizeTimer = null;
let lastRenderSignature = '';
let nowPlayingTimer = null;
let nowPlayingState = null;

const el = (id) => document.getElementById(id);
const number = (value) => value == null ? '-' : Number(value).toLocaleString('ja-JP');
const dateTime = (value) => value ? new Date(Number(value)).toLocaleString('ja-JP', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '-';
const etaDateTime = (value) => value ? new Date(Number(value)).toLocaleString('ja-JP', { month:'long', day:'numeric', weekday:'short', hour:'2-digit', minute:'2-digit' }) : '予測データ不足';
const duration = (ms) => {
  const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
const escapeText = (value) => String(value ?? '');

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

function drawChart(rows = lastHistoryRows) {
  const canvas = el('chart');
  if (!canvas) return;

  const sampled = downsampleRows(rows);
  if (!sampled.length) {
    // 一時的なAPI失敗やresizeでは、既存グラフを消さない
    return;
  }
  lastHistoryRows = sampled;

  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.round(rect.width || canvas.clientWidth || 1000));
  const height = Math.max(250, Math.min(360, Math.round(width * 0.3)));
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

  const pad = { left: 46, right: 18, top: 20, bottom: 34 };
  const series = [
    { key: 'online_member_count', css: '--accent' },
    { key: 'listener_count', css: '--accent-2' },
  ];
  const all = sampled.flatMap(r => series.map(s => Number(r[s.key]))).filter(Number.isFinite);
  if (!all.length) return;
  const min = Math.max(0, Math.min(...all) - 10);
  const max = Math.max(...all) + 10;
  const range = Math.max(1, max - min);

  const styles = getComputedStyle(document.documentElement);
  ctx.font = '12px system-ui';
  ctx.fillStyle = styles.getPropertyValue('--muted').trim() || '#aaa3b5';
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (height - pad.top - pad.bottom) * i / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(max - range * i / 4)), 5, y + 4);
  }

  series.forEach((seriesItem) => {
    const color = styles.getPropertyValue(seriesItem.css).trim();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let started = false;
    sampled.forEach((row, index) => {
      const value = Number(row[seriesItem.key]);
      if (!Number.isFinite(value)) return;
      const x = pad.left + index * (width - pad.left - pad.right) / Math.max(1, sampled.length - 1);
      const y = height - pad.bottom - (value - min) * (height - pad.top - pad.bottom) / range;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    if (started) ctx.stroke();
  });

  const first = sampled[0]?.observed_at;
  const last = sampled.at(-1)?.observed_at;
  ctx.fillText(first ? new Date(Number(first)).toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit' }) : '', pad.left, height - 9);
  const label = last ? new Date(Number(last)).toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit' }) : '';
  ctx.fillText(label, width - pad.right - ctx.measureText(label).width, height - 9);
}

function stopNowPlayingTimer() {
  if (nowPlayingTimer) clearInterval(nowPlayingTimer);
  nowPlayingTimer = null;
  nowPlayingState = null;
}

function updateNowPlayingProgress() {
  if (!nowPlayingState) return;
  const elapsed = Date.now() - nowPlayingState.renderedAt;
  const currentMs = Math.min(
    nowPlayingState.durationMs,
    Math.max(0, nowPlayingState.baseProgressMs + elapsed),
  );
  const percent = nowPlayingState.durationMs
    ? Math.min(100, currentMs / nowPlayingState.durationMs * 100)
    : 0;
  const time = el('nowPlayingTime');
  const bar = el('nowPlayingBar');
  if (time) time.textContent = `${duration(currentMs)} / ${duration(nowPlayingState.durationMs)}`;
  if (bar) bar.style.width = `${percent}%`;
}

function renderNow(track) {
  const box = el('nowPlaying');
  if (!box) return;
  stopNowPlayingTimer();
  if (!track) {
    box.className = 'now-content empty';
    box.removeAttribute('role');
    box.removeAttribute('tabindex');
    box.removeAttribute('title');
    box.textContent = 'キュー情報がありません';
    return;
  }
  const title = track.title || track.display_title || track.spotify_id || '曲名不明';
  const artist = track.artist || 'アーティスト情報なし';
  const spotifyUrl = track.spotify_url || (track.spotify_id ? `https://open.spotify.com/track/${track.spotify_id}` : '');
  const durationMs = Math.max(0, Number(track.duration_ms) || 0);
  const baseProgressMs = Math.min(durationMs || Infinity, Math.max(0, Number(track.progress_ms) || 0));
  const progress = durationMs ? Math.min(100, baseProgressMs / durationMs * 100) : 0;
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
      <p>${escapeText(artist)}</p>
      <div class="track-meta"><span id="nowPlayingTime">${duration(baseProgressMs)} / ${duration(durationMs)}</span><span>ISRC ${escapeText(track.isrc || '-')}</span></div>
      <div class="progress track-progress"><i id="nowPlayingBar" style="width:${progress}%"></i></div>
      ${spotifyUrl ? '<small class="spotify-open-hint">クリックしてSpotifyで開く</small>' : ''}
    </div>`;

  if (spotifyUrl) {
    const openSpotify = () => window.open(spotifyUrl, '_blank', 'noopener,noreferrer');
    box.onclick = openSpotify;
    box.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openSpotify();
      }
    };
  } else {
    box.onclick = null;
    box.onkeydown = null;
  }

  nowPlayingState = { baseProgressMs, durationMs, renderedAt: Date.now() };
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
      <span class="queue-copy"><strong>${escapeText(track.title || track.display_title || track.spotify_id || '曲名不明')}</strong><small>${escapeText(track.artist || 'アーティスト情報なし')}</small></span>
      <span class="queue-duration">${duration(track.duration_ms)}</span>`;
    return row;
  }));
}

function renderPrediction(prediction, current, goal) {
  if (!prediction) {
    el('goalEta').textContent = current >= goal && goal > 0 ? '目標達成済み' : '予測データ不足';
    el('goalRate').textContent = '最低15分以上の履歴が必要です';
    el('goalConfidence').textContent = '-';
    el('goalConfidence').className = '';
    return;
  }
  el('goalEta').textContent = etaDateTime(prediction.eta);
  el('goalRate').textContent = `平均 +${number(Math.round(prediction.rate_per_hour))} /時`;
  const labels = { high: '信頼度 高', medium: '信頼度 中', low: '信頼度 低' };
  el('goalConfidence').textContent = labels[prediction.confidence] || '参考値';
  el('goalConfidence').className = `confidence ${prediction.confidence || 'low'}`;
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
    setImage(el('hostImage'), latest.host_image);
    if (latest.accent_color) document.documentElement.style.setProperty('--accent', latest.accent_color);

    el('online').textContent = number(latest.online_member_count);
    el('listeners').textContent = number(latest.listener_count);
    el('members').textContent = number(latest.total_member_count);
    el('totalListens').textContent = number(latest.total_listens);
    el('host').textContent = latest.host_handle ? `@${latest.host_handle}` : '-';
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
    const current = queue.find(t => t.is_current) || queue[0] || null;
    renderNow(current);
    renderQueue(queue, data.queue_status?.total_items);

    const history = Array.isArray(data.history) ? data.history : [];
    if (history.length) {
      const signature = `${history.length}:${history[0]?.observed_at}:${history.at(-1)?.observed_at}:${history.at(-1)?.online_member_count}:${history.at(-1)?.listener_count}`;
      if (signature !== lastRenderSignature) {
        lastRenderSignature = signature;
        lastHistoryRows = history;
        requestAnimationFrame(() => drawChart(history));
      }
    }
  } catch (error) {
    if (error?.name !== 'AbortError') console.error(error);
    // 失敗時は前回表示・前回グラフをそのまま維持
  } finally {
    refreshInFlight = false;
  }
}

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
