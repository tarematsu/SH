(() => {
  const baseDrawChart = drawChart;
  const historyBuckets = new Map();
  let lastDashboardObservedAt = 0;
  let lastQueueRevision = '';
  let hiddenAt = 0;
  let playbackActive = null;

  function setText(target, value) {
    if (!target) return false;
    const text = String(value ?? '');
    if (target.textContent === text) return false;
    target.textContent = text;
    return true;
  }

  function setStyle(target, property, value) {
    if (!target || target.style[property] === value) return false;
    target.style[property] = value;
    return true;
  }

  function latestObservedAt(rows) {
    let latest = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      const value = Number(row?.observed_at);
      if (Number.isFinite(value) && value > latest) latest = value;
    }
    return latest;
  }

  function mergeHistoryBucket(row, cutoff) {
    const observedAt = Number(row?.observed_at);
    if (!Number.isFinite(observedAt) || observedAt < cutoff) return false;
    const bucket = Math.floor(observedAt / 300000) * 300000;
    const previous = historyBuckets.get(bucket);
    const previousVelocity = Number(previous?.comment_velocity);
    const nextVelocity = Number(row?.comment_velocity);
    const commentVelocity = Number.isFinite(previousVelocity) || Number.isFinite(nextVelocity)
      ? Math.max(Number.isFinite(previousVelocity) ? previousVelocity : 0, Number.isFinite(nextVelocity) ? nextVelocity : 0)
      : null;
    if (!previous || observedAt >= Number(previous.observed_at)) {
      historyBuckets.set(bucket, { ...row, comment_velocity: commentVelocity });
      return true;
    }
    if (commentVelocity !== previous.comment_velocity) {
      historyBuckets.set(bucket, { ...previous, comment_velocity: commentVelocity });
      return true;
    }
    return false;
  }

  function seedHistoryBuckets(rows, cutoff = Date.now() - 86400000) {
    historyBuckets.clear();
    for (const row of Array.isArray(rows) ? rows : []) mergeHistoryBucket(row, cutoff);
  }

  function mergeDashboardHistory(rows, delta) {
    const cutoff = Date.now() - 86400000;
    const incoming = Array.isArray(rows) ? rows : [];
    let changed = false;

    if (!delta || !historyBuckets.size) {
      historyBuckets.clear();
      if (delta) {
        for (const row of lastHistoryRows) changed = mergeHistoryBucket(row, cutoff) || changed;
      }
      for (const row of incoming) changed = mergeHistoryBucket(row, cutoff) || changed;
      changed = true;
    } else {
      for (const row of incoming) changed = mergeHistoryBucket(row, cutoff) || changed;
    }

    const cutoffBucket = Math.floor(cutoff / 300000) * 300000;
    for (const bucket of historyBuckets.keys()) {
      if (bucket >= cutoffBucket) continue;
      historyBuckets.delete(bucket);
      changed = true;
    }

    if (!changed) return { rows: lastHistoryRows, changed: false };
    return {
      rows: [...historyBuckets.values()].sort((a, b) => Number(a.observed_at) - Number(b.observed_at)),
      changed: true,
    };
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
    const html = Number.isFinite(minimum)
      ? `<span>24時間最低 ${minimum.toLocaleString('ja-JP')}</span><span>24時間最高 ${maximum.toLocaleString('ja-JP')}</span>`
      : '<span>24時間最低 -</span><span>24時間最高 -</span>';
    if (target.innerHTML !== html) target.innerHTML = html;
  };

  drawChart = function drawChartWithoutDiscardingHistory(rows = lastHistoryRows, selectionIndex = selectedMainChartIndex) {
    const fullRows = Array.isArray(rows) ? rows : [];
    if (!historyBuckets.size && fullRows.length) seedHistoryBuckets(fullRows);
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
        lastDashboardObservedAt = latestObservedAt(lastHistoryRows);
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

      setText(el('channelName'), latest.channel_name || 'Buddies');
      setText(el('description'), latest.description || latest.artist_name || '');
      setImage(el('channelImage'), latest.channel_image || latest.logo_image);
      if (latest.accent_color && document.documentElement.style.getPropertyValue('--accent') !== latest.accent_color) {
        document.documentElement.style.setProperty('--accent', latest.accent_color);
      }

      setText(el('online'), number(latest.online_member_count));
      setText(el('members'), number(latest.total_member_count));
      setText(el('totalListens'), number(latest.total_listens));
      renderDailyDelta('membersDelta', data.daily_change?.total_member_count);
      renderDailyDelta('listensDelta', data.daily_change?.total_listens);
      setText(el('updated'), `最終取得 ${dateTime(latest.observed_at)}`);

      const count = Number(latest.current_stream_count) || 0;
      const goal = Number(latest.stream_goal) || 0;
      const pct = goal ? Math.min(100, count / goal * 100) : 0;
      setText(el('streamCount'), number(count));
      setText(el('streamGoal'), number(goal));
      setStyle(el('goalBar'), 'width', `${pct}%`);
      setText(el('goalPercent'), `${pct.toFixed(2)}%`);
      setText(el('goalRemaining'), goal ? `残り ${number(Math.max(0, goal - count))}` : '-');
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

      const latestObserved = Number(data.latest_observed_at);
      if (Number.isFinite(latestObserved) && latestObserved > 0) lastDashboardObservedAt = latestObserved;
      const historyState = mergeDashboardHistory(data.history, Boolean(data.delta));
      if (historyState.changed) {
        const history = historyState.rows;
        lastHistoryRows = history;
        renderOnlineRange(history);
        if (history.length) {
          const tail = history.at(-1);
          const signature = [
            history.length,
            history[0]?.observed_at,
            tail?.listener_count,
            tail?.online_member_count,
            tail?.total_member_count,
            tail?.total_listens,
            tail?.current_stream_count,
            tail?.comment_velocity,
          ].join(':');
          if (signature !== lastRenderSignature) {
            lastRenderSignature = signature;
            selectedMainChartIndex = null;
            requestAnimationFrame(() => drawChart(history));
          }
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
