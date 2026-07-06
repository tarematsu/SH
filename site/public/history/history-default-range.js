(() => {
  const defaultFrom = '2024-05-01';
  const fromInput = document.getElementById('from');
  if (fromInput && (!fromInput.value || fromInput.value === '2024-06-01')) {
    fromInput.value = defaultFrom;
  }

  const allButton = document.querySelector('.range-presets button[data-days="all"]');
  if (!allButton) return;

  allButton.onclick = () => {
    document.getElementById('to').value = new Date().toISOString().slice(0, 10);
    document.getElementById('from').value = defaultFrom;
    document.querySelectorAll('.range-presets button').forEach((button) => {
      button.classList.toggle('active', button.dataset.days === 'all');
    });
    nextCursor = null;
    load();
  };
})();
