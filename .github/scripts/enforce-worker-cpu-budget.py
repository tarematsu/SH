#!/usr/bin/env python3
"""Enforce the active Worker topology and per-invocation CPU ceiling."""

from __future__ import annotations

import json
import pathlib
import sys

BUDGET_MS = 10.0
SUMMARY_PATH = pathlib.Path("observability-logs/summary.json")
OUTPUT_PATH = pathlib.Path("observability-logs/cpu-budget.json")
ACTIVE_WORKERS = frozenset({
    "sh-buddies-ingest",
    "sh-minute-enrichment",
    "sh-runtime-orchestrator",
})

summary = json.loads(SUMMARY_PATH.read_text(encoding="utf-8"))
violations: list[dict[str, object]] = []
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
    samples = int(cpu.get("samples") or 0)
    p95 = cpu.get("p95")
    maximum = cpu.get("max")
    over_budget = None
    all_events_sampled = None if events <= 0 else samples == events

    if name in ACTIVE_WORKERS and (events <= 0 or samples <= 0):
        violations.append({
            "worker": name,
            "events": events,
            "samples": samples,
            "reason": "active_worker_unobserved",
        })
    if retired and events > 0:
        violations.append({
            "worker": name,
            "events": events,
            "samples": samples,
            "reason": "retired_worker_active",
        })
    if events > 0 and samples != events:
        violations.append({
            "worker": name,
            "events": events,
            "samples": samples,
            "reason": "incomplete_cpu_samples",
        })
    if samples > 0 and maximum is None:
        violations.append({
            "worker": name,
            "events": events,
            "samples": samples,
            "reason": "missing_cpu_max",
        })
    if samples and maximum is not None:
        over_budget = float(maximum) > BUDGET_MS
        if over_budget:
            violations.append({
                "worker": name,
                "events": events,
                "samples": samples,
                "p95_ms": p95,
                "max_ms": maximum,
                "reason": "invocation_above_budget",
            })
    workers[name] = {
        "events": events,
        "active": name in ACTIVE_WORKERS,
        "retired": retired,
        "samples": samples,
        "all_events_sampled": all_events_sampled,
        "p95_ms": p95,
        "max_ms": maximum,
        "max_within_budget": None if over_budget is None else not over_budget,
    }

result = {
    "ok": not missing_observability and not violations,
    "budget_ms": BUDGET_MS,
    "comparison": "less_than_or_equal",
    "statistic": "max",
    "scope": "all_active_workers_and_observed_invocations",
    "required_active_workers": sorted(ACTIVE_WORKERS),
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
