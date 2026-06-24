(() => {
  const baseRefresh = refresh;
  const MIN_REFRESH_MS = 110 * 1000;
  let lastRequestAt = Date.now();
  let failures = 0;
  let backoffUntil = 0;

  async function optimizedRefresh() {
    const now = Date.now();
    if (refreshInFlight || now < backoffUntil || now - lastRequestAt < MIN_REFRESH_MS) return;
    lastRequestAt = now;
    refreshInFlight = true;
    refreshAbortController?.abort();
    refreshAbortController = new AbortController();

    try {
      // 全閲覧者で同一URLを使い、Cloudflareのエッジキャッシュを共有する。
      const response = await fetch('/api/dashboard', {
        signal: refreshAbortController.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'API error');
      failures = 0;
      backoffUntil = 0;

      const latest = data.latest || {};
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
        failures += 1;
        const delay = Math.min(15 * 60 * 1000, 60 * 1000 * (2 ** Math.min(failures, 4)));
        backoffUntil = Date.now() + delay;
        console.error(error);
        if (!lastHistoryRows.length && failures === 1) return baseRefresh();
      }
    } finally {
      refreshInFlight = false;
    }
  }

  refresh = optimizedRefresh;
})();
