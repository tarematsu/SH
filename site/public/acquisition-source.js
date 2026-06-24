(() => {
  const updated = document.getElementById('updated');
  if (!updated) return;

  let source = '';

  const render = () => {
    const base = updated.textContent.replace(/\s+\((?:Cloud|Local)\)$/, '');
    updated.textContent = source ? `${base} (${source})` : base;
  };

  const observer = new MutationObserver(render);
  observer.observe(updated, { childList: true, characterData: true, subtree: true });

  async function refreshSource() {
    try {
      const response = await fetch('/api/acquisition-source', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      if (!data.ok || !['Cloud', 'Local'].includes(data.source)) return;
      source = data.source;
      render();
    } catch {}
  }

  refreshSource();
  setInterval(refreshSource, 30_000);
})();
