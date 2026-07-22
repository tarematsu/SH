#!/usr/bin/env python3
"""Enforce the active Worker topology and per-invocation CPU ceiling."""

from __future__ import annotations

import json
import math
import pathlib
import sys
from typing import Any

BUDGET_MS = 10.0
SUMMARY_PATH = pathlib.Path("observability-logs/summary.json")
RAW_EVENTS_PATH = pathlib.Path("observability-logs/sh-workers.ndjson")
OUTPUT_PATH = pathlib.Path("observability-logs/cpu-budget.json")
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
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * fraction) - 1))
    return ordered[index]


def rebuild_budget_exempt(event: dict[str, Any]) -> bool:
    if event.get("ScriptName") != "sh-runtime-orchestrator":
        return False
    compact = json.dumps(event, ensure_ascii=False, separators=(",", ":")).lower()
    return any(marker in compact for marker in REBUILD_EVENT_MARKERS)


def filtered_cpu_observations() -> dict[str, dict[str, Any]]:
    observations: dict[str, dict[str, Any]] = {
        name: {"events": 0, "samples": [], "excluded_events": 0}
        for name in ACTIVE_WORKERS
    }
    if not RAW_EVENTS_PATH.exists():
        return observations
    for line in RAW_EVENTS_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        script = event.get("ScriptName")
        if script not in observations:
            continue
        if rebuild_budget_exempt(event):
            observations[script]["excluded_events"] += 1
            continue
        observations[script]["events"] += 1
        cpu_ms = finite_number(event.get("CPUTimeMs"))
        if cpu_ms is not None:
            observations[script]["samples"].append(cpu_ms)
    return observations


summary = json.loads(SUMMARY_PATH.read_text(encoding="utf-8"))
filtered = filtered_cpu_observations()
raw_filter_available = RAW_EVENTS_PATH.exists()
violations: list[dict[str, object]] = []
unobserved_active_workers: list[str] = []
workers: dict[str, dict[str, object]] = {}
total_events = int(summary.get("events") or 0)
total_samples = int((summary.get("cpu_ms") or {}).get("samples") or 0)
missing_observability = total_events <= 0 or total_samples <= 0
scripts = summary.get("scripts") or {}

for required_worker in sorted(ACTIVE_WORKERS):
    if required_worker not in scripts:
        violations.append({
            "worker": required_worker,
            "events": 0,
            "samples": 0,
            "reason": "active_worker_missing_from_summary",
        })

for name, item in sorted(scripts.items()):
    events = int(item.get("events") or 0)
    retired = item.get("retired") is True
    cpu = item.get("cpu_ms") or {}
    summary_samples = int(cpu.get("samples") or 0)
    summary_p95 = cpu.get("p95")
    summary_maximum = cpu.get("max")
    observation = filtered.get(name) if raw_filter_available else None
    if observation is not None:
        budget_events = int(observation["events"])
        values = observation["samples"]
        samples = len(values)
        p95 = percentile(values, 0.95)
        maximum = max(values) if values else None
        excluded_events = int(observation["excluded_events"])
    else:
        budget_events = events
        samples = summary_samples
        p95 = summary_p95
        maximum = summary_maximum
        excluded_events = 0

    over_budget = None
    all_events_sampled = None if budget_events <= 0 else samples == budget_events

    if name in ACTIVE_WORKERS and events <= 0:
        unobserved_active_workers.append(name)
    if retired and events > 0:
        violations.append({
            "worker": name,
            "events": events,
            "samples": samples,
            "reason": "retired_worker_active",
        })
    if budget_events > 0 and samples != budget_events:
        violations.append({
            "worker": name,
            "events": budget_events,
            "samples": samples,
            "excluded_rebuild_events": excluded_events,
            "reason": "incomplete_cpu_samples",
        })
    if samples > 0 and maximum is None:
        violations.append({
            "worker": name,
            "events": budget_events,
            "samples": samples,
            "reason": "missing_cpu_max",
        })
    if samples and maximum is not None:
        over_budget = float(maximum) > BUDGET_MS
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
    workers[name] = {
        "events": events,
        "cpu_budget_events": budget_events,
        "cpu_budget_excluded_rebuild_events": excluded_events,
        "active": name in ACTIVE_WORKERS,
        "retired": retired,
        "samples": samples,
        "all_budget_events_sampled": all_events_sampled,
        "p95_ms": p95,
        "max_ms": maximum,
        "max_within_budget": None if over_budget is None else not over_budget,
    }

result = {
    "ok": not missing_observability and not violations,
    "budget_ms": BUDGET_MS,
    "comparison": "less_than_or_equal",
    "statistic": "max",
    "scope": "observed_active_workers_excluding_identified_historical_rebuild_invocations",
    "rebuild_event_markers": list(REBUILD_EVENT_MARKERS),
    "raw_event_filter_available": raw_filter_available,
    "required_active_workers": sorted(ACTIVE_WORKERS),
    "unobserved_active_workers": sorted(unobserved_active_workers),
    "total_events": total_events,
    "total_samples": total_samples,
    "missing_observability": missing_observability,
    "violations": violations,
    "workers": workers,
}
OUTPUT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))

if missing_observability:
    print("Worker observability cannot pass without CPU samples", file=sys.stderr)
    raise SystemExit(1)
if violations:
    detail = ", ".join(
        f"{item['worker']} {item.get('reason')}"
        + (f" max={item['max_ms']}ms" if "max_ms" in item else "")
        for item in violations
    )
    print(f"Worker observability policy failed: {detail}", file=sys.stderr)
    raise SystemExit(1)
