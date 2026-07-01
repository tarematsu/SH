(() => {
  const baseDrawChart = drawChart;
  let lastDashboardObservedAt = 0;
  let lastQueueRevision = '';
  let hiddenAt = 0;
  let playbackActive = null;

  function mergeDashboardHistory(rows, delta) {
    const cutoff = Date.now() - 86400000;
    const byBucket = new Map();
    const mergeRow = (row) => {
      const observedAt = Number(row?.observed_at);
      if (!Number.isFinite(observedAt) || observedAt < cutoff) return;
      const bucket = Math.floor(observedAt / 300000) * 300000;
      const previous = byBucket.get(bucket);
      const previousVelocity = Number(previous?.comment_velocity);
      const nextVelocity = Number(row?.comment_velocity);
      const commentVelocity = Number.isFinite(previousVelocity) || Number.isFinite(nextVelocity)
        ? Math.max(Number.isFinite(previousVelocity) ? previousVelocity : 0, Number.isFinite(nextVelocity) ? nextVelocity : 0)
        : null;
      if (!previous || observedAt >= Number(previous.observed_at)) {
        byBucket.set(bucket, { ...row, comment_velocity: commentVelocity });
      } else if (commentVelocity !== previous.comment_velocity) {
        byBucket.set(bucket, { ...previous, comment_velocity: commentVelocity });
      }
    };

    if (delta) lastHistoryRows.forEach(mergeRow);
    (Array.isArray(rows) ? rows : []).forEach(mergeRow);
    return [...byBucket.values()].sort((a, b) => Number(a.observed_at) - Number(b.observed_at));
  }

  function syncPlaybackActivity(playing) {
    const active = Boolean(playing);
    if (playbackActive === active) return;
    playbackActive = active;
    if (!nowPlayingState) return;

    if (!active) {
      updateNowPlayingProgress();
      if (nowPlayingState) {
        const now = Date.now();
        const elapsed = Math.max(0, now - nowPlayingState.renderedAt);
        const current = Math.max(0, nowPlayingState.baseProgressMs + elapsed);
        nowPlayingState.baseProgressMs = Math.min(nowPlayingState.durationMs || Infinity, current);
        nowPlayingState.renderedAt = now;
        updateNowPlayingProgress();
      }
      stopNowPlayingTimer();
      return;
    }

    nowPlayingState.renderedAt = Date.now();
    updateNowPlayingProgress();
    if (!nowPlayingTimer && nowPlayingState) nowPlayingTimer = setInterval(updateNowPlayingProgress, 1000);
  }

  renderOnlineRange = function renderOnlineRangeOptimized(rows = lastHistoryRows) {
    const target = el('onlineRange24h');
    if (!target) return;
    const cutoff = Date.now() - 86400000;
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const row of Array.isArray(rows) ? rows : []) {
      if (Number(row?.observed_at) < cutoff) continue;
      const value = Number(row?.online_member_count);
      if (!Number.isFinite(value)) continue;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    target.innerHTML = Number.isFinite(minimum)
      ? `<span>24時間最低 ${minimum.toLocaleString('ja-JP')}</span><span>24時間最高 ${maximum.toLocaleString('ja-JP')}</span>`
      : '<span>24時間最低 -</span><span>24時間最高 -</span>';
  };

  drawChart = function drawChartWithoutDiscardingHistory(rows = lastHistoryRows, selectionIndex = selectedMainChartIndex) {
    const fullRows = Array.isArray(rows) ? rows : [];
    baseDrawChart(fullRows, selectionIndex);
    lastHistoryRows = fullRows;
  };

  refresh = async function refreshDashboardDelta() {
    if (refreshInFlight || document.hidden) return;
    refreshInFlight = true;
    refreshAbortController?.abort();
    refreshAbortController = new AbortController();

    try {
      if (!lastDashboardObservedAt && lastHistoryRows.length) {
        lastDashboardObservedAt = Math.max(...lastHistoryRows.map((row) => Number(row?.observed_at) || 0));
      }
      const params = new URLSearchParams();
      if (lastDashboardObservedAt) params.set('since', String(lastDashboardObservedAt));
      if (lastDashboardObservedAt && lastQueueRevision) params.set('queue_revision', lastQueueRevision);
      const dashboardUrl = params.size ? `/api/dashboard?${params}` : '/api/dashboard';
      const response = await fetch(dashboardUrl, {
        signal: refreshAbortController.signal,
        headers: { accept: 'application/json' },
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

      const responseRevision = String(data.queue_revision || '');
      const queueUnchanged = Boolean(
        data.queue_unchanged && lastQueueRevision && responseRevision === lastQueueRevision,
      );
      if (responseRevision) lastQueueRevision = responseRevision;
      const playing = data.queue_status?.playing
        ?? (latest.is_broadcasting !== 0 && latest.is_broadcasting !== false && !data.queue_status?.is_paused);

      if (queueUnchanged) {
        syncPlaybackActivity(playing);
      } else {
        const queue = Array.isArray(data.queue) ? data.queue : [];
        const foundCurrentIndex = queue.findIndex((track) => track.is_current);
        const currentIndex = foundCurrentIndex >= 0 ? foundCurrentIndex : (queue.length ? 0 : -1);
        const current = currentIndex >= 0 ? queue[currentIndex] : null;
        const generatedAt = Number(data.generated_at);
        const responseAgeMs = Number.isFinite(generatedAt) ? Math.max(0, Date.now() - generatedAt) : 0;
        renderNow(current, queue, currentIndex, { handle: latest.host_handle, image: latest.host_image }, {
          anchor_at: data.queue_status?.anchor_at,
          response_age_ms: responseAgeMs,
          playing,
        });
        playbackActive = Boolean(playing);
      }

      const latestObservedAt = Number(data.latest_observed_at);
      if (Number.isFinite(latestObservedAt) && latestObservedAt > 0) lastDashboardObservedAt = latestObservedAt;
      const history = mergeDashboardHistory(data.history, Boolean(data.delta));
      renderOnlineRange(history);
      if (history.length) {
        const tail = history.at(-1);
        const signature = `${history.length}:${history[0]?.observed_at}:${tail?.observed_at}:${tail?.online_member_count}:${tail?.current_stream_count}:${tail?.comment_velocity}`;
        if (signature !== lastRenderSignature) {
          lastRenderSignature = signature;
          selectedMainChartIndex = null;
          lastHistoryRows = history;
          requestAnimationFrame(() => drawChart(history));
        }
      }
    } catch (error) {
      if (error?.name !== 'AbortError') console.error(error);
    } finally {
      refreshInFlight = false;
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      refreshAbortController?.abort();
      stopNowPlayingTimer();
    } else {
      if (hiddenAt && Date.now() - hiddenAt > 2 * 60 * 60 * 1000) {
        lastDashboardObservedAt = 0;
        lastQueueRevision = '';
      }
      hiddenAt = 0;
      if (playbackActive && nowPlayingState) {
        updateNowPlayingProgress();
        if (!nowPlayingTimer && nowPlayingState) nowPlayingTimer = setInterval(updateNowPlayingProgress, 1000);
      }
    }
  }, true);
})();
