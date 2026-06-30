(() => {
  if (typeof advanceSimulatedTrack === 'function') {
    const baseAdvanceSimulatedTrack = advanceSimulatedTrack;
    advanceSimulatedTrack = function advanceWithoutRecyclingFinishedQueue(carryMs = 0) {
      const advanced = baseAdvanceSimulatedTrack(carryMs);
      if (!advanced && simulatedCurrentIndex < 0 && playbackQueue.length) {
        playbackQueue = [];
        renderSimulatedQueue();
      }
      return advanced;
    };
  }

  function renderRange(rows) {
    const target = document.getElementById('onlineRange24h');
    if (!target) return;
    const values = rows.map((row) => Number(row?.online_member_count)).filter(Number.isFinite);
    target.innerHTML = values.length
      ? `<span>24時間最低 ${Math.min(...values).toLocaleString('ja-JP')}</span><span>24時間最高 ${Math.max(...values).toLocaleString('ja-JP')}</span>`
      : '<span>24時間最低 -</span><span>24時間最高 -</span>';
  }

  function renderRecoveryStatus(data) {
    const panel = document.querySelector('.chart-panel');
    const head = panel?.querySelector('.section-head');
    if (!panel || !head) return;
    let status = panel.querySelector('.dashboard-recovery-status');
    if (!status) {
      status = document.createElement('p');
      status.className = 'dashboard-recovery-status muted small';
      head.insertAdjacentElement('afterend', status);
    }

    if (!data.stale) {
      status.remove();
      return;
    }

    const observedAt = Number(data.latest_observed_at);
    const date = Number.isFinite(observedAt)
      ? new Date(observedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '不明';
    status.textContent = `現在の収集が停止しています。最後に取得できた24時間を表示中（最終取得 ${date}）`;

    const updated = document.getElementById('updated');
    if (updated && !updated.textContent.includes('取得停止中')) updated.textContent += '・取得停止中';
  }

  async function recoverDashboardHistory() {
    if (Array.isArray(lastHistoryRows) && lastHistoryRows.length) return;
    try {
      const response = await fetch('/api/dashboard-recovery', {
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`dashboard recovery API ${response.status}`);
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'dashboard recovery API error');
      const rows = Array.isArray(data.rows) ? data.rows : [];
      renderRecoveryStatus(data);
      if (!rows.length) return;

      lastHistoryRows = rows;
      selectedMainChartIndex = null;
      renderRange(rows);
      requestAnimationFrame(() => drawChart(rows));
    } catch (error) {
      console.warn(error);
    }
  }

  setTimeout(recoverDashboardHistory, 1500);
})();
