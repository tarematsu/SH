(() => {
  const integerFormatter = new Intl.NumberFormat('ja-JP');
  const dateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  function formatNumber(value) {
    return value == null || !Number.isFinite(Number(value)) ? '-' : integerFormatter.format(Number(value));
  }

  function formatDateTime(value) {
    return value ? dateTimeFormatter.format(new Date(Number(value))) : '-';
  }

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

  function setImageIfChanged(target, src) {
    if (!target) return false;
    target.decoding = 'async';
    target.loading = 'eager';
    const visible = Boolean(src);
    let changed = false;
    if (target.hidden === visible) {
      target.hidden = !visible;
      changed = true;
    }
    if (visible && target.getAttribute('src') !== src) {
      target.src = src;
      changed = true;
    }
    if (!visible && target.hasAttribute('src')) {
      target.removeAttribute('src');
      changed = true;
    }
    return changed;
  }

  function renderDailyDeltaIfChanged(elementId, value) {
    const node = el(elementId);
    if (!node) return;
    const n = Number(value);
    if (!Number.isFinite(n)) {
      setText(node, '');
      if (!node.hidden) node.hidden = true;
      return;
    }
    const sign = n > 0 ? '+' : n < 0 ? '−' : '±';
    setText(node, `前日 ${sign}${formatNumber(Math.abs(n))}`);
    const className = `daily-delta ${n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral'}`;
    if (node.className !== className) node.className = className;
    if (node.hidden) node.hidden = false;
  }

  function latestObservedAt(rows) {
    let latest = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      const value = Number(row?.observed_at);
      if (Number.isFinite(value) && value > latest) latest = value;
    }
    return latest;
  }

  window.DashboardDom = {
    formatNumber,
    formatDateTime,
    setText,
    setStyle,
    setImageIfChanged,
    renderDailyDeltaIfChanged,
    latestObservedAt,
  };
})();
