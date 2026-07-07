function stopNowPlayingTimer() {
  if (nowPlayingTimer) clearInterval(nowPlayingTimer);
  nowPlayingTimer = null;
}

function currentSimulatedTrack() {
  return simulatedCurrentIndex >= 0 ? playbackQueue[simulatedCurrentIndex] || null : null;
}

function safeSpotifyUrl(track) {
  const url = track?.spotify_url || (track?.spotify_id ? `https://open.spotify.com/track/${track.spotify_id}` : '');
  if (!url) return '';
  try { return new URL(url).protocol === 'https:' ? url : ''; } catch { return ''; }
}

function openTrackOnSpotify(track) {
  const url = safeSpotifyUrl(track);
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
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
    const sectionHead = box.closest('.now-playing')?.querySelector('.section-head');
    const hostNode = sectionHead?.querySelector('.now-host');
    if (hostNode) hostNode.innerHTML = '';
    return;
  }

  const title = track.title || track.display_title || track.spotify_id || '曲名不明';
  const artist = inferredArtist(track);
  const spotifyUrl = safeSpotifyUrl(track);
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
    ${playbackImage(track.thumbnail_url, 'cover', true)}
    <div class="track-copy">
      <h3>${escapeText(title)}</h3>
      ${artist ? `<p>${escapeText(artist)}</p>` : ''}
      <div class="track-meta"><span id="nowPlayingTime">${duration(safeProgress)} / ${duration(durationMs)}</span></div>
      <div class="progress track-progress"><i id="nowPlayingBar" style="width:${progress}%"></i></div>
      ${spotifyUrl ? '<small class="spotify-open-hint">クリックしてSpotifyで開く</small>' : ''}
    </div>`;

  const sectionHead = box.closest('.now-playing')?.querySelector('.section-head');
  if (sectionHead) {
    let hostNode = sectionHead.querySelector('.now-host');
    if (!hostNode) {
      hostNode = document.createElement('div');
      hostNode.className = 'now-host now-host-inline';
      sectionHead.appendChild(hostNode);
    }
    hostNode.innerHTML = `
      <div class="host-copy">
        <small>配信ホスト</small>
        ${((host.handle || host.host_handle) ? `<strong><a href="https://stationhead.com/${host.handle || host.host_handle}" target="_blank" rel="noopener">@${escapeText(host.handle || host.host_handle)}</a></strong>` : `<strong>-</strong>`)}
      </div>`;
  }

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

function renderNow(track, queue = [], currentIndex = 0, host = {}, playback = {}) {
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
  const responseAgeMs = Number.isFinite(Number(playback.response_age_ms))
    ? Math.max(0, Number(playback.response_age_ms))
    : 0;
  const shouldAdvance = playback.playing !== false;
  const anchorAt = Number(playback.anchor_at);
  const initialProgressMs = shouldAdvance && Number.isFinite(anchorAt)
    ? Math.max(0, Date.now() - anchorAt)
    : Math.max(0, Number(track.progress_ms) || 0) + (shouldAdvance ? responseAgeMs : 0);
  const baseProgressMs = Math.min(durationMs || Infinity, initialProgressMs);
  nowPlayingState = { baseProgressMs, durationMs, renderedAt: Date.now() };
  if (shouldAdvance && durationMs > 0 && initialProgressMs >= durationMs) {
    advanceSimulatedTrack(initialProgressMs - durationMs);
    if (nowPlayingState) nowPlayingTimer = setInterval(updateNowPlayingProgress, 1000);
    return;
  }
  renderNowDisplay(track, baseProgressMs, host);
  renderSimulatedQueue();
  updateNowPlayingProgress();
  if (shouldAdvance) nowPlayingTimer = setInterval(updateNowPlayingProgress, 1000);
}

function renderQueue(queue, totalItems) {
  const visibleLimit = 20;
  const upcoming = queue.filter(t => !t.is_current);
  const visible = upcoming.slice(0, visibleLimit);
  const hiddenCount = Math.max(0, upcoming.length - visible.length);
  el('queueCount').textContent = hiddenCount > 0
    ? `${number(totalItems ?? queue.length)}曲 / 表示 ${visible.length}曲`
    : `${number(totalItems ?? queue.length)}曲`;
  const box = el('queue');
  if (!visible.length) { box.innerHTML = '<p class="muted">次の曲はありません。</p>'; return; }
  box.replaceChildren(...visible.map((track, index) => {
    const row = document.createElement('a');
    row.className = 'queue-item';
    const trackUrl = safeSpotifyUrl(track);
    row.href = trackUrl || '#';
    row.target = trackUrl ? '_blank' : '';
    row.rel = 'noopener noreferrer';
    row.innerHTML = `
      <span class="queue-no">${index + 1}</span>
      ${playbackImage(track.thumbnail_url)}
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
