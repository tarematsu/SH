const VALID_MODES = new Set(['daily', 'weekly', 'ranking', 'monthly', 'tracks', 'broadcasts']);
const requestedMode = location.hash.slice(1);

if (!VALID_MODES.has(requestedMode)) {
  history.replaceState(null, '', '#weekly');
}

const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const trackDate = document.getElementById('trackDate');
const trackWeekMode = document.getElementById('trackWeekMode');
if (trackDate && !trackDate.value) trackDate.value = yesterday;
if (trackWeekMode) trackWeekMode.checked = false;

await import('/history/history-page-fixes.js');
await import('/history/history-lite.js');
