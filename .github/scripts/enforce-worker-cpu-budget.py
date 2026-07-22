#!/usr/bin/env python3
"""Evaluate persisted Cloudflare telemetry events against the Worker CPU policy.

Input is JSON on stdin:
{
  "events": [<Workers Observability telemetry events>],
  "workers": ["script-name", ...]
}

This module has no R2, AWS, artifact, or filesystem dependency.
"""

from __future__ import annotations

import json
import math
import sys
from typing import Any

BUDGET_MS = 10.0
ACTIVE_WORKERS = frozenset({
    "sh-buddies-ingest",
    "sh-minute-enrichment",
    "sh-sakurazaka46jp",
    "sh-runtime-orchestrator",
})
REBUILD_EVENT_MARKERS = (
    "stationhead-minute-rebuild",
    "stationhead-minute-derive",
    "minute-rebuild-stage",
    "minute_rebuild_",
    "minute_fact_rebuild",
    '"job_kind":"rebuild"',
    '"job_kind": "rebuild"',
)


def finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * fraction) - 1))
    return ordered[index]


def script_name(event: dict[str, Any]) -> str:
    metadata = event.get("$metadata") if isinstance(event.get("$metadata"), dict) else {}
    workers = event.get("$workers") if isinstance(event.get("$workers"), dict) else {}
    return str(metadata.get("service") or workers.get("scriptName") or "")


def rebuild_budget_exempt(event: dict[str, Any]) -> bool:
    if script_name(event) != "sh-runtime-orchestrator":
        return False
    compact = json.dumps(event, ensure_ascii=False, separators=(",", ":")).lower()
    return any(marker in compact for marker in REBUILD_EVENT_MARKERS)


def evaluate(events: list[dict[str, Any]], active_workers: set[str]) -> dict[str, Any]:
    observations: dict[str, dict[str, Any]] = {
        name: {"events": 0, "samples": [], "excluded_events": 0}
        for name in active_workers
    }

    for event in events:
        if not isinstance(event, dict):
            continue
        name = script_name(event)
        if name not in observations:
            continue
        if rebuild_budget_exempt(event):
            observations[name]["excluded_events"] += 1
            continue
        observations[name]["events"] += 1
        workers = event.get("$workers") if isinstance(event.get("$workers"), dict) else {}
        cpu_ms = finite_number(workers.get("cpuTimeMs"))
        if cpu_ms is not None:
            observations[name]["samples"].append(cpu_ms)

    violations: list[dict[str, Any]] = []
    unobserved_active_workers: list[str] = []
    workers_result: dict[str, dict[str, Any]] = {}

    for name in sorted(active_workers):
        observation = observations[name]
        budget_events = int(observation["events"])
        values = list(observation["samples"])
        samples = len(values)
        maximum = max(values) if values else None
        p95 = percentile(values, 0.95)
        excluded_events = int(observation["excluded_events"])

        if budget_events <= 0:
            unobserved_active_workers.append(name)
        if budget_events > 0 and samples != budget_events:
            violations.append({
                "worker": name,
                "events": budget_events,
                "samples": samples,
                "excluded_rebuild_events": excluded_events,
                "reason": "incomplete_cpu_samples",
            })
        over_budget = samples > 0 and maximum is not None and float(maximum) > BUDGET_MS
        if over_budget:
            violations.append({
                "worker": name,
                "events": budget_events,
                "samples": samples,
                "p95_ms": p95,
                "max_ms": maximum,
                "excluded_rebuild_events": excluded_events,
                "reason": "invocation_above_budget",
            })

        workers_result[name] = {
            "events": budget_events,
            "samples": samples,
            "excluded_rebuild_events": excluded_events,
            "p95_ms": p95,
            "max_ms": maximum,
            "max_within_budget": None if maximum is None else not over_budget,
        }

    return {
        "ok": not violations,
        "budget_ms": BUDGET_MS,
        "comparison": "less_than_or_equal",
        "statistic": "max",
        "scope": "telemetry_events_excluding_identified_historical_rebuild_invocations",
        "rebuild_event_markers": list(REBUILD_EVENT_MARKERS),
        "required_active_workers": sorted(active_workers),
        "unobserved_active_workers": sorted(unobserved_active_workers),
        "violations": violations,
        "workers": workers_result,
    }


def main() -> int:
    payload = json.load(sys.stdin)
    events = payload.get("events") or []
    requested = payload.get("workers") or sorted(ACTIVE_WORKERS)
    active_workers = {str(name) for name in requested if str(name) in ACTIVE_WORKERS}
    if not active_workers:
        active_workers = set(ACTIVE_WORKERS)
    result = evaluate(events, active_workers)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
