export function cleanText(value) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return text || null;
}

export function looksLikeId(value) {
  const text = cleanText(value) || '';
  return /^[0-9A-Za-z]{15,}$/.test(text) || /^JP[A-Z0-9]{8,}$/i.test(text);
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
  return candidates.find((value) => !looksLikeId(value)) || candidates[0] || null;
}
