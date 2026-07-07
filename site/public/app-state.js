let lastHistoryRows = [];
let refreshInFlight = false;
let refreshAbortController = null;
let resizeTimer = null;
let lastRenderSignature = '';
let nowPlayingTimer = null;
let nowPlayingState = null;
let playbackQueue = [];
let simulatedCurrentIndex = -1;
let currentNowPlayingHost = {};
let mainChartState = null;
let selectedMainChartIndex = null;

const el = (id) => document.getElementById(id);
const number = (value) => value == null ? '-' : Number(value).toLocaleString('ja-JP');
const dateTime = (value) => value ? new Date(Number(value)).toLocaleString('ja-JP', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '-';
const etaDateTime = (value) => value ? new Date(Number(value)).toLocaleString('ja-JP', { month:'long', day:'numeric', weekday:'short', hour:'2-digit', minute:'2-digit' }) : '予測データ不足';
const duration = (ms) => {
  const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
const escapeText = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

function inferredArtist(track) {
  const candidates = [
    track?.artist,
    track?.artist_name,
    track?.album_artist,
    track?.performer,
    track?.subtitle,
    Array.isArray(track?.artists) ? track.artists.map((item) => item?.name || item).filter(Boolean).join('、') : '',
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value && !/^JP[A-Z0-9]{8,}$/i.test(value)) return value;
  }

  const display = String(track?.display_title || '').trim();
  const title = String(track?.title || '').trim();
  if (!display) return '';

  for (const separator of [' — ', ' – ', ' - ', ' · ', ' • ', ' / ']) {
    const index = display.lastIndexOf(separator);
    if (index <= 0) continue;
    const left = display.slice(0, index).trim();
    const right = display.slice(index + separator.length).trim();
    if (!left || !right) continue;
    if (/^JP[A-Z0-9]{8,}$/i.test(left) || /^JP[A-Z0-9]{8,}$/i.test(right)) continue;
    if (!title || left === title || display.startsWith(`${title}${separator}`)) return right;
    if (right === title || display.endsWith(`${separator}${title}`)) return left;
  }

  const byMatch = display.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch && (!title || byMatch[1].trim() === title)) return byMatch[2].trim();
  return '';
}

function renderDailyDelta(elementId, value) {
  const node = el(elementId);
  if (!node) return;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  const sign = n > 0 ? '+' : n < 0 ? '−' : '±';
  node.textContent = `前日 ${sign}${number(Math.abs(n))}`;
  node.className = `daily-delta ${n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral'}`;
  node.hidden = false;
}

function setImage(element, src) {
  if (!element) return;
  element.decoding = 'async';
  element.loading = 'eager';
  if (src) {
    if (element.getAttribute('src') !== src) element.src = src;
    element.hidden = false;
  } else {
    element.hidden = true;
    element.removeAttribute('src');
  }
}

function lowerResolutionThumbnail(src) {
  const value = String(src || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value, location.href);
    if (/stationhead-production1-images\.s3\.amazonaws\.com$/i.test(url.hostname)) {
      url.pathname = url.pathname.replace(/\/(?:76|200|340|672|800|960)\//, '/200/');
      return url.href;
    }
    if (/i\.scdn\.co$/i.test(url.hostname)) {
      url.pathname = url.pathname.replace(/(ab67616d0000)(?:b273|01e02|048b)([a-f0-9]{40,})$/i, '$1640$2');
      return url.href;
    }
    if (/mosaic\.scdn\.co$/i.test(url.hostname)) {
      url.pathname = url.pathname.replace(/\/(?:640|300)\//, '/60/');
      return url.href;
    }
    return value;
  } catch {
    return value;
  }
}

function playbackImage(src, className = '', eager = false) {
  const imageSrc = eager ? src : lowerResolutionThumbnail(src);
  const safeSrc = escapeText(imageSrc || '');
  const attributes = [
    className ? `class="${escapeText(className)}"` : '',
    `src="${safeSrc}"`,
    'alt=""',
    'decoding="async"',
    `loading="${eager ? 'eager' : 'lazy'}"`,
    src ? '' : 'hidden',
  ].filter(Boolean).join(' ');
  return `<img ${attributes}>`;
}
