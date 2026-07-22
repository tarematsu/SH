#!/usr/bin/env python3
"""Publish a sanitized Cloudflare Workers observability summary to GitHub Actions."""

from __future__ import annotations

import datetime as dt
import html
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

API_BASE = "https://api.cloudflare.com/client/v4"
GRAPHQL_URL = f"{API_BASE}/graphql"
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"].strip()
WORKERS = [item.strip() for item in os.environ["CLOUDFLARE_WORKERS"].split(",") if item.strip()]
LOOKBACK_MINUTES = max(1, int(os.environ.get("LOOKBACK_MINUTES", "60")))
ACCOUNT_ID_OVERRIDE = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()


def request_json(url: str, *, method: str = "GET", payload: dict[str, Any] | None = None) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=None if payload is None else json.dumps(payload, separators=(",", ":")).encode(),
        method=method,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "github-actions-cloudflare-observability",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:2000]
        raise RuntimeError(f"Cloudflare API HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Cloudflare API request failed: {error.reason}") from error
    if data.get("success") is False or data.get("errors"):
        raise RuntimeError(f"Cloudflare API error: {json.dumps(data.get('errors'), ensure_ascii=False)[:2000]}")
    return data


def iso(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def account_id() -> str:
    if ACCOUNT_ID_OVERRIDE:
        return ACCOUNT_ID_OVERRIDE
    accounts = request_json(f"{API_BASE}/accounts?per_page=50").get("result") or []
    if len(accounts) != 1:
        raise RuntimeError(
            f"Expected one visible Cloudflare account, got {len(accounts)}; "
            "set repository variable CLOUDFLARE_ACCOUNT_ID"
        )
    return str(accounts[0]["id"])


def worker_metrics(account: str, worker: str, start: dt.datetime, end: dt.datetime) -> dict[str, Any]:
    query = """
      query WorkerMetrics($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string) {
        viewer {
          accounts(filter: {accountTag: $accountTag}) {
            workersInvocationsAdaptive(limit: 1, filter: {
              scriptName: $scriptName,
              datetime_geq: $datetimeStart,
              datetime_leq: $datetimeEnd
            }) {
              sum { requests errors subrequests }
              quantiles { cpuTimeP50 cpuTimeP99 }
            }
          }
        }
      }
    """
    data = request_json(
        GRAPHQL_URL,
        method="POST",
        payload={
            "query": query,
            "variables": {
                "accountTag": account,
                "datetimeStart": iso(start),
                "datetimeEnd": iso(end),
                "scriptName": worker,
            },
        },
    )
    accounts = (((data.get("data") or {}).get("viewer") or {}).get("accounts") or [])
    rows = (accounts[0].get("workersInvocationsAdaptive") or []) if accounts else []
    row = rows[0] if rows else {}
    sums = row.get("sum") or {}
    quantiles = row.get("quantiles") or {}
    return {
        "worker": worker,
        "requests": int(sums.get("requests") or 0),
        "errors": int(sums.get("errors") or 0),
        "subrequests": int(sums.get("subrequests") or 0),
        "cpu_p50_ms": (float(quantiles["cpuTimeP50"]) / 1000) if quantiles.get("cpuTimeP50") is not None else None,
        "cpu_p99_ms": (float(quantiles["cpuTimeP99"]) / 1000) if quantiles.get("cpuTimeP99") is not None else None,
    }


def error_events(account: str, start: dt.datetime, end: dt.datetime) -> list[dict[str, Any]]:
    services = [
        {"kind": "filter", "key": "$metadata.service", "operation": "eq", "type": "string", "value": worker}
        for worker in WORKERS
    ]
    payload = {
        "queryId": "github-actions-worker-errors",
        "dry": True,
        "timeframe": {"from": int(start.timestamp() * 1000), "to": int(end.timestamp() * 1000)},
        "view": "events",
        "limit": 50,
        "parameters": {
            "datasets": [],
            "filterCombination": "and",
            "filters": [
                {"kind": "group", "filterCombination": "or", "filters": services},
                {"kind": "filter", "key": "$metadata.error", "operation": "exists", "type": "string"},
            ],
        },
    }
    data = request_json(
        f"{API_BASE}/accounts/{account}/workers/observability/telemetry/query",
        method="POST",
        payload=payload,
    )
    return (((data.get("result") or {}).get("events") or {}).get("events") or [])


def clean_text(value: Any, limit: int = 180) -> str:
    text = " ".join(str(value or "").replace("|", "\\|").split())
    return html.escape(text[:limit]) or "-"


def clean_url(value: Any) -> str:
    if not value:
        return "-"
    parsed = urllib.parse.urlsplit(str(value))
    return clean_text(urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", "")))


def event_row(event: dict[str, Any]) -> tuple[str, str, str, str]:
    metadata = event.get("$metadata") if isinstance(event.get("$metadata"), dict) else {}
    workers = event.get("$workers") if isinstance(event.get("$workers"), dict) else {}
    worker_event = workers.get("event") if isinstance(workers.get("event"), dict) else {}
    request = worker_event.get("request") if isinstance(worker_event.get("request"), dict) else {}
    return (
        clean_text(event.get("timestamp") or metadata.get("timestamp") or "-", 40),
        clean_text(metadata.get("service") or workers.get("scriptName") or "unknown", 80),
        clean_text(metadata.get("error") or metadata.get("message") or event.get("source") or "error event"),
        clean_url(metadata.get("url") or request.get("url") or worker_event.get("url")),
    )


def number(value: Any) -> str:
    if value is None:
        return "-"
    return f"{float(value):.3f}".rstrip("0").rstrip(".")


def main() -> int:
    if not TOKEN or not WORKERS:
        raise RuntimeError("Cloudflare token and Worker list are required")
    request_json(f"{API_BASE}/user/tokens/verify")
    end = dt.datetime.now(dt.timezone.utc)
    start = end - dt.timedelta(minutes=LOOKBACK_MINUTES)
    account = account_id()
    metrics = [worker_metrics(account, worker, start, end) for worker in WORKERS]
    errors = error_events(account, start, end)

    lines = [
        "## Cloudflare Observability",
        "",
        f"- Window: `{iso(start)}` to `{iso(end)}`",
        f"- Account: `{account[:8]}…`",
        "- Sources: GraphQL Analytics API and Workers Observability Telemetry API",
        "",
        "| Worker | Requests | Errors | Error rate | Subrequests | CPU p50 ms | CPU p99 ms |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for item in metrics:
        rate = (item["errors"] / item["requests"] * 100) if item["requests"] else 0
        lines.append(
            f"| `{item['worker']}` | {item['requests']} | {item['errors']} | {rate:.2f}% | "
            f"{item['subrequests']} | {number(item['cpu_p50_ms'])} | {number(item['cpu_p99_ms'])} |"
        )

    lines.extend(["", f"### Recent persisted error events ({len(errors)} samples)", ""])
    if errors:
        lines.extend(["| Time | Worker | Error | URL |", "|---|---|---|---|"])
        for event in errors[:10]:
            timestamp, service, message, url = event_row(event)
            lines.append(f"| {timestamp} | `{service}` | {message} | {url} |")
    else:
        lines.append("No matching persisted error events were returned for this window.")

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as summary:
            summary.write("\n".join(lines) + "\n")
    else:
        print("\n".join(lines))
    if sum(item["errors"] for item in metrics):
        print("::warning title=Cloudflare Worker errors::GraphQL reported Worker invocation errors")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"::error title=Cloudflare Observability::{str(error).replace(chr(10), ' ')[:1000]}")
        raise
