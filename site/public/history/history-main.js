const VALID_MODES = new Set(['daily', 'weekly', 'ranking', 'monthly', 'tracks', 'broadcasts']);
const requestedMode = location.hash.slice(1);

if (!VALID_MODES.has(requestedMode)) {
  history.replaceState(null, '', '#weekly');
}

await import('/history/history-lite.js');
