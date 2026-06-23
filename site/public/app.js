
let spotifyController = null;
let pendingSpotifyUri = null;
window.onSpotifyIframeApiReady = (IFrameAPI) => {
  const element = document.getElementById('spotifyEmbed');
  const uri = pendingSpotifyUri || 'spotify:track:6p0awehpa8bAujabY1DZJz';
  IFrameAPI.createController(element, { uri, width: '100%', height: 152 }, (controller) => {
    spotifyController = controller;
  });
};

function loadSpotifyTrack(track) {
  const id = track?.spotify_id;
  const embed = el('spotifyEmbed');
  if (!id) { embed.hidden = true; pendingSpotifyUri = null; return; }
  const uri = `spotify:track:${id}`;
  pendingSpotifyUri = uri;
  embed.hidden = false;
  spotifyController?.loadUri(uri);
}

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

function drawChart(rows) {
  const canvas = el('chart');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 1000;
  const height = Math.max(250, Math.min(360, width * 0.3));
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  if (!rows.length) return;

  const pad = { left: 46, right: 18, top: 20, bottom: 34 };
  const series = [
    { key: 'online_member_count', css: '--accent' },
    { key: 'listener_count', css: '--accent-2' },
  ];
  const all = rows.flatMap(r => series.map(s => Number(r[s.key]))).filter(Number.isFinite);
  if (!all.length) return;
  const min = Math.max(0, Math.min(...all) - 10);
  const max = Math.max(...all) + 10;
  const range = Math.max(1, max - min);

  ctx.font = '12px system-ui';
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted');
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (height - pad.top - pad.bottom) * i / 4;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    ctx.fillText(String(Math.round(max - range * i / 4)), 5, y + 4);
  }

  series.forEach((s) => {
    const color = getComputedStyle(document.documentElement).getPropertyValue(s.css).trim();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    rows.forEach((row, index) => {
      const value = Number(row[s.key]);
      const x = pad.left + index * (width - pad.left - pad.right) / Math.max(1, rows.length - 1);
      const y = height - pad.bottom - (value - min) * (height - pad.top - pad.bottom) / range;
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  });

  const first = rows[0]?.observed_at;
  const last = rows.at(-1)?.observed_at;
  ctx.fillText(first ? new Date(first).toLocaleTimeString('ja-JP', {hour:'2-digit',minute:'2-digit'}) : '', pad.left, height - 9);
  const label = last ? new Date(last).toLocaleTimeString('ja-JP', {hour:'2-digit',minute:'2-digit'}) : '';
  ctx.fillText(label, width - pad.right - ctx.measureText(label).width, height - 9);
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
  const response = await fetch('/api/dashboard', { cache: 'no-store' });
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

  const current = data.queue.find(t => t.is_current) || data.queue[0] || null;
  loadSpotifyTrack(current);
  renderQueue(data.queue, data.queue_status?.total_items);
  drawChart(data.history || []);
}

refresh().catch(console.error);
setInterval(() => refresh().catch(console.error), 60_000);
window.addEventListener('resize', () => drawChart([]));

