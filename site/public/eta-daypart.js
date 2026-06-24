(() => {
  const target = document.getElementById('goalEta');
  if (!target) return;

  const simplify = () => {
    const text = target.textContent.trim();
    const match = text.match(/^(\d{1,2})月(\d{1,2})日\(([^)]+)\)\s+(\d{1,2}):\d{2}$/);
    if (!match) return;
    const [, month, date, weekday, hour] = match;
    target.textContent = `${Number(month)}月${Number(date)}日(${weekday}) ${Number(hour)}時ごろ`;
  };

  new MutationObserver(simplify).observe(target, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  simplify();
})();
