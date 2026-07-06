(() => {
  const NativeDateTimeFormat = Intl.DateTimeFormat;
  function UtcDateTimeFormat(locales, options = {}) {
    return new NativeDateTimeFormat(locales, { ...options, timeZone: 'UTC' });
  }
  Object.setPrototypeOf(UtcDateTimeFormat, NativeDateTimeFormat);
  UtcDateTimeFormat.prototype = NativeDateTimeFormat.prototype;
  Intl.DateTimeFormat = UtcDateTimeFormat;

  formatDate = function formatDateUtc(value, includeTime = false) {
    if (!value) return '—';
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const [year, month, day] = text.split('-');
      return `${year}/${month}/${day}`;
    }
    const numeric = Number(value);
    const date = Number.isFinite(numeric) && numeric > 100000000000 ? new Date(numeric) : new Date(text);
    if (Number.isNaN(date.getTime())) return text;
    return new Intl.DateTimeFormat('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(includeTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
    }).format(date);
  };

  const utcToday = new Date().toISOString().slice(0, 10);
  const to = document.getElementById('to');
  if (to) to.value = utcToday;
  document.documentElement.dataset.timezone = 'UTC';
})();
