let dashboardHistoryRequested = false;

function renderHistory(history) {
  if (!Array.isArray(history) || !history.length) return;
  const signature = `${history.length}:${history[0]?.observed_at}:${history.at(-1)?.observed_at}:${history.at(-1)?.online_member_count}:${history.at(-1)?.current_stream_count}`;
  if (signature === lastRenderSignature) return;
  lastRenderSignature = signature;
  selectedMainChartIndex = null;
  lastHistoryRows = history;
  requestAnimationFrame(() => drawChart(history));
}

async function loadDashboardHistory() {
  if (dashboardHistoryRequested) return;
  dashboardHistoryRequested = true;
  try {
    const response = await fetch('/api/dashboard-history', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`history API error: ${response.status}`);
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'history API error');
    renderHistory(data.history);
  } catch (error) {
    console.error(error);
    dashboardHistoryRequested = false;
  }
}

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  refreshAbortController?.abort();
  refreshAbortController = new AbortController();

  try {
    const response = await fetch('/api/dashboard?history=0', {
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

    const countValue = Number(latest.current_stream_count);
    const count = Number.isFinite(countValue) ? countValue : null;
    const goal = Number(latest.stream_goal) || 0;
    const pct = goal && count != null ? Math.min(100, count / goal * 100) : 0;
    el('streamCount').textContent = number(count);
    el('streamGoal').textContent = number(goal);
    el('goalBar').style.width = `${pct}%`;
    el('goalPercent').textContent = `${pct.toFixed(2)}%`;
    el('goalRemaining').textContent = goal && count != null ? `残り ${number(Math.max(0, goal - count))}` : '-';
    renderPrediction(data.goal_prediction, count, goal, data.goal_predictions);

    const queue = Array.isArray(data.queue) ? data.queue : [];
    const foundCurrentIndex = queue.findIndex(t => t.is_current);
    const currentIndex = foundCurrentIndex >= 0 ? foundCurrentIndex : (queue.length ? 0 : -1);
    const current = currentIndex >= 0 ? queue[currentIndex] : null;
    const generatedAt = Number(data.generated_at);
    const responseAgeMs = Number.isFinite(generatedAt) ? Math.max(0, Date.now() - generatedAt) : 0;
    const playing = data.queue_status?.playing ?? (latest.is_broadcasting !== 0 && latest.is_broadcasting !== false && !data.queue_status?.is_paused);
    renderNow(current, queue, currentIndex, { handle: latest.host_handle, image: latest.host_image }, {
      anchor_at: data.queue_status?.anchor_at,
      response_age_ms: responseAgeMs,
      playing,
      total_items: data.queue_status?.total_items,
    });

    renderHistory(data.history);
    if (data.history_deferred || !lastHistoryRows.length) loadDashboardHistory();
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error(error);
      const description = el('description');
      if (description && description.textContent === '読み込み中...') {
        description.textContent = 'データ取得に失敗しました。次回更新で再試行します。';
      }
    }
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
