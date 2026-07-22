#!/usr/bin/env python3
"""Audit captured Cloudflare live-tail events without another API request."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

LOG = Path(os.environ.get("LIVE_TAIL_LOG", "live-tail.log"))
WORKERS = {x.strip() for x in os.environ.get("CLOUDFLARE_WORKERS", "").split(",") if x.strip()}
STATELESS_LIMIT = float(os.environ.get("CPU_BUDGET_MS", "10"))
DO_LIMIT = float(os.environ.get("DURABLE_OBJECT_CPU_BUDGET_MS", "30000"))
OK = {"", "ok", "canceled", "cancelled", "success"}


def fields(event: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    metadata = event.get("$metadata")
    workers = event.get("$workers")
    return (
        metadata if isinstance(metadata, dict) else {},
        workers if isinstance(workers, dict) else {},
    )


def worker_name(event: dict[str, Any]) -> str:
    metadata, workers = fields(event)
    return str(metadata.get("service") or workers.get("scriptName") or "unknown")


def cpu(event: dict[str, Any]) -> float | None:
    _, workers = fields(event)
    try:
        return float(workers.get("cpuTimeMs"))
    except (TypeError, ValueError):
        return None


def limit(event: dict[str, Any]) -> float:
    _, workers = fields(event)
    return DO_LIMIT if workers.get("executionModel") == "durableObject" else STATELESS_LIMIT


def failed(event: dict[str, Any]) -> bool:
    metadata, workers = fields(event)
    source = event.get("source") if isinstance(event.get("source"), dict) else {}
    level = str(metadata.get("level") or source.get("level") or "").lower()
    outcome = str(workers.get("outcome") or "").lower()
    return bool(metadata.get("error")) or level in {"error", "fatal"} or outcome not in OK


def load() -> list[dict[str, Any]]:
    if not LOG.exists():
        return []
    events = []
    for line in LOG.read_text(errors="replace").splitlines():
        if not line.startswith("LIVE_TAIL_EVENT="):
            continue
        try:
            event = json.loads(line.removeprefix("LIVE_TAIL_EVENT="))
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict) and (not WORKERS or worker_name(event) in WORKERS):
            events.append(event)
    return events


def evaluate(events: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    violations = [event for event in events if cpu(event) is not None and cpu(event) > limit(event)]
    errors = [event for event in events if failed(event)]
    return violations, errors


def self_test() -> int:
    good = {"$metadata": {"service": "a"}, "$workers": {"cpuTimeMs": 4, "outcome": "ok"}}
    bad = {"$metadata": {"service": "a"}, "$workers": {"cpuTimeMs": 11, "outcome": "exception"}}
    violations, errors = evaluate([good, bad])
    assert violations == [bad] and errors == [bad]
    print("live-tail self-test passed")
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    events = load()
    violations, errors = evaluate(events)
    print(f"LIVE_TAIL_AUDIT events={len(events)} cpu_violations={len(violations)} errors={len(errors)}")
    if not events:
        print("::warning title=Cloudflare live-tail coverage::No live events were captured; persisted telemetry remains authoritative")
    for event in violations[:20]:
        print(
            "::error title=Live Worker CPU policy violation::"
            f"worker={worker_name(event)} cpu_ms={cpu(event)} limit_ms={limit(event)}"
        )
    for event in errors[:20]:
        metadata, workers = fields(event)
        print(
            "::error title=Live Cloudflare Worker error::"
            f"worker={worker_name(event)} outcome={workers.get('outcome')} "
            f"message={metadata.get('error') or metadata.get('message') or '-'}"
        )
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as summary:
            summary.write(
                "## Cloudflare live-tail audit\n\n"
                f"- Events: `{len(events)}`\n"
                f"- CPU violations: `{len(violations)}`\n"
                f"- Error events: `{len(errors)}`\n"
            )
    return 1 if violations or errors else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"::error title=Cloudflare live-tail audit::{str(error).replace(chr(10), ' ')[:1000]}")
        raise
