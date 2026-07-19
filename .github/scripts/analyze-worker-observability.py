#!/usr/bin/env python3
"""Analyze Cloudflare Workers Trace Events downloaded from R2."""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import math
import pathlib
import statistics
import sys
from collections import Counter
from typing import Any, Callable, Iterable

EXPECTED_SCRIPTS = {
    "sh-buddies-monitor",
    "sh-buddies-persist",
    "sh-buddies-ingest",
    "sh-buddies-comments",
    "sh-track-metadata",
    "sh-pages-read-model",
    "sh-minute-ingest",
    "sh-minute-derive",
    "sh-minute-enrichment",
    "sh-minute-rebuild",
    "sh-minute-maintenance",
    "sh-monitor-other",
}

SCHEDULES: dict[str, Callable[[dt.datetime], bool]] = {
    "sh-buddies-monitor": lambda minute: True,
    "sh-minute-maintenance": lambda minute: True,
    "sh-monitor-other": lambda minute: minute.minute % 5 == 0,
}

BAD_LOG_LEVELS = {"error", "fatal", "critical"}
WARNING_LOG_LEVELS = {"warn", "warning"}
CPU_REPORT_LIMIT_MS = 10.0
LOG_INGESTION_GRACE_MS = 90_000


def finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def iso_datetime(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1)]


def iter_events(raw_dir: pathlib.Path) -> Iterable[dict[str, Any]]:
    for path in sorted(raw_dir.glob("*")):
        data = path.read_bytes()
        if data[:2] == b"\x1f\x8b":
            data = gzip.decompress(data)
        for line in data.decode("utf-8", errors="replace").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict):
                yield event


def log_levels(event: dict[str, Any]) -> list[str]:
    levels: list[str] = []
    logs = event.get("Logs")
    if not isinstance(logs, list):
        return levels
    for item in logs:
        if not isinstance(item, dict):
            continue
        value = item.get("Level", item.get("level"))
        if value not in (None, ""):
            levels.append(str(value).strip().lower())
    return levels


def event_failure(event: dict[str, Any]) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    outcome = str(event.get("Outcome", "unknown")).strip().lower()
    if outcome != "ok":
        reasons.append(f"outcome:{outcome or 'missing'}")

    exceptions = event.get("Exceptions")
    if isinstance(exceptions, list) and exceptions:
        reasons.append(f"exceptions:{len(exceptions)}")

    levels = log_levels(event)
    bad_levels = sorted(set(levels) & BAD_LOG_LEVELS)
    if bad_levels:
        reasons.append(f"log_levels:{','.join(bad_levels)}")
    return bool(reasons), reasons


def metric_summary(values: list[float]) -> dict[str, float | int | None]:
    return {
        "samples": len(values),
        "avg": statistics.fmean(values) if values else None,
        "p50": percentile(values, 0.50),
        "p95": percentile(values, 0.95),
        "max": max(values) if values else None,
    }


def schedule_due(start_ms: float, end_ms: float, predicate: Callable[[dt.datetime], bool]) -> bool:
    if end_ms < start_ms:
        return False
    cursor = dt.datetime.fromtimestamp(start_ms / 1000, dt.timezone.utc).replace(second=0, microsecond=0)
    if cursor.timestamp() * 1000 < start_ms:
        cursor += dt.timedelta(minutes=1)
    end = dt.datetime.fromtimestamp(end_ms / 1000, dt.timezone.utc)
    while cursor <= end:
        if predicate(cursor):
            return True
        cursor += dt.timedelta(minutes=1)
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", default="raw")
    parser.add_argument("--output-dir", default="observability-logs")
    parser.add_argument("--selection", default="selection.json")
    args = parser.parse_args()

    raw_dir = pathlib.Path(args.raw_dir)
    output_dir = pathlib.Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    selection = json.loads(pathlib.Path(args.selection).read_text(encoding="utf-8"))
    cutoff_ms = iso_datetime(selection["cutoff"]).timestamp() * 1000

    counts = Counter({name: 0 for name in EXPECTED_SCRIPTS})
    outcomes: dict[str, Counter[str]] = {name: Counter() for name in EXPECTED_SCRIPTS}
    event_types: dict[str, Counter[str]] = {name: Counter() for name in EXPECTED_SCRIPTS}
    cpu: dict[str, list[float]] = {name: [] for name in EXPECTED_SCRIPTS}
    wall: dict[str, list[float]] = {name: [] for name in EXPECTED_SCRIPTS}
    errors = Counter({name: 0 for name in EXPECTED_SCRIPTS})
    warnings = Counter({name: 0 for name in EXPECTED_SCRIPTS})
    observed_sh_scripts: set[str] = set()
    all_cpu: list[float] = []
    all_wall: list[float] = []
    newest_event_ms: float | None = None
    total = 0

    full_path = output_dir / "sh-workers.ndjson"
    findings_path = output_dir / "findings.ndjson"
    with full_path.open("w", encoding="utf-8") as full, findings_path.open("w", encoding="utf-8") as findings:
        for event in iter_events(raw_dir):
            timestamp_ms = finite_number(event.get("EventTimestampMs"))
            if timestamp_ms is not None and timestamp_ms < cutoff_ms:
                continue

            script = event.get("ScriptName")
            if not isinstance(script, str) or not script.startswith("sh-"):
                continue

            if timestamp_ms is not None:
                newest_event_ms = timestamp_ms if newest_event_ms is None else max(newest_event_ms, timestamp_ms)
            observed_sh_scripts.add(script)
            compact = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
            full.write(compact + "\n")
            total += 1

            if script not in EXPECTED_SCRIPTS:
                findings.write(json.dumps({"reason": ["unexpected_script"], "event": event}, ensure_ascii=False, separators=(",", ":")) + "\n")
                continue

            counts[script] += 1
            outcome = str(event.get("Outcome", "unknown")).strip().lower() or "missing"
            outcomes[script][outcome] += 1
            event_type = str(event.get("EventType", "unknown")).strip().lower() or "missing"
            event_types[script][event_type] += 1

            cpu_ms = finite_number(event.get("CPUTimeMs"))
            if cpu_ms is not None:
                cpu[script].append(cpu_ms)
                all_cpu.append(cpu_ms)
            wall_ms = finite_number(event.get("WallTimeMs"))
            if wall_ms is not None:
                wall[script].append(wall_ms)
                all_wall.append(wall_ms)

            levels = log_levels(event)
            if set(levels) & WARNING_LOG_LEVELS:
                warnings[script] += 1

            failed, reasons = event_failure(event)
            if failed:
                errors[script] += 1
                findings.write(json.dumps({"reason": reasons, "event": event}, ensure_ascii=False, separators=(",", ":")) + "\n")

    unexpected_scripts = sorted(observed_sh_scripts - EXPECTED_SCRIPTS)
    audit_end_ms = min(
        dt.datetime.now(dt.timezone.utc).timestamp() * 1000 - LOG_INGESTION_GRACE_MS,
        newest_event_ms if newest_event_ms is not None else cutoff_ms,
    )
    required_recent = {
        name for name, predicate in SCHEDULES.items()
        if schedule_due(cutoff_ms, audit_end_ms, predicate)
    }
    missing_required = sorted(name for name in required_recent if counts[name] == 0)
    error_events = sum(errors.values())

    scripts: dict[str, Any] = {}
    for script in sorted(EXPECTED_SCRIPTS):
        cpu_summary = metric_summary(cpu[script])
        cpu_summary["over_10ms"] = sum(value > CPU_REPORT_LIMIT_MS for value in cpu[script])
        scripts[script] = {
            "events": counts[script],
            "error_events": errors[script],
            "warning_events": warnings[script],
            "outcomes": dict(sorted(outcomes[script].items())),
            "event_types": dict(sorted(event_types[script].items())),
            "cpu_ms": cpu_summary,
            "wall_ms": metric_summary(wall[script]),
        }

    ok = total > 0 and not unexpected_scripts and not missing_required and error_events == 0
    summary = {
        "ok": ok,
        "since": selection["cutoff"],
        "newest_event_timestamp": (
            dt.datetime.fromtimestamp(newest_event_ms / 1000, dt.timezone.utc).isoformat().replace("+00:00", "Z")
            if newest_event_ms is not None else None
        ),
        "objects_available": selection["objects_available"],
        "objects_selected": selection["objects_selected"],
        "objects_downloaded": len(list(raw_dir.glob("*"))),
        "oldest_object_modified": selection["oldest_object_modified"],
        "newest_object_modified": selection["newest_object_modified"],
        "events": total,
        "error_events": error_events,
        "unexpected_scripts": unexpected_scripts,
        "required_scheduled_scripts": sorted(required_recent),
        "missing_required_scripts": missing_required,
        "cpu_unit": "ms",
        "cpu_ms": metric_summary(all_cpu),
        "wall_ms": metric_summary(all_wall),
        "scripts": scripts,
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False, separators=(",", ":")))

    if total == 0:
        print("No sh-* Worker events found after the audit cutoff", file=sys.stderr)
    if unexpected_scripts:
        print(f"Unexpected active Workers: {', '.join(unexpected_scripts)}", file=sys.stderr)
    if missing_required:
        print(f"Scheduled Workers missing from the audit window: {', '.join(missing_required)}", file=sys.stderr)
    if error_events:
        print(f"Worker error events: {error_events}", file=sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
