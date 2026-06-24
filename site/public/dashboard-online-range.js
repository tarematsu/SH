(() => {
  const target = document.getElementById('onlineRange24h');
  if (!target) return;

  let lastText = '';

  function render() {
    const cutoff = Date.now() - 86400000;
    const rows = Array.isArray(lastHistoryRows) ? lastHistoryRows : [];
    let minimum = Infinity;
    let maximum = -Infinity;

    for (const row of rows) {
      if (Number(row?.observed_at) < cutoff) continue;
      const value = Number(row?.online_member_count);
      if (!Number.isFinite(value)) continue;
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    }

    const next = Number.isFinite(minimum)
      ? `<span>24時間最低 ${minimum.toLocaleString('ja-JP')}</span><span>24時間最高 ${maximum.toLocaleString('ja-JP')}</span>`
      : '<span>24時間最低 -</span><span>24時間最高 -</span>';

    if (next !== lastText) {
      lastText = next;
      target.innerHTML = next;
    }
  }

  render();
  setTimeout(render, 1200);
  setInterval(() => {
    if (!document.hidden) render();
  }, 60000);
})();
