#!/usr/bin/env python3
"""Audit current Cloudflare Worker versions with persisted and live telemetry."""

from __future__ import annotations

import datetime as dt
import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable

API_BASE = "https://api.cloudflare.com/client/v4"
TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
WORKERS = tuple(value.strip() for value in os.environ.get("CLOUDFLARE_WORKERS", "").split(",") if value.strip())
LOOKBACK_MINUTES = max(1, int(os.environ.get("LOOKBACK_MINUTES", "60")))
STATELESS_CPU_BUDGET_MS = float(os.environ.get("CPU_BUDGET_MS", "10"))
DURABLE_OBJECT_CPU_BUDGET_MS = float(os.environ.get("DURABLE_OBJECT_CPU_BUDGET_MS", "30000"))
ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
LIVE_TAIL_LOG = Path(os.environ.get("LIVE_TAIL_LOG", "live-tail.log"))
EXEMPT_MARKERS = tuple(
    value.strip().lower()
    for value in os.environ.get("CPU_BUDGET_EXEMPT_MARKERS", "").split(",")
    if value.strip()
)
PAGE_SIZE = 2000
MAX_PAGES = 10
OK_OUTCOMES = {"", "ok", "canceled", "cancelled", "success"}


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
        with urllib.request.urlopen(request, timeout=60) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:2000]
        raise RuntimeError(f"Cloudflare API HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Cloudflare API request failed: {error.reason}") from error
    if data.get("success") is False or data.get("errors"):
        raise RuntimeError(f"Cloudflare API error: {json.dumps(data.get('errors'), ensure_ascii=False)[:2000]}")
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
        "queryId": "github-actions-current-worker-audit",
        "dry": True,
        "timeframe": {"from": start_ms, "to": end_ms},
        "view": "events",
        "limit": PAGE_SIZE,
        "offsetDirection": "next",
        "parameters": {
            "view": "events",
            "limit": PAGE_SIZE,
            "datasets": [],
            "filterCombination": "and",
            "filters": [
                service_filter(),
                {
                    "kind": "filter",
                    "key": "$workers.cpuTimeMs",
                    "operation": "exists",
                    "type": "number",
                },
            ],
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
            key = event_key(event)
            if key in seen:
                continue
            seen.add(key)
            events.append(event)
        if len(page) < PAGE_SIZE:
            exhausted = True
            break
        metadata = page[-1].get("$metadata") if isinstance(page[-1], dict) else {}
        cursor = str(metadata.get("id") or "") if isinstance(metadata, dict) else ""
        if not cursor or cursor == payload.get("offset"):
            break
        payload["offset"] = cursor
    return events, total, not exhausted and total is not None and len(events) < total


def parse_start(end: dt.datetime) -> dt.datetime:
    raw = os.environ.get("AUDIT_FROM", "").strip()
    if not raw:
        return end - dt.timedelta(minutes=LOOKBACK_MINUTES)
    try:
        value = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise RuntimeError(f"AUDIT_FROM is invalid: {raw}") from error
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value.astimezone(dt.timezone.utc)


def finite(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def fields(event: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    metadata = event.get("$metadata")
    workers = event.get("$workers")
    return (
        metadata if isinstance(metadata, dict) else {},
        workers if isinstance(workers, dict) else {},
    )


def event_key(event: dict[str, Any]) -> str:
    metadata, workers = fields(event)
    identifier = metadata.get("id") or metadata.get("requestId") or workers.get("requestId")
    if identifier:
        return str(identifier)
    return json.dumps(
        [event.get("timestamp"), metadata.get("service"), workers.get("eventType"), workers.get("cpuTimeMs")],
        ensure_ascii=False,
        separators=(",", ":"),
    )


def timestamp_ms(event: dict[str, Any]) -> float:
    metadata, _ = fields(event)
    raw = event.get("timestamp") or metadata.get("timestamp")
    numeric = finite(raw)
    if numeric is not None:
        return numeric
    if isinstance(raw, str):
        try:
            parsed = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=dt.timezone.utc)
            return parsed.timestamp() * 1000
        except ValueError:
            return 0
    return 0


def version_id(event: dict[str, Any]) -> str:
    _, workers = fields(event)
    version = workers.get("scriptVersion")
    return str(version.get("id") or "") if isinstance(version, dict) else ""


def worker_name(event: dict[str, Any]) -> str:
    metadata, workers = fields(event)
    return str(metadata.get("service") or workers.get("scriptName") or "unknown")


def live_tail_events() -> list[dict[str, Any]]:
    if not LIVE_TAIL_LOG.exists():
        return []
    events: list[dict[str, Any]] = []
    for line in LIVE_TAIL_LOG.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.startswith("LIVE_TAIL_EVENT="):
            continue
        try:
            value = json.loads(line.removeprefix("LIVE_TAIL_EVENT="))
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and worker_name(value) in WORKERS:
            event = dict(value)
            event["_diagnostic_source"] = "live_tail"
            events.append(event)
    return events


def merge_events(*groups: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for group in groups:
        for event in group:
            merged[event_key(event)] = event
    return list(merged.values())


def clean_url(value: Any) -> str:
    if not value:
        return "-"
    parsed = urllib.parse.urlsplit(str(value))
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))[:180]


def detail(event: dict[str, Any]) -> dict[str, Any]:
    metadata, workers = fields(event)
    worker_event = workers.get("event") if isinstance(workers.get("event"), dict) else {}
    request = worker_event.get("request") if isinstance(worker_event.get("request"), dict) else {}
    source = event.get("source") if isinstance(event.get("source"), dict) else {}
    model = str(workers.get("executionModel") or "stateless")
    budget = DURABLE_OBJECT_CPU_BUDGET_MS if model == "durableObject" else STATELESS_CPU_BUDGET_MS
    message = metadata.get("error") or metadata.get("message") or source.get("message") or "-"
    return {
        "time": str(event.get("timestamp") or metadata.get("timestamp") or "-")[:48],
        "worker": worker_name(event)[:80],
        "version": version_id(event)[:80],
        "source": str(event.get("_diagnostic_source") or "persisted"),
        "cpu_ms": finite(workers.get("cpuTimeMs")),
        "budget_ms": budget,
        "model": model[:40],
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


def error_event(event: dict[str, Any]) -> bool:
    metadata, workers = fields(event)
    source = event.get("source") if isinstance(event.get("source"), dict) else {}
    level = str(metadata.get("level") or source.get("level") or "").lower()
    outcome = str(workers.get("outcome") or "").lower()
    return bool(metadata.get("error")) or level in {"error", "fatal"} or outcome not in OK_OUTCOMES


def current_events(
    persisted: list[dict[str, Any]],
    live: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, str], int]:
    latest: dict[str, tuple[float, str]] = {}
    persisted_invocations = [event for event in persisted if detail(event)["cpu_ms"] is not None]
    for event in persisted_invocations:
        worker = worker_name(event)
        version = version_id(event)
        if worker not in WORKERS or not version:
            continue
        candidate = (timestamp_ms(event), version)
        if worker not in latest or candidate[0] >= latest[worker][0]:
            latest[worker] = candidate
    versions = {worker: value[1] for worker, value in latest.items()}

    selected_persisted = []
    for event in persisted:
        worker = worker_name(event)
        if worker not in WORKERS:
            continue
        expected = versions.get(worker)
        if not expected or version_id(event) == expected:
            selected_persisted.append(event)
    selected_invocations = sum(1 for event in selected_persisted if detail(event)["cpu_ms"] is not None)
    old_versions = len(persisted_invocations) - selected_invocations
    return merge_events(selected_persisted, live), versions, old_versions


def evaluate(
    events: list[dict[str, Any]],
    truncated: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], dict[str, list[float]], list[str], bool]:
    violations: list[dict[str, Any]] = []
    exempted: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    samples: dict[str, list[float]] = {worker: [] for worker in WORKERS}
    for event in events:
        item = detail(event)
        cpu_ms = item["cpu_ms"]
        if item["worker"] in samples and cpu_ms is not None:
            samples[item["worker"]].append(cpu_ms)
        if error_event(event):
            errors.append(item)
        if cpu_ms is None or cpu_ms <= item["budget_ms"]:
            continue
        if exempt(event):
            exempted.append(item)
        else:
            violations.append(item)
    missing = [worker for worker, values in samples.items() if not values]
    return violations, exempted, errors, samples, missing, not truncated and not missing


def self_test() -> int:
    old = {
        "timestamp": "2026-07-22T00:00:00Z",
        "$metadata": {"id": "old", "service": "a"},
        "$workers": {"scriptVersion": {"id": "v1"}, "cpuTimeMs": 99, "outcome": "ok"},
    }
    current = {
        "timestamp": "2026-07-22T01:00:00Z",
        "$metadata": {"id": "current", "service": "a"},
        "$workers": {"scriptVersion": {"id": "v2"}, "cpuTimeMs": 4, "outcome": "ok"},
    }
    live = {
        "timestamp": "2026-07-22T01:01:00Z",
        "$metadata": {"id": "live", "service": "a"},
        "$workers": {"cpuTimeMs": 5, "outcome": "ok"},
        "_diagnostic_source": "live_tail",
    }
    original = globals()["WORKERS"]
    globals()["WORKERS"] = ("a",)
    try:
        selected, versions, excluded = current_events([old, current], [live])
        assert versions == {"a": "v2"}
        assert excluded == 1
        assert {event_key(event) for event in selected} == {"current", "live"}
        violations, _, errors, samples, missing, coverage = evaluate(selected, False)
        assert not violations and not errors and samples["a"] == [4.0, 5.0]
        assert not missing and coverage
        assert timestamp_ms(current) > timestamp_ms(old)
    finally:
        globals()["WORKERS"] = original
    print("telemetry audit self-test passed")
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    if not TOKEN or not WORKERS:
        raise RuntimeError("Cloudflare token and Worker list are required")
    account = account_id()
    end = dt.datetime.now(dt.timezone.utc)
    start = parse_start(end)
    persisted, matching, truncated = query_events(
        account,
        int(start.timestamp() * 1000),
        int(end.timestamp() * 1000),
    )
    live = live_tail_events()
    events, versions, old_versions = current_events(persisted, live)
    violations, exempted, errors, samples, missing, coverage_ok = evaluate(events, truncated)
    model_counts: dict[str, int] = {}
    for event in events:
        if detail(event)["cpu_ms"] is not None:
            model = detail(event)["model"]
            model_counts[model] = model_counts.get(model, 0) + 1
    worker_stats = {
        worker: {
            "version": versions.get(worker),
            "samples": len(values),
            "avg_ms": (sum(values) / len(values)) if values else None,
            "max_ms": max(values) if values else None,
        }
        for worker, values in samples.items()
    }
    report = {
        "window": {
            "from": start.isoformat().replace("+00:00", "Z"),
            "to": end.isoformat().replace("+00:00", "Z"),
        },
        "events": {
            "persisted_matching": matching,
            "persisted_fetched": len(persisted),
            "live_fetched": len(live),
            "current_version_events": len(events),
            "old_version_invocations_excluded": old_versions,
            "truncated": truncated,
        },
        "cpu_policy": {
            "stateless_budget_ms": STATELESS_CPU_BUDGET_MS,
            "durable_object_budget_ms": DURABLE_OBJECT_CPU_BUDGET_MS,
            "coverage_ok": coverage_ok,
            "missing_workers": missing,
            "models": model_counts,
            "workers": worker_stats,
            "violations": len(violations),
            "exempted": len(exempted),
            "samples": violations[:20],
        },
        "errors": {"count": len(errors), "samples": errors[:20]},
    }
    print("TELEMETRY_AUDIT=" + json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    print(
        f"CPU_POLICY stateless_budget_ms={STATELESS_CPU_BUDGET_MS:g} "
        f"durable_object_budget_ms={DURABLE_OBJECT_CPU_BUDGET_MS:g} "
        f"samples={sum(len(values) for values in samples.values())} "
        f"violations={len(violations)} exempted={len(exempted)} old_versions={old_versions} "
        f"truncated={truncated} coverage_ok={coverage_ok}"
    )
    for worker, stats in worker_stats.items():
        print(
            f"CPU_WORKER worker={worker} version={stats['version']} samples={stats['samples']} "
            f"avg_ms={stats['avg_ms']} max_ms={stats['max_ms']}"
        )
    for item in violations[:20]:
        print(
            "::error title=Worker CPU policy violation::"
            f"worker={item['worker']} version={item['version']} cpu_ms={item['cpu_ms']} "
            f"budget_ms={item['budget_ms']} model={item['model']} source={item['source']} "
            f"outcome={item['outcome']} event={item['event_type']} url={item['url']}"
        )
    for item in errors[:20]:
        print(
            "::error title=Cloudflare Worker error::"
            f"worker={item['worker']} version={item['version']} source={item['source']} "
            f"outcome={item['outcome']} message={item['message']} url={item['url']}"
        )
    if not coverage_ok:
        print(
            "::error title=Worker CPU policy has incomplete coverage::"
            f"missing_workers={','.join(missing)} truncated={truncated}"
        )

    summary = [
        "## Cloudflare Telemetry audit",
        "",
        f"- Window: `{report['window']['from']}` to `{report['window']['to']}`",
        f"- Stateless CPU policy: `<= {STATELESS_CPU_BUDGET_MS:g} ms` per invocation",
        f"- Durable Object CPU policy: `<= {DURABLE_OBJECT_CPU_BUDGET_MS:g} ms` per invocation",
        f"- Current-version CPU samples: `{sum(len(values) for values in samples.values())}`",
        f"- Live-tail samples received: `{len(live)}`",
        f"- Old-version invocations excluded: `{old_versions}`",
        f"- CPU coverage: `{'OK' if coverage_ok else 'MISSING'}`",
        f"- CPU violations: `{len(violations)}`",
        f"- Error invocations: `{len(errors)}`",
        "",
        "| Worker | Version | Samples | Average ms | Maximum ms |",
        "|---|---|---:|---:|---:|",
    ]
    for worker, stats in worker_stats.items():
        version = (stats["version"] or "-")[:12]
        summary.append(
            f"| `{worker}` | `{version}` | {stats['samples']} | {stats['avg_ms']} | {stats['max_ms']} |"
        )
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as output:
            output.write("\n".join(summary) + "\n")
    return 1 if violations or errors or not coverage_ok else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"::error title=Cloudflare Telemetry audit::{str(error).replace(chr(10), ' ')[:1000]}")
        raise
