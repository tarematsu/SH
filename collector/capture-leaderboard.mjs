import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { chromium } from "playwright-core";

const TARGET_URL = process.argv[2] || "https://www.stationhead.com/on/leaderboard";
const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, "captures", "weekly-leaderboard");
const USER_DATA_DIR = path.join(ROOT, ".leaderboard-capture-browser");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA || ""}\\Google\\Chrome\\Application\\chrome.exe`,
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    `${process.env.LOCALAPPDATA || ""}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Chrome/Edgeが見つかりません。CHROME_PATHを設定してください。");
}

function redactHeaders(headers = {}) {
  const sensitive = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
  ]);

  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (sensitive.has(lower)) {
      result[key] = "<redacted>";
    } else if (lower === "sth-device-uid") {
      result[key] = value ? `<present:length=${String(value).length}>` : "";
    } else {
      result[key] = value;
    }
  }
  return result;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function limitText(text, maxBytes = 3_000_000) {
  if (typeof text !== "string") return text;
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n<TRUNCATED>`;
}

function looksLeaderboardRelated(url, bodyText = "", bodyJson = null) {
  const haystack = [
    url,
    bodyText || "",
    bodyJson ? JSON.stringify(bodyJson) : "",
  ].join("\n").toLowerCase();

  return [
    "leaderboard",
    "ranking",
    "rank",
    "weekly",
    "top_host",
    "top-host",
    "tophost",
    "chart",
  ].some((token) => haystack.includes(token));
}

const startedAt = new Date().toISOString();
const network = [];
const websockets = [];
const pageErrors = [];
const consoleMessages = [];
const pendingRequests = new Map();

const browserPath = findBrowser();

const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  executablePath: browserPath,
  headless: false,
  viewport: { width: 1440, height: 1100 },
  ignoreHTTPSErrors: true,
  args: ["--no-first-run"],
});

const page = context.pages()[0] || await context.newPage();

page.on("console", (message) => {
  consoleMessages.push({
    at: new Date().toISOString(),
    type: message.type(),
    text: message.text(),
  });
});

page.on("pageerror", (error) => {
  pageErrors.push({
    at: new Date().toISOString(),
    message: error.message,
    stack: error.stack || null,
  });
});

page.on("request", (request) => {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  pendingRequests.set(request, id);

  network.push({
    id,
    requested_at: new Date().toISOString(),
    method: request.method(),
    url: request.url(),
    resource_type: request.resourceType(),
    request_headers: redactHeaders(request.headers()),
    request_post_data: limitText(request.postData() || ""),
    response: null,
    failure: null,
    leaderboard_candidate: false,
  });
});

page.on("requestfailed", (request) => {
  const id = pendingRequests.get(request);
  if (!id) return;
  const item = network.find((entry) => entry.id === id);
  if (item) item.failure = request.failure()?.errorText || "request failed";
});

page.on("response", async (response) => {
  const request = response.request();
  const id = pendingRequests.get(request);
  if (!id) return;

  const item = network.find((entry) => entry.id === id);
  if (!item) return;

  const headers = await response.allHeaders().catch(() => response.headers());
  const contentType = String(headers["content-type"] || "").toLowerCase();

  let bodyText = null;
  let bodyJson = null;
  let bodyError = null;

  try {
    if (
      contentType.includes("application/json") ||
      contentType.includes("text/") ||
      contentType.includes("javascript")
    ) {
      bodyText = limitText(await response.text());
      bodyJson = safeJsonParse(bodyText);
    }
  } catch (error) {
    bodyError = error.message;
  }

  item.response = {
    received_at: new Date().toISOString(),
    status: response.status(),
    status_text: response.statusText(),
    headers: redactHeaders(headers),
    body_json: bodyJson,
    body_text: bodyJson ? null : bodyText,
    body_error: bodyError,
  };

  item.leaderboard_candidate = looksLeaderboardRelated(
    item.url,
    bodyJson ? "" : bodyText,
    bodyJson
  );
});

page.on("websocket", (ws) => {
  const record = {
    opened_at: new Date().toISOString(),
    url: ws.url(),
    frames: [],
    closed_at: null,
    error: null,
  };
  websockets.push(record);

  ws.on("framesent", (event) => {
    record.frames.push({
      at: new Date().toISOString(),
      direction: "sent",
      payload: limitText(String(event.payload), 500_000),
    });
  });

  ws.on("framereceived", (event) => {
    record.frames.push({
      at: new Date().toISOString(),
      direction: "received",
      payload: limitText(String(event.payload), 500_000),
    });
  });

  ws.on("close", () => {
    record.closed_at = new Date().toISOString();
  });

  ws.on("socketerror", (error) => {
    record.error = String(error);
  });
});

console.log(`Target: ${TARGET_URL}`);
console.log(`Output: ${OUTPUT_DIR}`);

await page.goto(TARGET_URL, {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});

await page.waitForTimeout(10_000);

for (let i = 0; i < 8; i += 1) {
  await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 0.8, 600)));
  await page.waitForTimeout(1_000);
}
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(2_000);

console.log("");
console.log("ページ内の期間切替やタブがあれば一度ずつ押してください。");
console.log("ランキングが最後まで表示されるようスクロールしてください。");
console.log("終了時にPowerShellへ戻ってEnterを押します。");
console.log("");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
await new Promise((resolve) => rl.question("記録終了: Enter > ", resolve));
rl.close();

await page.waitForTimeout(2_000);

const dom = await page.content();
const visibleText = await page.locator("body").innerText().catch(() => "");
const finishedAt = new Date().toISOString();

const candidateEntries = network.filter((entry) => entry.leaderboard_candidate);

const summary = {
  target_url: TARGET_URL,
  started_at: startedAt,
  finished_at: finishedAt,
  browser_path: browserPath,
  network_entries: network.length,
  leaderboard_candidate_entries: candidateEntries.length,
  websocket_connections: websockets.length,
  websocket_frames: websockets.reduce((sum, ws) => sum + ws.frames.length, 0),
  page_errors: pageErrors.length,
  candidate_api_urls: [
    ...new Set(
      candidateEntries
        .filter((entry) => ["xhr", "fetch"].includes(entry.resource_type))
        .map((entry) => entry.url)
    ),
  ],
};

fs.writeFileSync(
  path.join(OUTPUT_DIR, "network.json"),
  JSON.stringify(network, null, 2),
  "utf8"
);
fs.writeFileSync(
  path.join(OUTPUT_DIR, "leaderboard-candidates.json"),
  JSON.stringify(candidateEntries, null, 2),
  "utf8"
);
fs.writeFileSync(
  path.join(OUTPUT_DIR, "websocket.json"),
  JSON.stringify(websockets, null, 2),
  "utf8"
);
fs.writeFileSync(
  path.join(OUTPUT_DIR, "summary.json"),
  JSON.stringify(summary, null, 2),
  "utf8"
);
fs.writeFileSync(path.join(OUTPUT_DIR, "dom.html"), dom, "utf8");
fs.writeFileSync(path.join(OUTPUT_DIR, "visible-text.txt"), visibleText, "utf8");
fs.writeFileSync(
  path.join(OUTPUT_DIR, "console.json"),
  JSON.stringify(consoleMessages, null, 2),
  "utf8"
);
fs.writeFileSync(
  path.join(OUTPUT_DIR, "page-errors.json"),
  JSON.stringify(pageErrors, null, 2),
  "utf8"
);

console.log("");
console.log("保存完了:");
console.log(path.join(OUTPUT_DIR, "leaderboard-candidates.json"));
console.log(path.join(OUTPUT_DIR, "network.json"));
console.log(path.join(OUTPUT_DIR, "summary.json"));
console.log(path.join(OUTPUT_DIR, "visible-text.txt"));

await context.close();
