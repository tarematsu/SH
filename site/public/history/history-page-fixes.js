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

function metric(label, value) {
  const box = document.createElement('span');
  box.append(document.createTextNode(label));
  const strong = document.createElement('b');
  strong.textContent = value;
  box.appendChild(strong);
  return box;
}

let applyingTrackRanking = false;
let trackRankingRenderQueued = false;

function renderTrackRanking() {
  const panel = document.querySelector('.data-panel');
  const tableWrap = panel?.querySelector('.table-wrap');
  const head = document.querySelector('#thead tr');
  const body = document.getElementById('tbody');
  let list = document.getElementById('trackRankingList');

  if (location.hash !== '#tracks') {
    if (tableWrap) tableWrap.hidden = false;
    if (list) list.hidden = true;
    return;
  }
  if (!panel || !tableWrap || !head || !body || applyingTrackRanking) return;

  const labels = [...head.cells].map((cell) => cell.textContent.trim());
  const titleIndex = labels.indexOf('曲名');
  const artistIndex = labels.indexOf('アーティスト');
  const playIndex = labels.indexOf('再生回数');
  const likeIndex = labels.indexOf('いいね数');
  if ([titleIndex, artistIndex, playIndex, likeIndex].some((index) => index < 0)) return;

  const rows = [...body.rows]
    .filter((row) => !row.classList.contains('daily-total-row') && !row.classList.contains('empty-row'))
    .sort((left, right) => {
      const plays = numberFromCell(right.cells[playIndex]) - numberFromCell(left.cells[playIndex]);
      if (plays) return plays;
      const likes = numberFromCell(right.cells[likeIndex]) - numberFromCell(left.cells[likeIndex]);
      if (likes) return likes;
      return String(left.cells[titleIndex]?.textContent || '').localeCompare(String(right.cells[titleIndex]?.textContent || ''), 'ja');
    });

  applyingTrackRanking = true;
  try {
    if (!list) {
      list = document.createElement('ol');
      list.id = 'trackRankingList';
      list.className = 'like-ranking';
      tableWrap.before(list);
    }
    list.replaceChildren();
    list.hidden = false;
    tableWrap.hidden = true;

    if (!rows.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-ranking';
      empty.textContent = 'この日の再生曲データがありません。';
      list.appendChild(empty);
    } else {
      const fragment = document.createDocumentFragment();
      rows.forEach((row, index) => {
        const item = document.createElement('li');
        item.className = 'like-rank-item';

        const rank = document.createElement('strong');
        rank.className = 'like-rank-number';
        rank.textContent = String(index + 1);

        const content = document.createElement('div');
        content.className = 'like-rank-content';
        const heading = document.createElement('div');
        heading.className = 'like-rank-heading';
        const title = document.createElement('span');
        title.textContent = row.cells[titleIndex]?.textContent || '曲名不明';
        heading.appendChild(title);
        const artist = document.createElement('small');
        artist.textContent = row.cells[artistIndex]?.textContent || '—';
        content.append(heading, artist);

        const metrics = document.createElement('div');
        metrics.className = 'like-rank-metrics';
        metrics.append(
          metric('再生回数', row.cells[playIndex]?.textContent || '—'),
          metric('いいね数', row.cells[likeIndex]?.textContent || '—'),
        );

        item.append(rank, content, metrics);
        fragment.appendChild(item);
      });
      list.appendChild(fragment);
    }

    const title = document.getElementById('tableTitle');
    if (title) title.textContent = '1日の再生数ランキング';
  } finally {
    applyingTrackRanking = false;
  }
}

function scheduleTrackRanking() {
  if (trackRankingRenderQueued) return;
  trackRankingRenderQueued = true;
  queueMicrotask(() => {
    trackRankingRenderQueued = false;
    renderTrackRanking();
  });
}

const observer = new MutationObserver(scheduleTrackRanking);
for (const target of [document.getElementById('thead'), document.getElementById('tbody')]) {
  if (target) observer.observe(target, { childList: true, subtree: true });
}
window.addEventListener('hashchange', scheduleTrackRanking);
