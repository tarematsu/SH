const el = (id) => document.getElementById(id);
const number = (value) => value == null ? '-' : Number(value).toLocaleString('ja-JP');
const dateTime = (value) => value ? new Date(Number(value)).toLocaleString('ja-JP', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '-';
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
  const height = Math.max(260, Math.min(380, width * 0.32));
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  if (!rows.length) return;
  const pad = { left: 46, right: 18, top: 20, bottom: 34 };
  const series = [
    { key: 'listener_count', css: '--accent' },
    { key: 'online_member_count', css: '--accent-2' },
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

function renderNow(track) {
  const box = el('nowPlaying');
  if (!track) {
    box.className = 'now-content empty';
    box.textContent = 'キュー情報がありません';
    el('spotifyLink').hidden = true;
    return;
  }
  el('spotifyLink').hidden = !track.spotify_url;
  el('spotifyLink').href = track.spotify_url || '#';
  box.className = 'now-content';
  box.innerHTML = `
    <img class="cover" src="${track.thumbnail_url || ''}" alt="" ${track.thumbnail_url ? '' : 'hidden'}>
    <div class="track-copy">
      <h3>${escapeText(track.title || track.display_title || track.spotify_id || '曲名不明')}</h3>
      <p>${escapeText(track.artist || 'アーティスト情報なし')}</p>
      <div class="track-meta"><span>${duration(track.progress_ms)} / ${duration(track.duration_ms)}</span><span>ISRC ${escapeText(track.isrc || '-')}</span></div>
      <div class="progress track-progress"><i style="width:${Math.min(100, (track.progress_ms || 0) / Math.max(1, track.duration_ms || 1) * 100)}%"></i></div>
    </div>`;
}

function renderQueue(queue, totalItems) {
  el('queueCount').textContent = `${number(totalItems ?? queue.length)}曲`;
  const upcoming = queue.filter(t => !t.is_current).slice(0, 12);
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
      <span class="queue-copy"><strong>${escapeText(track.title || track.display_title || track.spotify_id || '曲名不明')}</strong><small>${escapeText(track.artist || track.isrc || '')}</small></span>
      <span class="queue-duration">${duration(track.duration_ms)}</span>`;
    return row;
  }));
}

function renderComments(comments) {
  el('commentCount').textContent = `${number(comments.length)}件`;
  const box = el('comments');
  if (!comments.length) { box.innerHTML = '<p class="muted">コメントはありません。</p>'; return; }
  box.replaceChildren(...comments.map((comment) => {
    const item = document.createElement('article');
    item.className = 'comment';
    const flags = [comment.all_access_chat ? 'All Access' : '', comment.boost_chat ? 'Boost' : ''].filter(Boolean);
    item.innerHTML = `
      <div class="avatar">${escapeText(comment.emoji || (comment.handle || '?').slice(0,1).toUpperCase())}</div>
      <div><div class="comment-head"><strong>@${escapeText(comment.handle || 'guest')}</strong>${flags.map(f => `<span class="tag">${f}</span>`).join('')}<time>${dateTime(comment.chat_time_ms || comment.observed_at)}</time></div><p>${escapeText(comment.text)}</p></div>`;
    return item;
  }));
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

  el('listeners').textContent = number(latest.listener_count);
  el('online').textContent = number(latest.online_member_count);
  el('members').textContent = number(latest.total_member_count);
  el('totalListens').textContent = number(latest.total_listens);
  el('host').textContent = latest.host_handle ? `@${latest.host_handle}` : '-';
  el('updated').textContent = `最終取得 ${dateTime(latest.observed_at)}`;

  const live = Boolean(latest.is_broadcasting);
  el('liveBadge').textContent = live ? '● LIVE' : 'OFF AIR';
  el('liveBadge').className = `live-badge ${live ? 'on' : ''}`;

  const ageMinutes = latest.observed_at ? (Date.now() - Number(latest.observed_at)) / 60000 : Infinity;
  const health = el('health');
  health.className = ageMinutes <= 2.5 ? 'status-ok' : ageMinutes <= 6 ? 'status-warn' : 'status-stop';
  health.textContent = ageMinutes <= 2.5 ? '監視正常' : ageMinutes <= 6 ? '取得遅延' : '停止の可能性';

  const count = Number(latest.current_stream_count) || 0;
  const goal = Number(latest.stream_goal) || 0;
  const pct = goal ? Math.min(100, count / goal * 100) : 0;
  el('streamCount').textContent = number(count);
  el('streamGoal').textContent = number(goal);
  el('goalBar').style.width = `${pct}%`;
  el('goalPercent').textContent = `${pct.toFixed(2)}%`;
  el('goalRemaining').textContent = goal ? `残り ${number(Math.max(0, goal - count))}` : '-';

  const current = data.queue.find(t => t.is_current) || data.queue[0] || null;
  renderNow(current);
  renderQueue(data.queue, data.queue_status?.total_items);
  renderComments(data.comments || []);
  drawChart(data.history || []);
}

refresh().catch((error) => { el('health').textContent = error.message; el('health').className = 'status-stop'; });
setInterval(() => refresh().catch(console.error), 60_000);
window.addEventListener('resize', () => refresh().catch(console.error));
