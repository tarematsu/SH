#!/usr/bin/env python3
"""Project partial UTC-day Worker request and D1 usage to a 24-hour budget."""

from __future__ import annotations

import datetime as dt
import glob
import json
import math
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

API = "https://api.cloudflare.com/client/v4"
TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
WORKERS = tuple(x.strip() for x in os.environ.get("CLOUDFLARE_WORKERS", "").split(",") if x.strip())
CONFIGS = tuple(x.strip() for x in os.environ.get("D1_CONFIG_GLOBS", "").split(",") if x.strip())
REQUEST_RESERVE = max(0, int(os.environ.get("DAILY_REQUEST_RESERVE", "0")))
LIMITS = {
    "requests": int(os.environ.get("DAILY_REQUEST_BUDGET", "0")),
    "rowsRead": int(os.environ.get("DAILY_D1_READ_BUDGET", "0")),
    "rowsWritten": int(os.environ.get("DAILY_D1_WRITE_BUDGET", "0")),
}
OUT = Path(os.environ.get("DAILY_USAGE_OUTPUT_DIR", "daily-usage"))
DB_OBJECT_RE = re.compile(
    r'\{[^{}]*?"database_name"\s*:\s*"([^"]+)"[^{}]*?'
    r'"database_id"\s*:\s*"([0-9a-fA-F-]{36})"[^{}]*?\}',
    re.DOTALL,
)
DAY_SECONDS = 24 * 60 * 60
PROJECTION_METHOD = "linear-from-utc-midnight"
SCOPE_NOTE = (
    "Account usage accumulated since 00:00 UTC; values include every deployment "
    "that served traffic earlier in the same UTC day."
)


def api(url: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=None if payload is None else json.dumps(payload, separators=(",", ":")).encode(),
        method="POST" if payload is not None else "GET",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "github-actions-cloudflare-budget",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1200]
        raise RuntimeError(f"Cloudflare HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Cloudflare request failed: {error.reason}") from error
    if body.get("success") is False or body.get("errors"):
        raise RuntimeError(f"Cloudflare API error: {json.dumps(body.get('errors'))[:1200]}")
    return body


def account_id() -> str:
    if ACCOUNT:
        return ACCOUNT
    rows = api(f"{API}/accounts?per_page=50").get("result") or []
    if len(rows) != 1:
        raise RuntimeError(f"Expected one Cloudflare account, got {len(rows)}")
    return str(rows[0]["id"])


def databases() -> dict[str, str]:
    configured: dict[str, str] = {}
    files = 0
    for pattern in CONFIGS:
        for name in glob.glob(pattern, recursive=True):
            path = Path(name)
            if not path.is_file():
                continue
            files += 1
            text = path.read_text(errors="replace")
            for database_name, database_id in DB_OBJECT_RE.findall(text):
                key = database_id.lower()
                existing = configured.get(key)
                if existing and existing != database_name:
                    raise RuntimeError(
                        f"D1 database_id {key} has conflicting names: {existing}, {database_name}"
                    )
                configured[key] = database_name
    if not files or not configured:
        raise RuntimeError("D1_CONFIG_GLOBS did not resolve any named database_id")
    return configured


def query(workers: tuple[str, ...]) -> tuple[str, dict[str, str]]:
    definitions = ["$account: string", "$start: string", "$end: string", "$date: Date!"]
    variables: dict[str, str] = {}
    fields = []
    for index, worker in enumerate(workers):
        key = f"w{index}"
        definitions.append(f"${key}: string")
        variables[key] = worker
        fields.append(
            f"""{key}: workersInvocationsAdaptive(limit: 1, filter: {{
              scriptName: ${key}, datetime_geq: $start, datetime_leq: $end
            }}) {{ sum {{ requests errors }} }}"""
        )
    return f"""query DailyBudget({', '.join(definitions)}) {{
      viewer {{ accounts(filter: {{accountTag: $account}}) {{
        {' '.join(fields)}
        d1: d1AnalyticsAdaptiveGroups(
          limit: 10000, filter: {{date_geq: $date, date_leq: $date}}
        ) {{ sum {{rowsRead rowsWritten}} dimensions {{databaseId}} }}
      }} }}
    }}""", variables


def number(value: Any) -> int:
    try:
        return max(0, int(float(value or 0)))
    except (TypeError, ValueError):
        return 0


def aggregate(
    row: dict[str, Any],
    workers: tuple[str, ...],
    dbs: dict[str, str],
) -> dict[str, Any]:
    per_worker: dict[str, int] = {}
    errors: dict[str, int] = {}
    for index, worker in enumerate(workers):
        groups = row.get(f"w{index}") or []
        per_worker[worker] = sum(number((x.get("sum") or {}).get("requests")) for x in groups)
        errors[worker] = sum(number((x.get("sum") or {}).get("errors")) for x in groups)
    per_database = {
        database_id: {
            "databaseId": database_id,
            "databaseName": database_name,
            "rowsRead": 0,
            "rowsWritten": 0,
        }
        for database_id, database_name in dbs.items()
    }
    for group in row.get("d1") or []:
        dimensions = group.get("dimensions") or {}
        database_id = str(dimensions.get("databaseId") or "").lower()
        if database_id not in per_database:
            continue
        sums = group.get("sum") or {}
        per_database[database_id]["rowsRead"] += number(sums.get("rowsRead"))
        per_database[database_id]["rowsWritten"] += number(sums.get("rowsWritten"))
    reads = sum(item["rowsRead"] for item in per_database.values())
    writes = sum(item["rowsWritten"] for item in per_database.values())
    measured = sum(per_worker.values())
    return {
        "requests": measured,
        "measuredRequests": measured,
        "requestReserve": 0,
        "rowsRead": reads,
        "rowsWritten": writes,
        "perWorkerRequests": per_worker,
        "perWorkerErrors": errors,
        "perDatabaseUsage": sorted(
            per_database.values(),
            key=lambda item: (-item["rowsRead"], -item["rowsWritten"], item["databaseName"]),
        ),
        "databaseCount": len(dbs),
    }


def apply_request_reserve(usage: dict[str, Any], reserve: int) -> dict[str, Any]:
    result = dict(usage)
    result["requestReserve"] = max(0, reserve)
    result["requests"] = number(result.get("measuredRequests")) + result["requestReserve"]
    return result


def projection_metadata(now: dt.datetime) -> dict[str, Any]:
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elapsed = max(1, min(DAY_SECONDS, int((now - start).total_seconds())))
    return {
        "method": PROJECTION_METHOD,
        "periodSeconds": DAY_SECONDS,
        "elapsedSeconds": elapsed,
        "factor": DAY_SECONDS / elapsed,
        "projectedMetrics": ["requests", "rowsRead", "rowsWritten"],
    }


def project_usage(actual: dict[str, Any], projection: dict[str, Any]) -> dict[str, Any]:
    factor = float(projection["factor"])
    projected = dict(actual)
    projected_per_worker = {
        worker: math.ceil(number(value) * factor)
        for worker, value in (actual.get("perWorkerRequests") or {}).items()
    }
    projected_measured = sum(projected_per_worker.values())
    projected["perWorkerRequests"] = projected_per_worker
    projected["measuredRequests"] = projected_measured
    projected["requestReserve"] = number(actual.get("requestReserve"))
    projected["requests"] = projected_measured + projected["requestReserve"]
    projected["rowsRead"] = math.ceil(number(actual.get("rowsRead")) * factor)
    projected["rowsWritten"] = math.ceil(number(actual.get("rowsWritten")) * factor)
    return projected


def evaluate(usage: dict[str, Any], limits: dict[str, int]) -> list[str]:
    return [key for key in ("requests", "rowsRead", "rowsWritten") if usage[key] >= limits[key]]


def format_factor(value: float) -> str:
    return f"{value:.3f}".rstrip("0").rstrip(".")


def short_database_id(value: str) -> str:
    return value if len(value) <= 12 else f"{value[:8]}…{value[-4:]}"


def self_test() -> int:
    text, variables = query(("a", "b"))
    assert text.count("workersInvocationsAdaptive") == 2
    assert variables == {"w0": "a", "w1": "b"}
    actual = apply_request_reserve(aggregate(
        {
            "w0": [{"sum": {"requests": 10, "errors": 1}}],
            "w1": [{"sum": {"requests": 20, "errors": 0}}],
            "d1": [
                {"dimensions": {"databaseId": "x"}, "sum": {"rowsRead": 50, "rowsWritten": 2}},
                {"dimensions": {"databaseId": "other"}, "sum": {"rowsRead": 999, "rowsWritten": 999}},
            ],
        },
        ("a", "b"),
        {"x": "primary"},
    ), 5)
    projection = projection_metadata(dt.datetime(2026, 7, 23, 6, 0, tzinfo=dt.timezone.utc))
    projected = project_usage(actual, projection)
    assert projection["elapsedSeconds"] == 21_600 and projection["factor"] == 4
    assert actual["measuredRequests"] == 30 and actual["requests"] == 35
    assert actual["perDatabaseUsage"] == [{
        "databaseId": "x",
        "databaseName": "primary",
        "rowsRead": 50,
        "rowsWritten": 2,
    }]
    assert projected["perWorkerRequests"] == {"a": 40, "b": 80}
    assert projected["measuredRequests"] == 120 and projected["requests"] == 125
    assert projected["rowsRead"] == 200 and projected["rowsWritten"] == 8
    assert evaluate(projected, {"requests": 126, "rowsRead": 201, "rowsWritten": 9}) == []
    assert evaluate(projected, {"requests": 125, "rowsRead": 200, "rowsWritten": 8}) == [
        "requests", "rowsRead", "rowsWritten"
    ]
    assert short_database_id("12345678-1234-1234-1234-123456789abc") == "12345678…9abc"
    print("daily budget self-test passed")
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    if not TOKEN or not WORKERS or not CONFIGS or any(value <= 0 for value in LIMITS.values()):
        raise RuntimeError("Cloudflare credentials, Workers, D1 config globs and positive budgets are required")

    account = account_id()
    dbs = databases()
    now = dt.datetime.now(dt.timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    date = start.date().isoformat()
    document, worker_variables = query(WORKERS)
    body = api(
        f"{API}/graphql",
        {
            "query": document,
            "variables": {
                "account": account,
                "start": start.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "end": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "date": date,
                **worker_variables,
            },
        },
    )
    accounts = (((body.get("data") or {}).get("viewer") or {}).get("accounts") or [])
    if len(accounts) != 1:
        raise RuntimeError(f"Expected one GraphQL account row, got {len(accounts)}")

    actual = apply_request_reserve(aggregate(accounts[0], WORKERS, dbs), REQUEST_RESERVE)
    projection = projection_metadata(now)
    usage = project_usage(actual, projection)
    violations = evaluate(usage, LIMITS)
    report = {
        "date": date,
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "usageKind": "projected-24h",
        "actualUsage": actual,
        "usage": usage,
        "projection": projection,
        "limits": LIMITS,
        "violations": violations,
        "scopeNote": SCOPE_NOTE,
        "source": "one Cloudflare GraphQL request, linearly projected from UTC midnight, plus configured request reserve",
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "daily-usage.json").write_text(json.dumps(report, indent=2) + "\n")

    labels = {
        "requests": "Worker and Pages requests",
        "rowsRead": "D1 rows read",
        "rowsWritten": "D1 rows written",
    }
    lines = [
        "## Cloudflare projected UTC daily budgets",
        "",
        f"- Date: `{date}`",
        f"- Generated: `{report['generatedAt']}`",
        f"- D1 databases: `{len(dbs)}`",
        "- Collection: one GraphQL request",
        f"- Scope: {SCOPE_NOTE}",
        f"- Elapsed UTC day: `{projection['elapsedSeconds']:,}` seconds",
        f"- 24-hour projection factor: `{format_factor(projection['factor'])}x`",
        f"- Actual measured Worker requests: `{actual['measuredRequests']:,}`",
        f"- Additional request reserve: `{actual['requestReserve']:,}`",
        "",
        "| Metric | Actual to date | 24h projection | Limit | Projected headroom | Status |",
        "|---|---:|---:|---:|---:|---|",
    ]
    for key in ("requests", "rowsRead", "rowsWritten"):
        observed, projected, limit = actual[key], usage[key], LIMITS[key]
        lines.append(
            f"| {labels[key]} | {observed:,} | {projected:,} | {limit:,} | "
            f"{max(0, limit - projected):,} | {'VIOLATION' if key in violations else 'OK'} |"
        )
    lines.extend([
        "",
        "### D1 database breakdown (UTC day actual)",
        "",
        "| Database | Database ID | Rows read | Rows written |",
        "|---|---|---:|---:|",
    ])
    for item in actual.get("perDatabaseUsage") or []:
        lines.append(
            f"| `{item['databaseName']}` | `{short_database_id(item['databaseId'])}` | "
            f"{item['rowsRead']:,} | {item['rowsWritten']:,} |"
        )
    summary = "\n".join(lines) + "\n"
    (OUT / "summary.md").write_text(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
            output.write(summary)
    print("DAILY_USAGE=" + json.dumps(report, separators=(",", ":")))
    for key in violations:
        print(
            f"::error title=Cloudflare projected daily budget exceeded::"
            f"{labels[key]} actual={actual[key]} projected24h={usage[key]} limit={LIMITS[key]}"
        )
    return 1 if violations else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"::error title=Cloudflare daily budget audit::{str(error).replace(chr(10), ' ')[:1000]}")
        raise
