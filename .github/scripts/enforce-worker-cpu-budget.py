#!/usr/bin/env python3
"""Enforce a stable per-Worker CPU budget from the R2 observability summary."""

from __future__ import annotations

import json
import pathlib
import sys

BUDGET_MS = 8.0
SUMMARY_PATH = pathlib.Path("observability-logs/summary.json")
OUTPUT_PATH = pathlib.Path("observability-logs/cpu-budget.json")

summary = json.loads(SUMMARY_PATH.read_text(encoding="utf-8"))
violations: list[dict[str, object]] = []
workers: dict[str, dict[str, object]] = {}
total_events = int(summary.get("events") or 0)
total_samples = int((summary.get("cpu_ms") or {}).get("samples") or 0)
missing_observability = total_events <= 0 or total_samples <= 0

for name, item in sorted((summary.get("scripts") or {}).items()):
    events = int(item.get("events") or 0)
    cpu = item.get("cpu_ms") or {}
    samples = int(cpu.get("samples") or 0)
    p95 = cpu.get("p95")
    maximum = cpu.get("max")
    over_budget = None
    if events > 0 and samples <= 0:
        violations.append({
            "worker": name,
            "events": events,
            "samples": samples,
            "reason": "missing_cpu_samples",
        })
    if samples and p95 is not None:
        over_budget = float(p95) >= BUDGET_MS
        if over_budget:
            violations.append({
                "worker": name,
                "events": events,
                "samples": samples,
                "p95_ms": p95,
                "max_ms": maximum,
                "reason": "p95_at_or_over_budget",
            })
    workers[name] = {
        "events": events,
        "samples": samples,
        "p95_ms": p95,
        "max_ms": maximum,
        "p95_within_budget": None if over_budget is None else not over_budget,
        "max_at_or_over_budget": maximum is not None and float(maximum) >= BUDGET_MS,
    }

result = {
    "ok": not missing_observability and not violations,
    "budget_ms": BUDGET_MS,
    "comparison": "strictly_less_than",
    "statistic": "p95",
    "total_events": total_events,
    "total_samples": total_samples,
    "missing_observability": missing_observability,
    "violations": violations,
    "workers": workers,
}
OUTPUT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))

if missing_observability:
    print("Worker CPU budget cannot pass without observability samples", file=sys.stderr)
    raise SystemExit(1)
if violations:
    detail = ", ".join(
        f"{item['worker']} {item.get('reason')}"
        + (f" p95={item['p95_ms']}ms" if 'p95_ms' in item else "")
        for item in violations
    )
    print(f"Worker CPU p95 must stay below {BUDGET_MS:g} ms: {detail}", file=sys.stderr)
    raise SystemExit(1)
