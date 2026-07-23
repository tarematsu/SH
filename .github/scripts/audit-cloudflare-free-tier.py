#!/usr/bin/env python3
"""Project account-wide partial-day Cloudflare usage to daily allowance periods."""

from __future__ import annotations

import datetime as dt
import importlib.util
import json
import math
import os
import sys
from pathlib import Path
from typing import Any

CORE_PATH = Path(__file__).with_name("audit-cloudflare-free-tier-core.py")
SPEC = importlib.util.spec_from_file_location("cloudflare_free_tier_core", CORE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load free-tier audit from {CORE_PATH}")
core = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(core)

_ORIGINAL_AGGREGATE = core.aggregate
_ACCOUNT_SCOPE = "account"
_DAY_SECONDS = 24 * 60 * 60
_PROJECTION_METHOD = "linear-from-utc-midnight"
_DAILY_RATE_METRICS = (
    "queueOperations",
    "doRequests",
    "doActiveGbSeconds",
    "doRowsRead",
    "doRowsWritten",
    "kvReads",
    "kvWrites",
    "kvDeletes",
    "kvLists",
)
_MONTHLY_OR_STATE_METRICS = tuple(
    metric for metric in core.LIMITS if metric not in _DAILY_RATE_METRICS
)


def paginated(account: str, path: str) -> list[dict[str, Any]]:
    """Use the lowest common page limit across Cloudflare resource APIs."""
    rows: list[dict[str, Any]] = []
    page = 1
    while True:
        separator = "&" if "?" in path else "?"
        body = core.api(
            f"{core.API}/accounts/{account}/{path}{separator}per_page=50&page={page}"
        )
        batch = body.get("result") or []
        rows.extend(batch)
        info = body.get("result_info") or {}
        if page >= int(info.get("total_pages") or 1) or not batch:
            return rows
        page += 1


def graphql_document() -> str:
    """Query account-wide meters without unsupported resource dimensions."""
    return """query FreeTierBudget($account: string, $day: Date!, $now: Time!, $monthStart: Time!) {
      viewer { accounts(filter: {accountTag: $account}) {
        queues: queueMessageOperationsAdaptiveGroups(limit: 10000, filter: {date_geq: $day, date_leq: $day}) {
          sum { billableOperations }
        }
        r2ops: r2OperationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $monthStart, datetime_leq: $now}) {
          sum { requests } dimensions { actionType }
        }
        r2storage: r2StorageAdaptiveGroups(limit: 10000, filter: {datetime_geq: $monthStart, datetime_leq: $now}, orderBy: [datetime_DESC]) {
          max { payloadSize metadataSize } dimensions { datetime }
        }
        doInvocations: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: {date_geq: $day, date_leq: $day}) {
          sum { requests }
        }
        doPeriodic: durableObjectsPeriodicGroups(limit: 10000, filter: {date_geq: $day, date_leq: $day}) {
          sum { duration rowsRead rowsWritten }
        }
        doStorage: durableObjectsStorageGroups(limit: 10000, filter: {date_geq: $day, date_leq: $day}) {
          max { storedBytes }
        }
        kvOperations: kvOperationsAdaptiveGroups(limit: 10000, filter: {date_geq: $day, date_leq: $day}) {
          sum { requests } dimensions { actionType }
        }
        kvStorage: kvStorageAdaptiveGroups(limit: 10000, filter: {date_geq: $day, date_leq: $day}, orderBy: [date_DESC]) {
          max { keyCount byteCount } dimensions { date }
        }
        pipelineOperators: pipelinesOperatorAdaptiveGroups(limit: 10000, filter: {datetime_geq: $monthStart, datetime_leq: $now, streamId_neq: ""}) {
          sum { bytesIn recordsIn decodeErrors }
        }
        pipelineSinks: pipelinesSinkAdaptiveGroups(limit: 10000, filter: {datetime_geq: $monthStart, datetime_leq: $now}) {
          sum { bytesWritten uncompressedBytesWritten recordsWritten filesWritten }
        }
      }}
    }"""


def _tag(groups: Any, dimension: str) -> list[dict[str, Any]]:
    tagged: list[dict[str, Any]] = []
    for group in groups or []:
        item = dict(group)
        dimensions = dict(item.get("dimensions") or {})
        dimensions[dimension] = _ACCOUNT_SCOPE
        item["dimensions"] = dimensions
        tagged.append(item)
    return tagged


def _metric(value: Any) -> float:
    try:
        parsed = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, parsed) if math.isfinite(parsed) else 0.0


def _durable_object_duration_gb_seconds(groups: Any) -> float:
    duration = 0.0
    active_microseconds = 0.0
    has_duration = False
    for group in groups or []:
        sums = group.get("sum") or {}
        if "duration" in sums:
            has_duration = True
            duration += _metric(sums.get("duration"))
        else:
            active_microseconds += _metric(sums.get("activeTime"))
    if has_duration:
        return round(duration, 3)
    return round(active_microseconds / 1_000_000 * 0.128, 3)


def aggregate(
    row: dict[str, Any],
    _queue_ids: set[str],
    _namespace_ids: set[str],
    _buckets: set[str],
    _kv_ids: set[str],
    _pipeline_ids: set[str],
) -> dict[str, Any]:
    """Normalize account-wide groups into the retained validated aggregator."""
    normalized = dict(row)
    normalized["queues"] = _tag(row.get("queues"), "queueId")
    normalized["r2ops"] = _tag(row.get("r2ops"), "bucketName")
    normalized["r2storage"] = _tag(row.get("r2storage"), "bucketName")
    normalized["doInvocations"] = _tag(row.get("doInvocations"), "namespaceId")
    normalized["doPeriodic"] = _tag(row.get("doPeriodic"), "namespaceId")
    normalized["doStorage"] = _tag(row.get("doStorage"), "namespaceId")
    normalized["kvOperations"] = _tag(row.get("kvOperations"), "namespaceId")
    normalized["kvStorage"] = _tag(row.get("kvStorage"), "namespaceId")
    normalized["pipelineOperators"] = _tag(row.get("pipelineOperators"), "pipelineId")
    normalized["pipelineSinks"] = _tag(row.get("pipelineSinks"), "pipelineId")
    account = {_ACCOUNT_SCOPE}
    usage = _ORIGINAL_AGGREGATE(
        normalized,
        account,
        account,
        account,
        account,
        account,
    )
    usage["doActiveGbSeconds"] = _durable_object_duration_gb_seconds(
        row.get("doPeriodic")
    )
    return usage


def projection_metadata(now: dt.datetime) -> dict[str, Any]:
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elapsed = max(1, min(_DAY_SECONDS, int((now - start).total_seconds())))
    return {
        "method": _PROJECTION_METHOD,
        "periodSeconds": _DAY_SECONDS,
        "elapsedSeconds": elapsed,
        "factor": _DAY_SECONDS / elapsed,
        "projectedMetrics": list(_DAILY_RATE_METRICS),
    }


def project_daily_allowances(
    actual: dict[str, Any],
    projection: dict[str, Any],
) -> dict[str, Any]:
    projected = dict(actual)
    factor = float(projection["factor"])
    for key in _DAILY_RATE_METRICS:
        value = _metric(actual.get(key))
        if key == "doActiveGbSeconds":
            projected[key] = round(value * factor, 3)
        else:
            projected[key] = math.ceil(value * factor)
    return projected


def format_factor(value: float) -> str:
    return f"{value:.3f}".rstrip("0").rstrip(".")


def usage_basis(metric: str) -> str:
    if metric in _DAILY_RATE_METRICS:
        return "24h projection"
    if metric in {"r2ClassAOperations", "r2ClassBOperations", "pipelineTransformBytes", "pipelineSinkBytes"}:
        return "month-to-date"
    return "observed state"


core.paginated = paginated
core.graphql_document = graphql_document
core.aggregate = aggregate


def self_test() -> int:
    calls: list[str] = []
    original_api = core.api
    try:
        core.api = lambda url, payload=None: (
            calls.append(url)
            or {"result": [], "result_info": {"total_pages": 1}}
        )
        assert paginated("account", "pipelines") == []
        assert calls == [
            f"{core.API}/accounts/account/pipelines?per_page=50&page=1"
        ]
    finally:
        core.api = original_api

    document = graphql_document()
    for resource_identifier in ("namespaceId", "queueId", "bucketName", "pipelineId"):
        assert resource_identifier not in document
    assert "sum { duration rowsRead rowsWritten }" in document
    assert "activeTime" not in document

    actual = aggregate({
        "queues": [{"sum": {"billableOperations": 30}}],
        "r2ops": [
            {"dimensions": {"actionType": "PutObject"}, "sum": {"requests": 2}},
            {"dimensions": {"actionType": "GetObject"}, "sum": {"requests": 5}},
        ],
        "r2storage": [{
            "dimensions": {"datetime": "2026-07-23T00:00:00Z"},
            "max": {"payloadSize": 100, "metadataSize": 5},
        }],
        "doInvocations": [{"sum": {"requests": 10}}],
        "doPeriodic": [{"sum": {"duration": 2.5, "rowsRead": 2, "rowsWritten": 1}}],
        "doStorage": [{"max": {"storedBytes": 50}}],
        "kvOperations": [
            {"dimensions": {"actionType": "read"}, "sum": {"requests": 7}},
            {"dimensions": {"actionType": "write"}, "sum": {"requests": 1}},
        ],
        "kvStorage": [{
            "dimensions": {"date": "2026-07-23"},
            "max": {"byteCount": 200},
        }],
        "pipelineOperators": [{"sum": {"bytesIn": 300, "decodeErrors": 2}}],
        "pipelineSinks": [{"sum": {"uncompressedBytesWritten": 250}}],
    }, set(), set(), set(), set(), set())
    projection = projection_metadata(
        dt.datetime(2026, 7, 23, 6, 0, tzinfo=dt.timezone.utc)
    )
    projected = project_daily_allowances(actual, projection)
    assert projection["factor"] == 4
    assert projected["queueOperations"] == 120
    assert projected["doRequests"] == 40
    assert projected["doActiveGbSeconds"] == 10.0
    assert projected["doRowsRead"] == 8 and projected["doRowsWritten"] == 4
    assert projected["kvReads"] == 28 and projected["kvWrites"] == 4
    for key in _MONTHLY_OR_STATE_METRICS:
        assert projected[key] == actual[key], key
    assert projected["r2ClassAOperations"] == 2
    assert projected["pipelineTransformBytes"] == 300
    assert _durable_object_duration_gb_seconds([
        {"sum": {"activeTime": 1_000_000}},
    ]) == 0.128

    current_aggregate = core.aggregate
    try:
        core.aggregate = _ORIGINAL_AGGREGATE
        assert core.self_test() == 0
    finally:
        core.aggregate = current_aggregate
    print("account-wide projected free-tier audit self-test passed")
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    if (
        not core.TOKEN
        or not core.CONFIGS
        or not core.WORKER
        or not core.KV_BINDINGS
        or not core.DO_BINDINGS
        or not core.PIPELINE_NAMES
    ):
        raise RuntimeError(
            "Cloudflare credentials, runtime Worker, config globs, KV/DO bindings, and Pipeline names are required"
        )

    account = core.account_id()
    queue_names, buckets = core.configured_resources()
    queue_ids, namespace_ids, kv_ids, pipeline_ids = core.resource_ids(
        account, queue_names
    )
    now = dt.datetime.now(dt.timezone.utc)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = day_start.replace(day=1)
    body = core.api(f"{core.API}/graphql", {
        "query": graphql_document(),
        "variables": {
            "account": account,
            "day": day_start.date().isoformat(),
            "now": now.isoformat().replace("+00:00", "Z"),
            "monthStart": month_start.isoformat().replace("+00:00", "Z"),
        },
    })
    accounts = (((body.get("data") or {}).get("viewer") or {}).get("accounts") or [])
    if len(accounts) != 1:
        raise RuntimeError(f"Expected one GraphQL account row, got {len(accounts)}")

    actual = aggregate(
        accounts[0],
        queue_ids,
        namespace_ids,
        buckets,
        kv_ids,
        pipeline_ids,
    )
    projection = projection_metadata(now)
    usage = project_daily_allowances(actual, projection)
    violations = core.evaluate(usage)
    report = {
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "worker": core.WORKER,
        "scope": _ACCOUNT_SCOPE,
        "usageKind": "mixed-daily-projection-and-period-actual",
        "actualUsage": actual,
        "usage": usage,
        "projection": projection,
        "resourceCounts": {
            "queues": len(queue_ids),
            "durableObjectNamespaces": len(namespace_ids),
            "r2Buckets": len(buckets),
            "kvNamespaces": len(kv_ids),
            "pipelines": len(pipeline_ids),
        },
        "limits": core.LIMITS,
        "violations": violations,
        "policy": (
            "Account-wide usage capped at 80% of Cloudflare free/no-charge allowances; "
            "daily operation meters are linearly projected from UTC midnight while "
            "monthly and stored-state meters remain unprojected"
        ),
    }
    core.OUT.mkdir(parents=True, exist_ok=True)
    (core.OUT / "free-tier-usage.json").write_text(
        json.dumps(report, indent=2) + "\n",
        encoding="utf-8",
    )

    lines = [
        "## Account-wide Cloudflare free-tier 80% budgets",
        "",
        f"- Generated: `{report['generatedAt']}`",
        f"- Elapsed UTC day: `{projection['elapsedSeconds']:,}` seconds",
        f"- Daily 24-hour projection factor: `{format_factor(projection['factor'])}x`",
        "- Daily meters: projected from 00:00 UTC to 24 hours",
        "- Monthly and storage meters: unprojected observed values",
        "",
        "| Metric | Actual to date | Budget value | Basis | Limit | Status |",
        "|---|---:|---:|---|---:|---|",
    ]
    for key, limit in core.LIMITS.items():
        lines.append(
            f"| {key} | {actual[key]:,} | {usage[key]:,} | {usage_basis(key)} | "
            f"{limit:,} | {'VIOLATION' if key in violations else 'OK'} |"
        )
    summary = "\n".join(lines) + "\n"
    (core.OUT / "summary.md").write_text(summary, encoding="utf-8")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
            output.write(summary)

    print("FREE_TIER_USAGE=" + json.dumps(report, separators=(",", ":")))
    for key in violations:
        print(
            f"::error title=Cloudflare free-tier budget exceeded::"
            f"{key} actual={actual[key]} budgetValue={usage[key]} "
            f"basis={usage_basis(key)} limit={core.LIMITS[key]}"
        )
    return 1 if violations else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(
            "::error title=Cloudflare free-tier budget audit::"
            + str(error).replace("\n", " ")[:1000]
        )
        raise
