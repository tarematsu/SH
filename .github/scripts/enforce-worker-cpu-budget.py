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

for name, item in sorted((summary.get("scripts") or {}).items()):
    events = int(item.get("events") or 0)
    cpu = item.get("cpu_ms") or {}
    samples = int(cpu.get("samples") or 0)
    p95 = cpu.get("p95")
    maximum = cpu.get("max")
    over_budget = None
    if samples and p95 is not None:
        over_budget = float(p95) > BUDGET_MS
        if over_budget:
            violations.append({
                "worker": name,
                "events": events,
                "samples": samples,
                "p95_ms": p95,
                "max_ms": maximum,
            })
    workers[name] = {
        "events": events,
        "samples": samples,
        "p95_ms": p95,
        "max_ms": maximum,
        "p95_within_budget": None if over_budget is None else not over_budget,
        "max_over_budget": maximum is not None and float(maximum) > BUDGET_MS,
    }

result = {
    "ok": not violations,
    "budget_ms": BUDGET_MS,
    "statistic": "p95",
    "violations": violations,
    "workers": workers,
}
OUTPUT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))

if violations:
    detail = ", ".join(f"{item['worker']} p95={item['p95_ms']}ms" for item in violations)
    print(f"Worker CPU p95 budget exceeded: {detail}", file=sys.stderr)
    raise SystemExit(1)
