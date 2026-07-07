(() => {
  const seenSources = new Set();

  function normalizeUrl(value) {
    try {
      return value ? new URL(value, location.href).href : '';
    } catch {
      return '';
    }
  }

  function tuneImage(img) {
    if (!img || img.dataset.playbackImageOptimized === '1') return;
    img.dataset.playbackImageOptimized = '1';
    img.decoding = 'async';

    const isCover = img.classList.contains('cover');
    if (!isCover) img.loading = 'lazy';
    else img.loading = 'eager';

    const src = normalizeUrl(img.getAttribute('src'));
    if (!src) return;

    if (seenSources.has(src) && !isCover) {
      img.classList.add('reused-thumbnail');
    } else {
      seenSources.add(src);
    }
  }

  function tuneTree(root = document) {
    root.querySelectorAll?.('.now-playing img, .queue-list img, .channel-image').forEach(tuneImage);
  }

  tuneTree();

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches?.('.now-playing img, .queue-list img, .channel-image')) tuneImage(node);
        tuneTree(node);
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
