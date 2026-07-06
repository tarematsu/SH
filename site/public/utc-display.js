(() => {
  const forceUtc = (options) => ({ ...(options || {}), timeZone: 'UTC' });
  const nativeDateTimeFormat = Intl.DateTimeFormat;

  function UtcDateTimeFormat(locales, options) {
    return new nativeDateTimeFormat(locales, forceUtc(options));
  }
  Object.setPrototypeOf(UtcDateTimeFormat, nativeDateTimeFormat);
  UtcDateTimeFormat.prototype = nativeDateTimeFormat.prototype;
  Intl.DateTimeFormat = UtcDateTimeFormat;

  for (const method of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
    const native = Date.prototype[method];
    Date.prototype[method] = function utcLocaleDate(locales, options) {
      return native.call(this, locales, forceUtc(options));
    };
  }

  document.documentElement.dataset.timezone = 'UTC';
})();
