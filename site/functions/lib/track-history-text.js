export function cleanText(value) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return text || null;
}

export function looksLikeId(value) {
  const text = cleanText(value) || '';
  return /^[0-9A-Za-z]{15,}$/.test(text) || /^JP[A-Z0-9]{8,}$/i.test(text);
}

export function looksLikePlaceholder(value) {
  const text = (cleanText(value) || '').toLocaleLowerCase('ja-JP');
  return !text || /^(?:[-‐‑‒–—―ー−_]+|n\/?a|none|null|undefined|unknown|不明|未取得|取得失敗|アーティスト不明|曲情報なし)$/.test(text);
}

export function canonical(value) {
  return (cleanText(value) || '')
    .toLocaleLowerCase('ja-JP')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[‐‑‒–—―ー−-]/g, '-')
    .replace(/[・･·]/g, '・')
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‘’‚‛′]/g, "'");
}

export function bestText(...values) {
  const candidates = values.map(cleanText).filter(Boolean);
  return candidates.find((value) => !looksLikePlaceholder(value) && !looksLikeId(value))
    || candidates.find((value) => !looksLikePlaceholder(value))
    || null;
}
