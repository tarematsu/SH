import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { chromium } from "playwright-core";

const TARGET_URL = process.argv[2] || "https://www.stationhead.com/sakuramankai";
const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, "captures", "sakuramankai-profile");
const USER_DATA_DIR = path.join(ROOT, ".profile-capture-browser");

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

  throw new Error(
    "Chrome/Edgeが見つかりません。CHROME_PATH環境変数にchrome.exeのパスを設定してください。"
  );
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

function isUsefulResource(url, resourceType) {
  const lower = url.toLowerCase();
  if (
    lower.includes("stationhead") ||
    lower.includes("production1") ||
    lower.includes("pusher") ||
    lower.includes("sockjs")
  ) {
    return true;
  }
  return ["xhr", "fetch", "websocket"].includes(resourceType);
}

function limitText(text, maxBytes = 2_000_000) {
  if (typeof text !== "string") return text;
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n<TRUNCATED>`;
}

const startedAt = new Date().toISOString();
const network = [];
const websockets = [];
const consoleMessages = [];
const pageErrors = [];
const pendingRequests = new Map();

const browserPath = findBrowser();
console.log(`Browser: ${browserPath}`);
console.log(`Target : ${TARGET_URL}`);
console.log(`Output : ${OUTPUT_DIR}`);

const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  executablePath: browserPath,
  headless: false,
  viewport: { width: 1440, height: 1000 },
  ignoreHTTPSErrors: true,
  args: [
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--no-first-run",
  ],
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
  if (!isUsefulResource(request.url(), request.resourceType())) return;

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
  });
});

page.on("requestfailed", (request) => {
  const id = pendingRequests.get(request);
  if (!id) return;
  const item = network.find((entry) => entry.id === id);
  if (item) {
    item.failure = request.failure()?.errorText || "request failed";
  }
});

page.on("response", async (response) => {
  const request = response.request();
  const id = pendingRequests.get(request);
  if (!id) return;

  const item = network.find((entry) => entry.id === id);
  if (!item) return;

  let bodyText = null;
  let bodyJson = null;
  let bodyError = null;
  const headers = await response.allHeaders().catch(() => response.headers());
  const contentType = String(headers["content-type"] || "").toLowerCase();

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

await page.goto(TARGET_URL, {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});

console.log("");
console.log("ブラウザが開きました。次を実施してください。");
console.log("1. ページが落ち着くまで20秒ほど待つ");
console.log("2. 再生・プロフィール・フォロー等、見える操作を一度ずつ行う");
console.log("3. 配信中なら再生画面まで開く");
console.log("4. 終了するとき、このPowerShellでEnterを押す");
console.log("");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

await new Promise((resolve) => rl.question("記録終了: Enterを押してください > ", resolve));
rl.close();

await page.waitForTimeout(2_000);

const finishedAt = new Date().toISOString();

const summary = {
  target_url: TARGET_URL,
  started_at: startedAt,
  finished_at: finishedAt,
  browser_path: browserPath,
  network_entries: network.length,
  websocket_connections: websockets.length,
  websocket_frames: websockets.reduce((sum, ws) => sum + ws.frames.length, 0),
  page_errors: pageErrors.length,
  candidate_api_urls: [
    ...new Set(
      network
        .filter((entry) =>
          ["xhr", "fetch"].includes(entry.resource_type) ||
          entry.url.includes("production1.stationhead.com")
        )
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
  path.join(OUTPUT_DIR, "websocket.json"),
  JSON.stringify(websockets, null, 2),
  "utf8"
);
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
fs.writeFileSync(
  path.join(OUTPUT_DIR, "summary.json"),
  JSON.stringify(summary, null, 2),
  "utf8"
);

console.log("");
console.log("保存しました:");
console.log(path.join(OUTPUT_DIR, "network.json"));
console.log(path.join(OUTPUT_DIR, "websocket.json"));
console.log(path.join(OUTPUT_DIR, "summary.json"));

await context.close();
