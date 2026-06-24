(() => {
  const target = document.getElementById('goalEta');
  if (!target) return;

  const daypart = (hour) => {
    if (hour < 5) return '深夜';
    if (hour < 10) return '朝方';
    if (hour < 15) return 'お昼ごろ';
    if (hour < 19) return '夕方';
    if (hour < 23) return '夜';
    return '深夜';
  };

  const simplify = () => {
    const text = target.textContent.trim();
    const match = text.match(/^(\d{1,2})月(\d{1,2})日\(([^)]+)\)\s+(\d{1,2}):\d{2}$/);
    if (!match) return;
    const [, month, date, weekday, hour] = match;
    target.textContent = `${Number(month)}月${Number(date)}日(${weekday}) ${daypart(Number(hour))}`;
  };

  new MutationObserver(simplify).observe(target, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  simplify();
})();
