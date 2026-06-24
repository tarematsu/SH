(() => {
  let since = 0;
  const baseRefresh = refresh;

  async function optimizedRefresh() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    refreshAbortController?.abort();
    refreshAbortController = new AbortController();

    try {
      const url = since > 0 ? `/api/dashboard?since=${encodeURIComponent(since)}` : '/api/dashboard';
      const response = await fetch(url, {
        cache: 'no-store',
        signal: refreshAbortController.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'API error');
      const latest = data.latest || {};
      since = Math.max(since, Number(data.latest_observed_at) || Number(latest.observed_at) || 0);

      el('channelName').textContent = latest.channel_name || 'Buddies';
      el('description').textContent = latest.description || latest.artist_name || '';
      setImage(el('channelImage'), latest.channel_image || latest.logo_image);
      setImage(el('hostImage'), latest.host_image);
      if (latest.accent_color) document.documentElement.style.setProperty('--accent', latest.accent_color);
      el('online').textContent = number(latest.online_member_count);
      el('members').textContent = number(latest.total_member_count);
      el('totalListens').textContent = number(latest.total_listens);
      renderDailyDelta('membersDelta', data.daily_change?.total_member_count);
      renderDailyDelta('listensDelta', data.daily_change?.total_listens);
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
      const foundCurrentIndex = queue.findIndex((track) => track.is_current);
      const currentIndex = foundCurrentIndex >= 0 ? foundCurrentIndex : (queue.length ? 0 : -1);
      renderNow(currentIndex >= 0 ? queue[currentIndex] : null, queue, currentIndex);

      const incoming = Array.isArray(data.history) ? data.history : [];
      const merged = data.delta
        ? [...lastHistoryRows, ...incoming]
        : incoming;
      const historyMap = new Map();
      merged.forEach((row) => historyMap.set(Number(row.observed_at), row));
      const history = [...historyMap.values()]
        .sort((a, b) => Number(a.observed_at) - Number(b.observed_at))
        .slice(-1500);

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
        if (!since) return baseRefresh();
      }
    } finally {
      refreshInFlight = false;
    }
  }

  refresh = optimizedRefresh;
})();
