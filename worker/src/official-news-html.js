import { NEWS_ORIGIN } from './official-news-utils.js';

export function decodeHtml(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&nbsp;', ' ');
}

export function stripHtml(html) {
  return decodeHtml(String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/li>|<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[\t\r ]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function articleLinks(html, limit) {
  const links = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*href=["']([^"']*\/news\/detail\/[^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html)) && links.length < limit) {
    const href = new URL(match[1], NEWS_ORIGIN).toString();
    const newsId = href.match(/\/news\/detail\/([^/?#]+)/i)?.[1];
    const listTitle = stripHtml(match[2]);
    if (!newsId || seen.has(newsId)) continue;
    seen.add(newsId);
    links.push({ newsId, href, listTitle });
  }
  return links;
}

export function articleTitle(html, fallback) {
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || fallback || '');
  return title.replace(/\s*\|\s*ニュース\s*\|\s*櫻坂46公式サイト\s*$/i, '').trim() || fallback;
}

export function articleContent(html, title) {
  const text = stripHtml(html);
  const end = text.indexOf('NEW ENTRY');
  const articleArea = end >= 0 ? text.slice(0, end) : text;
  const titleIndex = articleArea.lastIndexOf(title);
  const start = titleIndex >= 0 ? Math.max(0, titleIndex - 80) : Math.max(0, articleArea.length - 12000);
  return articleArea.slice(start).trim();
}

export function publishedDate(text) {
  const match = String(text || '').match(/(20\d{2})[.年\/-](\d{1,2})[.月\/-](\d{1,2})日?/);
  return match ? `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}` : null;
}

export function jstTimestamp(year, month, day, hour, minute) {
  const extraDays = Math.floor(hour / 24);
  const normalizedHour = hour % 24;
  return Date.UTC(year, month - 1, day + extraDays, normalizedHour - 9, minute);
}

export function scheduleTimes(text, fallbackYear) {
  const values = new Set();
  const full = /(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s*[（(][^）)]*[）)])?\s*(\d{1,2})\s*[:：]\s*(\d{2})/g;
  let match;
  while ((match = full.exec(text))) values.add(jstTimestamp(...match.slice(1, 6).map(Number)));

  const partial = /(?<!\d)(\d{1,2})月\s*(\d{1,2})日(?:\s*[（(][^）)]*[）)])?\s*(\d{1,2})\s*[:：]\s*(\d{2})/g;
  while ((match = partial.exec(text))) {
    const [month, day, hour, minute] = match.slice(1, 5).map(Number);
    values.add(jstTimestamp(fallbackYear, month, day, hour, minute));
  }
  return [...values].filter(Number.isFinite).sort((a, b) => a - b);
}

export function eventName(title) {
  return String(title || '櫻坂46 Stationhead')
    .replace(/\s*開催決定[！!。]?\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}
