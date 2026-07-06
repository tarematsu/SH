# Stationhead browser discovery

Use this when the public Stationhead page works in a browser but the Worker collector cannot find the matching playback API.

The current target for buddy46 is a personal handle page:

```text
https://www.stationhead.com/buddy46
```

The goal is not to scrape the visible DOM first. The goal is to run a real browser once, capture the network traffic, and identify the JSON endpoint that contains the current station and playback queue.

## Setup

```bash
npm install
npx playwright install chromium
```

For a one-off run without keeping dependencies installed:

```bash
npm install --no-save playwright
npx playwright install chromium
```

## Run

```bash
npm run discover:stationhead -- --url=https://www.stationhead.com/buddy46 --duration-ms=45000
```

For an interactive browser window:

```bash
npm run discover:stationhead -- --url=https://www.stationhead.com/buddy46 --duration-ms=45000 --headed
```

If the page requires a play/listen/join button before loading the queue traffic, run:

```bash
npm run discover:stationhead -- --url=https://www.stationhead.com/buddy46 --duration-ms=45000 --auto-click
```

## Output

The script writes captures under:

```text
.stationhead-discovery/<page>-<timestamp>/
```

Important files:

- `summary.md`: short overview and candidate URLs.
- `network.json`: every captured response summary.
- `candidate-responses.json`: Stationhead responses whose URL/body contains queue-related keywords.
- `001-*.json`, `002-*.json`, ...: saved candidate JSON bodies.
- `page-state.json`: title, buttons, scripts and text snippets.
- `page.html`: final rendered HTML.
- `page.png`: full-page screenshot.

## What to look for

Search the output for these keys:

```text
queue_tracks
tracks
current_station
spotify_id
is_broadcasting
station/handle
```

The endpoint we want for the Worker should include enough of the following to build `/api/playback?channel=buddy46`:

- station id
- queue id
- start time
- paused / broadcasting state
- track list
- track duration
- Spotify ID or another stable track identifier

## Applying the result

After the capture identifies the real endpoint, update the buddy46 collector in:

```text
worker/src/buddy-playback.js
worker/src/buddy-fetch-guard.js
```

Prefer a direct JSON endpoint over DOM scraping. DOM scraping should only be used if the queue appears only in rendered markup or hydrated page data and no stable JSON endpoint exists. Because apparently web apps enjoy hiding structured data inside decorative soup.
