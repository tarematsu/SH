(() => {
  const utcToday = () => new Date().toISOString().slice(0, 10);

  formatDate = function formatDateUtc(value, includeTime = false) {
    if (!value) return '—';
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const [year, month, day] = text.split('-');
      return `${year}/${month}/${day}`;
    }
    const numeric = Number(value);
    const date = Number.isFinite(numeric) && numeric > 100000000000
      ? new Date(numeric)
      : new Date(text);
    if (Number.isNaN(date.getTime())) return text;
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(includeTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
    }).format(date);
  };

  shortDate = function shortDateUtc(value, showYear = false) {
    if (!value) return '';
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const [year, month, day] = text.split('-').map(Number);
      return showYear ? `${year}/${month}/${day}` : `${month}/${day}`;
    }
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return text.slice(0, 10);
    return showYear
      ? `${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`
      : `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
  };

  applyPreset = function applyPresetUtc(days) {
    const to = new Date();
    document.getElementById('to').value = utcToday();
    if (days === 'all') document.getElementById('from').value = '2024-06-01';
    else {
      const from = new Date(to.getTime() - Number(days) * 86400000);
      document.getElementById('from').value = from.toISOString().slice(0, 10);
    }
    document.querySelectorAll('.range-presets button').forEach((button) => {
      button.classList.toggle('active', button.dataset.days === String(days));
    });
  };

  const to = document.getElementById('to');
  if (to) to.value = utcToday();

  const csv = document.getElementById('csv');
  if (csv) {
    csv.onclick = () => {
      const keys = visibleKeys(currentMode);
      const labels = labelsFor(currentMode);
      const lines = [
        keys.map((key) => labels[key] || key),
        ...current.map((row) => keys.map((key) => row[key] ?? '')),
      ].map((line) => line.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','));
      const blob = new Blob([`\ufeff${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `stationhead-${currentMode}-${utcToday()}-UTC.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    };
  }
})();
