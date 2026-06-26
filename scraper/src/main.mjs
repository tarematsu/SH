import "dotenv/config";
import { chromium } from "playwright";
import { extractFromDom } from "./extractor.mjs";

const config = {
  targetUrl: process.env.TARGET_URL,
  channelSlug: process.env.CHANNEL_SLUG ?? "buddies",
  ingestUrl: process.env.INGEST_URL,
  ingestSecret: process.env.INGEST_SECRET,
  intervalMs: Number(process.env.INTERVAL_MS ?? 60_000),
  playCountSelector: process.env.PLAY_COUNT_SELECTOR ?? "",
  commentCountSelector: process.env.COMMENT_COUNT_SELECTOR ?? "",
  commentItemSelector: process.env.COMMENT_ITEM_SELECTOR ?? "",
  commentAuthorSelector: process.env.COMMENT_AUTHOR_SELECTOR ?? "",
  commentTextSelector: process.env.COMMENT_TEXT_SELECTOR ?? ""
};

for (const key of ["targetUrl", "ingestUrl", "ingestSecret"]) {
  if (!config[key]) throw new Error(`Missing configuration: ${key}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function postPayload(payload) {
  const response = await fetch(config.ingestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.ingestSecret}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    throw new Error(`ingest failed: ${response.status} ${await response.text()}`);
  }
}

async function openChannel(page) {
  await page.goto(config.targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });
  await page.waitForTimeout(5_000);

  const button = page.getByRole("button", {
    name: /start listening|listen|join/i
  }).first();
  if (await button.count()) {
    await button.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(5_000);
  }
}

let retrySeconds = 5;
while (true) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      locale: "en-US"
    });
    await openChannel(page);
    retrySeconds = 5;

    while (true) {
      const observedAt = new Date().toISOString();
      const extracted = await extractFromDom(page, config);

      for (let i = 0; i < extracted.comments.length; i += 40) {
        await postPayload({
          observedAt,
          channelSlug: config.channelSlug,
          status: extracted.status,
          playCount: extracted.playCount,
          commentCount: extracted.commentCount,
          comments: extracted.comments.slice(i, i + 40),
          source: "scraper"
        });
      }

      if (extracted.comments.length === 0) {
        await postPayload({
          observedAt,
          channelSlug: config.channelSlug,
          status: extracted.status,
          playCount: extracted.playCount,
          commentCount: extracted.commentCount,
          comments: [],
          source: "scraper"
        });
      }

      console.log(observedAt, extracted.playCount, extracted.comments.length);
      await sleep(config.intervalMs);
    }
  } catch (error) {
    console.error(new Date().toISOString(), error);
    await browser?.close().catch(() => {});
    await sleep(retrySeconds * 1000);
    retrySeconds = Math.min(retrySeconds * 2, 300);
  }
}