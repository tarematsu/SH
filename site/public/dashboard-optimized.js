(() => {
  const baseDrawChart = drawChart;
  const dom = window.DashboardDom;
  const historyCache = window.DashboardHistoryCache;
  let lastDashboardObservedAt = 0;
  let lastQueueRevision = '';
  let hiddenAt = 0;
  let playbackActive = null;

  function hasLocalQueue() {
    return Array.isArray(playbackQueue) && playbackQueue.length > 0;
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

  drawChart = function drawChartWithoutDiscardingHistory(rows = lastHistoryRows, selectionIndex = selectedMainChartIndex) {
    const fullRows = Array.isArray(rows) ? rows : [];
    if (!historyCache.hasRows() && fullRows.length) historyCache.seed(fullRows);
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
        lastDashboardObservedAt = dom.latestObservedAt(lastHistoryRows);
      }
      const params = new URLSearchParams();
      if (lastDashboardObservedAt) params.set('since', String(lastDashboardObservedAt));
      if (lastDashboardObservedAt && lastQueueRevision && hasLocalQueue()) params.set('queue_revision', lastQueueRevision);
      const dashboardUrl = params.size ? `/api/dashboard?${params}` : '/api/dashboard';
      const response = await fetch(dashboardUrl, {
        signal: refreshAbortController.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'API error');
      const latest = data.latest || {};

      dom.setText(el('channelName'), latest.channel_name || 'Buddies');
      dom.setText(el('description'), latest.description || latest.artist_name || '');
      dom.setImageIfChanged(el('channelImage'), latest.channel_image || latest.logo_image);
      if (latest.accent_color && document.documentElement.style.getPropertyValue('--accent') !== latest.accent_color) {
        document.documentElement.style.setProperty('--accent', latest.accent_color);
      }

      dom.setText(el('online'), dom.formatNumber(latest.online_member_count));
      dom.setText(el('members'), dom.formatNumber(latest.total_member_count));
      dom.setText(el('totalListens'), dom.formatNumber(latest.total_listens));
      dom.renderDailyDeltaIfChanged('membersDelta', data.daily_change?.total_member_count);
      dom.renderDailyDeltaIfChanged('listensDelta', data.daily_change?.total_listens);
      dom.setText(el('updated'), `最終取得 ${dom.formatDateTime(latest.observed_at)}`);

      const count = Number(latest.current_stream_count) || 0;
      const goal = Number(latest.stream_goal) || 0;
      const pct = goal ? Math.min(100, count / goal * 100) : 0;
      dom.setText(el('streamCount'), dom.formatNumber(count));
      dom.setText(el('streamGoal'), dom.formatNumber(goal));
      dom.setStyle(el('goalBar'), 'width', `${pct}%`);
      dom.setText(el('goalPercent'), `${pct.toFixed(2)}%`);
      dom.setText(el('goalRemaining'), goal ? `残り ${dom.formatNumber(Math.max(0, goal - count))}` : '-');
      renderPrediction(data.goal_prediction, count, goal);

      const responseRevision = String(data.queue_revision || '');
      const queueUnchanged = Boolean(
        data.queue_unchanged && lastQueueRevision && responseRevision === lastQueueRevision && hasLocalQueue(),
      );
      if (responseRevision && (hasLocalQueue() || !data.queue_unchanged)) lastQueueRevision = responseRevision;
      if (!hasLocalQueue()) lastQueueRevision = '';
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
        if (queue.length && responseRevision) lastQueueRevision = responseRevision;
        playbackActive = Boolean(playing);
      }

      const latestObserved = Number(data.latest_observed_at);
      if (Number.isFinite(latestObserved) && latestObserved > 0) lastDashboardObservedAt = latestObserved;
      const historyState = historyCache.merge(data.history, Boolean(data.delta), lastHistoryRows);
      if (historyState.changed) {
        const history = historyState.rows;
        lastHistoryRows = history;
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
