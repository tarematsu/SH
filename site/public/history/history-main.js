const VALID_MODES = new Set(['daily', 'weekly', 'ranking', 'monthly', 'tracks', 'broadcasts']);
const requestedMode = location.hash.slice(1);

if (!VALID_MODES.has(requestedMode)) {
  history.replaceState(null, '', '#weekly');
}

const trackWeekMode = document.getElementById('trackWeekMode');
if (trackWeekMode) trackWeekMode.checked = true;

await import('/history/history-page-fixes.js');
await import('/history/history-lite.js');
