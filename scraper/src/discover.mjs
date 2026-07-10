import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const targetUrl = process.env.TARGET_URL
  ?? "https://www.stationhead.com/c/buddies";

const runId = new Date().toISOString().replaceAll(":", "-");
const outDir = path.resolve("artifacts", runId);
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "en-US"
});
const page = await context.newPage();

const networkLog = [];
const wsLog = [];

page.on("response", async (response) => {
  const contentType = response.headers()["content-type"] ?? "";
  if (!contentType.includes("json")) return;
  try {
    const text = await response.text();
    if (text.length > 2_000_000) return;
    networkLog.push({
      time: new Date().toISOString(),
      status: response.status(),
      url: response.url(),
      body: text
    });
  } catch {
  }
});

page.on("websocket", (ws) => {
  ws.on("framereceived", (event) => {
    wsLog.push({
      time: new Date().toISOString(),
      url: ws.url(),
      direction: "received",
      payload: String(event.payload)
    });
  });
});

await page.goto(targetUrl, {
  waitUntil: "domcontentloaded",
  timeout: 60_000
});
await page.waitForTimeout(5_000);

await page.screenshot({
  path: path.join(outDir, "before-click.png"),
  fullPage: true
});
await fs.writeFile(
  path.join(outDir, "before-click.txt"),
  await page.locator("body").innerText()
);

const listenButton = page.getByRole("button", {
  name: /start listening|listen|join/i
}).first();

if (await listenButton.count()) {
  await listenButton.click({ timeout: 10_000 });
  await page.waitForTimeout(10_000);
}

await page.screenshot({
  path: path.join(outDir, "after-click.png"),
  fullPage: true
});
await fs.writeFile(
  path.join(outDir, "after-click.html"),
  await page.content()
);
await fs.writeFile(
  path.join(outDir, "after-click.txt"),
  await page.locator("body").innerText()
);

await page.waitForTimeout(30_000);

await fs.writeFile(
  path.join(outDir, "network-json.json"),
  JSON.stringify(networkLog, null, 2)
);
await fs.writeFile(
  path.join(outDir, "websocket.json"),
  JSON.stringify(wsLog, null, 2)
);

await browser.close();
console.log(`調査結果: ${outDir}`);