#!/usr/bin/env python3
"""Validate that every observability budget report is complete and fail-closed."""

from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path
from typing import Any

DAILY_REPORT = Path(os.environ.get("DAILY_USAGE_REPORT", "daily-usage/daily-usage.json"))
FREE_TIER_REPORT = Path(os.environ.get("FREE_TIER_USAGE_REPORT", "free-tier-usage/free-tier-usage.json"))
OUT = Path(os.environ.get("OBSERVABILITY_GATE_OUTPUT_DIR", "observability-gate"))
WORKERS = tuple(value.strip() for value in os.environ.get("CLOUDFLARE_WORKERS", "").split(",") if value.strip())

DAILY_METRICS = ("requests", "rowsRead", "rowsWritten")
FREE_TIER_METRICS = (
    "queueOperations",
    "doRequests",
    "doActiveGbSeconds",
    "doRowsRead",
    "doRowsWritten",
    "doStoredBytes",
    "r2ClassAOperations",
    "r2ClassBOperations",
    "r2StoredBytes",
    "kvReads",
    "kvWrites",
    "kvDeletes",
    "kvLists",
    "kvStoredBytes",
    "pipelineTransformBytes",
    "pipelineSinkBytes",
)
REQUIRED_RESOURCE_COUNTS = (
    "queues",
    "durableObjectNamespaces",
    "r2Buckets",
    "kvNamespaces",
)


def number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def mapping(value: Any, label: str, errors: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        errors.append(f"{label} must be an object")
        return {}
    return value


def violation_set(report: dict[str, Any], label: str, errors: list[str]) -> set[str]:
    value = report.get("violations")
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        errors.append(f"{label}.violations must be a string array")
        return set()
    return set(value)


def validate_metrics(
    report: dict[str, Any],
    metrics: tuple[str, ...],
    label: str,
    errors: list[str],
) -> None:
    usage = mapping(report.get("usage"), f"{label}.usage", errors)
    limits = mapping(report.get("limits"), f"{label}.limits", errors)
    actual_violations = violation_set(report, label, errors)
    expected_violations: set[str] = set()
    for metric in metrics:
        actual = number(usage.get(metric))
        limit = number(limits.get(metric))
        if actual is None or actual < 0:
            errors.append(f"{label}.usage.{metric} must be a non-negative finite number")
            continue
        if limit is None or limit <= 0:
            errors.append(f"{label}.limits.{metric} must be a positive finite number")
            continue
        if actual >= limit:
            expected_violations.add(metric)
    unknown = actual_violations - set(metrics)
    if unknown:
        errors.append(f"{label}.violations contains unknown metrics: {','.join(sorted(unknown))}")
    if actual_violations != expected_violations:
        errors.append(
            f"{label}.violations is inconsistent: expected={','.join(sorted(expected_violations)) or '-'} "
            f"actual={','.join(sorted(actual_violations)) or '-'}"
        )


def validate_daily(report: dict[str, Any], workers: tuple[str, ...] = WORKERS) -> list[str]:
    errors: list[str] = []
    validate_metrics(report, DAILY_METRICS, "daily", errors)
    usage = mapping(report.get("usage"), "daily.usage", errors)
    database_count = number(usage.get("databaseCount"))
    if database_count is None or database_count < 1 or not database_count.is_integer():
        errors.append("daily.usage.databaseCount must be a positive integer")
    measured = number(usage.get("measuredRequests"))
    reserve = number(usage.get("requestReserve"))
    requests = number(usage.get("requests"))
    if measured is None or reserve is None or requests is None or requests != measured + reserve:
        errors.append("daily requests must equal measuredRequests plus requestReserve")
    per_worker = mapping(usage.get("perWorkerRequests"), "daily.usage.perWorkerRequests", errors)
    per_worker_errors = mapping(usage.get("perWorkerErrors"), "daily.usage.perWorkerErrors", errors)
    if workers:
        expected = set(workers)
        if set(per_worker) != expected:
            errors.append("daily perWorkerRequests coverage does not match CLOUDFLARE_WORKERS")
        if set(per_worker_errors) != expected:
            errors.append("daily perWorkerErrors coverage does not match CLOUDFLARE_WORKERS")
    for metric_label, values in (("requests", per_worker), ("errors", per_worker_errors)):
        for worker, value in values.items():
            parsed = number(value)
            if parsed is None or parsed < 0:
                errors.append(f"daily worker {metric_label} metric for {worker} must be non-negative")
    return errors


def validate_free_tier(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    validate_metrics(report, FREE_TIER_METRICS, "freeTier", errors)
    counts = mapping(report.get("resourceCounts"), "freeTier.resourceCounts", errors)
    for key in REQUIRED_RESOURCE_COUNTS:
        value = number(counts.get(key))
        if value is None or value < 1 or not value.is_integer():
            errors.append(f"freeTier.resourceCounts.{key} must be a positive integer")
    pipelines = number(counts.get("pipelines"))
    if pipelines is None or pipelines < 0 or not pipelines.is_integer():
        errors.append("freeTier.resourceCounts.pipelines must be a non-negative integer")
    usage = mapping(report.get("usage"), "freeTier.usage", errors)
    decode_errors = number(usage.get("pipelineDecodeErrors"))
    if decode_errors is None or decode_errors < 0:
        errors.append("freeTier.usage.pipelineDecodeErrors must be non-negative")
    unknown_r2 = usage.get("unknownR2ActionsChargedAsClassA")
    if not isinstance(unknown_r2, list) or any(not isinstance(item, str) for item in unknown_r2):
        errors.append("freeTier.usage.unknownR2ActionsChargedAsClassA must be a string array")
    return errors


def load(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise RuntimeError(f"Required budget report is missing: {path}") from error
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Budget report is invalid JSON: {path}: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"Budget report root must be an object: {path}")
    return value


def self_test() -> int:
    daily = {
        "usage": {
            "requests": 31,
            "measuredRequests": 30,
            "requestReserve": 1,
            "rowsRead": 50,
            "rowsWritten": 2,
            "perWorkerRequests": {"a": 30},
            "perWorkerErrors": {"a": 0},
            "databaseCount": 3,
        },
        "limits": {"requests": 70, "rowsRead": 100, "rowsWritten": 10},
        "violations": [],
    }
    free = {
        "resourceCounts": {
            "queues": 1,
            "durableObjectNamespaces": 1,
            "r2Buckets": 1,
            "kvNamespaces": 1,
            "pipelines": 0,
        },
        "usage": {
            **{metric: 0 for metric in FREE_TIER_METRICS},
            "pipelineDecodeErrors": 0,
            "unknownR2ActionsChargedAsClassA": [],
        },
        "limits": {metric: 1 for metric in FREE_TIER_METRICS},
        "violations": [],
    }
    assert validate_daily(daily, ("a",)) == []
    assert validate_free_tier(free) == []
    broken_daily = json.loads(json.dumps(daily))
    broken_daily["usage"].pop("rowsRead")
    assert any("rowsRead" in item for item in validate_daily(broken_daily, ("a",)))
    broken_free = json.loads(json.dumps(free))
    broken_free["resourceCounts"]["kvNamespaces"] = 0
    assert any("kvNamespaces" in item for item in validate_free_tier(broken_free))
    inconsistent = json.loads(json.dumps(free))
    inconsistent["usage"]["queueOperations"] = 1
    assert any("inconsistent" in item for item in validate_free_tier(inconsistent))
    print("observability budget gate self-test passed")
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    daily = load(DAILY_REPORT)
    free = load(FREE_TIER_REPORT)
    errors = validate_daily(daily) + validate_free_tier(free)
    report = {
        "dailyReport": str(DAILY_REPORT),
        "freeTierReport": str(FREE_TIER_REPORT),
        "checkedDailyMetrics": list(DAILY_METRICS),
        "checkedFreeTierMetrics": list(FREE_TIER_METRICS),
        "errors": errors,
        "ok": not errors,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "budget-gate.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    summary = [
        "## Observability budget gate coverage",
        "",
        f"- Daily metrics checked: `{len(DAILY_METRICS)}`",
        f"- Included-usage metrics checked: `{len(FREE_TIER_METRICS)}`",
        f"- Result: `{'OK' if not errors else 'FAIL'}`",
    ]
    if errors:
        summary.extend(["", "### Coverage errors", *[f"- {item}" for item in errors]])
    text = "\n".join(summary) + "\n"
    (OUT / "summary.md").write_text(text, encoding="utf-8")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
            output.write(text)
    print("OBSERVABILITY_BUDGET_GATE=" + json.dumps(report, separators=(",", ":")))
    for error in errors:
        print(f"::error title=Observability budget gate coverage::{error}")
    return 1 if errors else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"::error title=Observability budget gate audit::{str(error).replace(chr(10), ' ')[:1000]}")
        raise
