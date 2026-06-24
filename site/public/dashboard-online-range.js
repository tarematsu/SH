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
    target.innerHTML = `<span>24時間最低 ${minimum}</span><span>24時間最高 ${maximum}</span>`;
    target.hidden = false;
  }

  render();
  setTimeout(render, 1000);
  setTimeout(render, 3000);
  setInterval(render, 30000);
})();
