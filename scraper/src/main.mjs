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

async function clickFirstVisible(page, locators, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    for (const locator of locators) {
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        try {
          await candidate.click({ timeout: 5_000 });
          return true;
        } catch (error) {
          lastError = error;
        }
      }
    }
    await page.waitForTimeout(1_000);
  }

  if (lastError) console.warn("listen button click failed:", lastError.message);
  return false;
}

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
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(2_000);

  const clicked = await clickFirstVisible(page, [
    page.getByRole("button", { name: /start listening|listen live|listen|join|play/i }),
    page.getByText(/start listening|listen live|listen|join/i),
    page.locator("[aria-label*='Listen' i], [aria-label*='Join' i], [data-testid*='listen' i], [data-testid*='join' i]"),
    page.locator("button").filter({ hasText: /listen|join|play/i })
  ]);

  if (clicked) {
    await page.waitForTimeout(5_000);
  } else {
    console.warn("listen button was not found; continuing to scrape visible page state");
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
