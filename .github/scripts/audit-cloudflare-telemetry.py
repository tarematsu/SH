#!/usr/bin/env python3
"""Audit persisted Cloudflare Worker invocation events and enforce a CPU budget."""

from __future__ import annotations

import datetime as dt
import json
import math
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

API_BASE = "https://api.cloudflare.com/client/v4"
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"].strip()
WORKERS = tuple(
    value.strip()
    for value in os.environ["CLOUDFLARE_WORKERS"].split(",")
    if value.strip()
)
LOOKBACK_MINUTES = max(1, int(os.environ.get("LOOKBACK_MINUTES", "60")))
CPU_BUDGET_MS = float(os.environ.get("CPU_BUDGET_MS", "10"))
ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
EXEMPT_MARKERS = tuple(
    value.strip().lower()
    for value in os.environ.get("CPU_BUDGET_EXEMPT_MARKERS", "").split(",")
    if value.strip()
)
PAGE_SIZE = 2000
MAX_PAGES = 10
NON_FAILURE_OUTCOMES = {"", "ok", "canceled", "cancelled", "success"}


def request_json(
    url: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
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
        with urllib.request.urlopen(request, timeout=60) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:2000]
        raise RuntimeError(f"Cloudflare API HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Cloudflare API request failed: {error.reason}") from error

    errors = data.get("errors")
    if data.get("success") is False or errors:
        raise RuntimeError(f"Cloudflare API error: {json.dumps(errors, ensure_ascii=False)[:2000]}")
    return data


def account_id() -> str:
    if ACCOUNT_ID:
        return ACCOUNT_ID
    accounts = request_json(f"{API_BASE}/accounts?per_page=50").get("result") or []
    if len(accounts) != 1:
        raise RuntimeError(
            f"Expected one visible Cloudflare account, got {len(accounts)}; "
            "set repository variable CLOUDFLARE_ACCOUNT_ID"
        )
    return str(accounts[0]["id"])


def service_filter() -> dict[str, Any]:
    return {
        "kind": "group",
        "filterCombination": "or",
        "filters": [
            {
                "kind": "filter",
                "key": "$metadata.service",
                "operation": "eq",
                "type": "string",
                "value": worker,
            }
            for worker in WORKERS
        ],
    }


def query_events(account: str, start_ms: int, end_ms: int) -> tuple[list[dict[str, Any]], int | None, bool]:
    payload: dict[str, Any] = {
        "queryId": "github-actions-worker-invocations",
        "dry": True,
        "timeframe": {"from": start_ms, "to": end_ms},
        "view": "events",
        "limit": PAGE_SIZE,
        "offsetDirection": "next",
        "parameters": {
            "datasets": [],
            "filterCombination": "and",
            "filters": [service_filter()],
        },
    }
    endpoint = f"{API_BASE}/accounts/{account}/workers/observability/telemetry/query"
    events: list[dict[str, Any]] = []
    seen: set[str] = set()
    total: int | None = None
    exhausted = False

    for _ in range(MAX_PAGES):
        result = request_json(endpoint, method="POST", payload=payload).get("result") or {}
        block = result.get("events") or {}
        page = block.get("events") or []
        if total is None and block.get("count") is not None:
            total = int(block["count"])
        for event in page:
            if not isinstance(event, dict):
                continue
            metadata = event.get("$metadata")
            event_id = str(metadata.get("id")) if isinstance(metadata, dict) and metadata.get("id") else ""
            if event_id and event_id in seen:
                continue
            if event_id:
                seen.add(event_id)
            events.append(event)
        if len(page) < PAGE_SIZE:
            exhausted = True
            break
        metadata = page[-1].get("$metadata") if isinstance(page[-1], dict) else {}
        cursor = str(metadata.get("id")) if isinstance(metadata, dict) and metadata.get("id") else ""
        if not cursor or cursor == payload.get("offset"):
            break
        payload["offset"] = cursor

    truncated = not exhausted and total is not None and len(events) < total
    return events, total, truncated


def finite(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def event_fields(event: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    metadata = event.get("$metadata")
    workers = event.get("$workers")
    return (
        metadata if isinstance(metadata, dict) else {},
        workers if isinstance(workers, dict) else {},
    )


def clean_url(value: Any) -> str:
    if not value:
        return "-"
    parsed = urllib.parse.urlsplit(str(value))
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))[:180]


def detail(event: dict[str, Any]) -> dict[str, Any]:
    metadata, workers = event_fields(event)
    worker_event = workers.get("event") if isinstance(workers.get("event"), dict) else {}
    request = worker_event.get("request") if isinstance(worker_event.get("request"), dict) else {}
    message = metadata.get("error") or metadata.get("message") or event.get("source") or "-"
    return {
        "time": str(event.get("timestamp") or metadata.get("timestamp") or "-")[:48],
        "worker": str(metadata.get("service") or workers.get("scriptName") or "unknown")[:80],
        "cpu_ms": finite(workers.get("cpuTimeMs")),
        "outcome": str(workers.get("outcome") or "")[:40],
        "event_type": str(workers.get("eventType") or "-")[:40],
        "message": " ".join(str(message).split())[:220],
        "url": clean_url(metadata.get("url") or request.get("url") or worker_event.get("url")),
    }


def exempt(event: dict[str, Any]) -> bool:
    if not EXEMPT_MARKERS:
        return False
    compact = json.dumps(event, ensure_ascii=False, separators=(",", ":")).lower()
    return any(marker in compact for marker in EXEMPT_MARKERS)


def is_error(item: dict[str, Any], event: dict[str, Any]) -> bool:
    metadata, _ = event_fields(event)
    return bool(metadata.get("error")) or str(item["outcome"]).lower() not in NON_FAILURE_OUTCOMES


def main() -> int:
    if not TOKEN or not WORKERS:
        raise RuntimeError("Cloudflare token and Worker list are required")
    request_json(f"{API_BASE}/user/tokens/verify")
    account = account_id()
    end = dt.datetime.now(dt.timezone.utc)
    start = end - dt.timedelta(minutes=LOOKBACK_MINUTES)
    events, matching, truncated = query_events(
        account,
        int(start.timestamp() * 1000),
        int(end.timestamp() * 1000),
    )

    samples_by_worker: dict[str, list[float]] = {worker: [] for worker in WORKERS}
    violations: list[dict[str, Any]] = []
    exempted: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    invocation_events = 0

    for event in events:
        item = detail(event)
        cpu_ms = item["cpu_ms"]
        if cpu_ms is None:
            continue
        invocation_events += 1
        worker = item["worker"]
        if worker in samples_by_worker:
            samples_by_worker[worker].append(cpu_ms)
        if is_error(item, event):
            errors.append(item)
        if cpu_ms <= CPU_BUDGET_MS:
            continue
        if exempt(event):
            exempted.append(item)
        else:
            violations.append(item)

    workers = {
        worker: {
            "samples": len(values),
            "avg_ms": (sum(values) / len(values)) if values else None,
            "max_ms": max(values) if values else None,
        }
        for worker, values in samples_by_worker.items()
    }
    coverage_ok = invocation_events > 0 and not truncated
    report = {
        "window": {
            "from": start.isoformat().replace("+00:00", "Z"),
            "to": end.isoformat().replace("+00:00", "Z"),
        },
        "workers": list(WORKERS),
        "events": {"matching": matching, "fetched": len(events), "truncated": truncated},
        "cpu_policy": {
            "budget_ms": CPU_BUDGET_MS,
            "invocations": invocation_events,
            "coverage_ok": coverage_ok,
            "workers": workers,
            "violations": len(violations),
            "exempted": len(exempted),
            "samples": violations[:20],
        },
        "errors": {"count": len(errors), "samples": errors[:20]},
    }
    print("TELEMETRY_AUDIT=" + json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    print(
        f"CPU_POLICY budget_ms={CPU_BUDGET_MS:g} invocations={invocation_events} "
        f"violations={len(violations)} exempted={len(exempted)} "
        f"fetched={len(events)} matching={matching} truncated={truncated} coverage_ok={coverage_ok}"
    )
    for worker, stats in workers.items():
        print(
            f"CPU_WORKER worker={worker} samples={stats['samples']} "
            f"avg_ms={stats['avg_ms']} max_ms={stats['max_ms']}"
        )
    for item in violations[:20]:
        print(
            "::error title=Worker CPU policy violation::"
            f"worker={item['worker']} cpu_ms={item['cpu_ms']} outcome={item['outcome']} "
            f"event={item['event_type']} url={item['url']}"
        )
    for item in errors[:20]:
        print(
            "::warning title=Cloudflare Worker error::"
            f"worker={item['worker']} outcome={item['outcome']} "
            f"message={item['message']} url={item['url']}"
        )
    if truncated:
        print("::error title=Worker CPU policy incomplete::Telemetry events were truncated")
    if not coverage_ok:
        print("::error title=Worker CPU policy has no coverage::No complete invocation CPU sample set was returned")

    summary = [
        "## Cloudflare Telemetry audit",
        "",
        f"- Window: `{report['window']['from']}` to `{report['window']['to']}`",
        f"- CPU policy: `<= {CPU_BUDGET_MS:g} ms` per invocation",
        f"- Invocation CPU samples: `{invocation_events}`",
        f"- CPU coverage: `{'OK' if coverage_ok else 'MISSING'}`",
        f"- CPU violations: `{len(violations)}`",
        f"- CPU exemptions: `{len(exempted)}`",
        f"- Error invocations: `{len(errors)}`",
        "",
        "| Worker | Samples | Average ms | Maximum ms |",
        "|---|---:|---:|---:|",
    ]
    for worker, stats in workers.items():
        summary.append(
            f"| `{worker}` | {stats['samples']} | {stats['avg_ms']} | {stats['max_ms']} |"
        )
    if violations:
        summary.extend(["", "| Worker | CPU ms | Outcome | Event | URL |", "|---|---:|---|---|---|"])
        for item in violations[:10]:
            summary.append(
                f"| `{item['worker']}` | {item['cpu_ms']} | {item['outcome']} | "
                f"{item['event_type']} | {item['url']} |"
            )
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as output:
            output.write("\n".join(summary) + "\n")

    return 1 if violations or not coverage_ok else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"::error title=Cloudflare Telemetry audit::{str(error).replace(chr(10), ' ')[:1000]}")
        raise
