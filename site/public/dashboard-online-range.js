(() => {
  const target = document.getElementById('onlineRange24h');
  if (!target) return;

  function render() {
    const cutoff = Date.now() - 86400000;
    const values = (Array.isArray(lastHistoryRows) ? lastHistoryRows : [])
      .filter((row) => Number(row && row.observed_at) >= cutoff)
      .map((row) => Number(row && row.online_member_count))
      .filter((value) => Number.isFinite(value));

    if (!values.length) {
      target.hidden = true;
      target.textContent = '';
      return;
    }

    const minimum = Math.min(...values).toLocaleString('ja-JP');
    const maximum = Math.max(...values).toLocaleString('ja-JP');
    target.textContent = `24時間 最低 ${minimum} / 最高 ${maximum}`;
    target.hidden = false;
  }

  render();
  setInterval(render, 30000);
})();
