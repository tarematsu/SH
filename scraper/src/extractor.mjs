import crypto from "node:crypto";

export function parseNumber(text) {
  if (text == null) return null;
  const normalized = String(text).replaceAll(",", "").trim();
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

async function optionalText(root, selector) {
  if (!selector) return null;
  const locator = root.locator(selector).first();
  if (!(await locator.count())) return null;
  return (await locator.innerText()).trim();
}

export async function extractFromDom(page, config) {
  const playText = await optionalText(page, config.playCountSelector);
  const commentCountText = await optionalText(page, config.commentCountSelector);

  const comments = [];
  if (config.commentItemSelector) {
    const items = page.locator(config.commentItemSelector);
    const count = Math.min(await items.count(), 200);
    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      const author = await optionalText(item, config.commentAuthorSelector);
      const text = await optionalText(item, config.commentTextSelector);
      if (!text) continue;
      const observedAt = new Date().toISOString();
      const key = crypto
        .createHash("sha256")
        .update(`${author ?? ""}\n${text}`)
        .digest("hex");
      comments.push({ key, observedAt, author, text });
    }
  }

  return {
    status: "ONLINE",
    playCount: parseNumber(playText),
    commentCount: parseNumber(commentCountText),
    comments
  };
}