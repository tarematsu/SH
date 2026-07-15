const integer = new Intl.NumberFormat('ja-JP');
const nativeFetch = window.fetch.bind(window);

function renderBites(payload) {
  const node = document.getElementById('trackBites');
  if (!node) return;
  const queue = Array.isArray(payload?.queue) ? payload.queue : [];
  const statusIndex = Number(payload?.queue_status?.current_index);
  const current = queue.find((track) => track?.is_current)
    || (Number.isInteger(statusIndex) && statusIndex >= 0 ? queue[statusIndex] : null);
  const count = Number(current?.bite_count);
  if (!Number.isFinite(count)) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.textContent = `♡ ${integer.format(count)}`;
  node.hidden = false;
}

window.fetch = async (input, init) => {
  const response = await nativeFetch(input, init);
  const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
  if (!rawUrl) return response;
  let url;
  try { url = new URL(rawUrl, location.href); } catch { return response; }
  if (url.origin !== location.origin || url.pathname !== '/api/dashboard' || !response.ok) return response;
  try {
    const payload = await response.clone().json();
    if (payload?.ok) renderBites(payload);
  } catch {
    // The dashboard client owns request error handling.
  }
  return response;
};
