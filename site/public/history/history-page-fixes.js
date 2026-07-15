const originalBeginPath = CanvasRenderingContext2D.prototype.beginPath;
const originalMoveTo = CanvasRenderingContext2D.prototype.moveTo;
const originalLineTo = CanvasRenderingContext2D.prototype.lineTo;
const originalStroke = CanvasRenderingContext2D.prototype.stroke;
const pathState = new WeakMap();

CanvasRenderingContext2D.prototype.beginPath = function beginPathWithDailyPoints() {
  pathState.set(this, { moves: [], lines: 0 });
  return originalBeginPath.call(this);
};

CanvasRenderingContext2D.prototype.moveTo = function moveToWithDailyPoints(x, y) {
  const state = pathState.get(this);
  if (state) state.moves.push([x, y]);
  return originalMoveTo.call(this, x, y);
};

CanvasRenderingContext2D.prototype.lineTo = function lineToWithDailyPoints(x, y) {
  const state = pathState.get(this);
  if (state) state.lines += 1;
  return originalLineTo.call(this, x, y);
};

CanvasRenderingContext2D.prototype.stroke = function strokeWithDailyPoints(...args) {
  const result = originalStroke.apply(this, args);
  const canvas = this.canvas;
  const state = pathState.get(this);
  if (canvas?.id !== 'chart' || location.hash !== '#daily' || !state?.moves.length || state.lines > 0) return result;
  this.save();
  this.globalAlpha = Math.max(.65, this.globalAlpha || 1);
  this.fillStyle = this.strokeStyle;
  for (const [x, y] of state.moves) {
    originalBeginPath.call(this);
    this.arc(x, y, 3, 0, Math.PI * 2);
    this.fill();
  }
  this.restore();
  return result;
};

function numberFromCell(cell) {
  const text = String(cell?.textContent || '').replace(/[^0-9.-]/g, '');
  if (!text) return -1;
  const value = Number(text);
  return Number.isFinite(value) ? value : -1;
}

let applyingTrackRanking = false;

function rankTrackTable() {
  if (location.hash !== '#tracks' || applyingTrackRanking) return;
  const head = document.querySelector('#thead tr');
  const body = document.getElementById('tbody');
  if (!head || !body || body.dataset.ranked === '1') return;
  const labels = [...head.cells].map((cell) => cell.textContent.trim());
  const likeIndex = labels.indexOf('いいね数');
  const playIndex = labels.indexOf('再生回数');
  if (likeIndex < 0 || playIndex < 0) return;

  const rows = [...body.rows].filter((row) => !row.classList.contains('daily-total-row'));
  rows.sort((left, right) => {
    const likes = numberFromCell(right.cells[likeIndex]) - numberFromCell(left.cells[likeIndex]);
    if (likes) return likes;
    const plays = numberFromCell(right.cells[playIndex]) - numberFromCell(left.cells[playIndex]);
    if (plays) return plays;
    return String(left.cells[1]?.textContent || '').localeCompare(String(right.cells[1]?.textContent || ''), 'ja');
  });

  applyingTrackRanking = true;
  const rankHead = document.createElement('th');
  rankHead.scope = 'col';
  rankHead.textContent = '順位';
  head.prepend(rankHead);
  rows.forEach((row, index) => {
    const cell = document.createElement('td');
    cell.className = 'track-rank';
    cell.textContent = `${index + 1}位`;
    row.prepend(cell);
  });
  body.replaceChildren(...rows);
  body.dataset.ranked = '1';
  const title = document.getElementById('tableTitle');
  if (title) title.textContent = '再生曲 いいね数ランキング';
  applyingTrackRanking = false;
}

const observer = new MutationObserver((records) => {
  const body = document.getElementById('tbody');
  if (!body || applyingTrackRanking) return;
  if (records.some((record) => record.target === body)) delete body.dataset.ranked;
  if (location.hash !== '#tracks') delete body.dataset.ranked;
  queueMicrotask(rankTrackTable);
});
observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('hashchange', () => queueMicrotask(rankTrackTable));
