#!/usr/bin/env python3
"""Enforce UTC daily Worker request and D1 row budgets with one GraphQL query."""

from __future__ import annotations

import datetime as dt
import glob
import json
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
DB_RE = re.compile(r'"database_id"\s*:\s*"([0-9a-fA-F-]{36})"')


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


def database_ids() -> set[str]:
    ids: set[str] = set()
    files = 0
    for pattern in CONFIGS:
        for name in glob.glob(pattern, recursive=True):
            path = Path(name)
            if path.is_file():
                files += 1
                ids.update(match.group(1).lower() for match in DB_RE.finditer(path.read_text(errors="replace")))
    if not files or not ids:
        raise RuntimeError("D1_CONFIG_GLOBS did not resolve any database_id")
    return ids


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


def aggregate(row: dict[str, Any], workers: tuple[str, ...], dbs: set[str]) -> dict[str, Any]:
    per_worker = {}
    errors = {}
    for index, worker in enumerate(workers):
        groups = row.get(f"w{index}") or []
        per_worker[worker] = sum(number((x.get("sum") or {}).get("requests")) for x in groups)
        errors[worker] = sum(number((x.get("sum") or {}).get("errors")) for x in groups)
    reads = writes = 0
    for group in row.get("d1") or []:
        dimensions = group.get("dimensions") or {}
        if str(dimensions.get("databaseId") or "").lower() not in dbs:
            continue
        sums = group.get("sum") or {}
        reads += number(sums.get("rowsRead"))
        writes += number(sums.get("rowsWritten"))
    measured = sum(per_worker.values())
    return {
        "requests": measured,
        "measuredRequests": measured,
        "requestReserve": 0,
        "rowsRead": reads,
        "rowsWritten": writes,
        "perWorkerRequests": per_worker,
        "perWorkerErrors": errors,
        "databaseCount": len(dbs),
    }


def apply_request_reserve(usage: dict[str, Any], reserve: int) -> dict[str, Any]:
    result = dict(usage)
    result["requestReserve"] = max(0, reserve)
    result["requests"] = number(result.get("measuredRequests")) + result["requestReserve"]
    return result


def evaluate(usage: dict[str, Any], limits: dict[str, int]) -> list[str]:
    return [key for key in ("requests", "rowsRead", "rowsWritten") if usage[key] >= limits[key]]


def self_test() -> int:
    text, variables = query(("a", "b"))
    assert text.count("workersInvocationsAdaptive") == 2
    assert variables == {"w0": "a", "w1": "b"}
    usage = aggregate(
        {
            "w0": [{"sum": {"requests": 10, "errors": 1}}],
            "w1": [{"sum": {"requests": 20, "errors": 0}}],
            "d1": [
                {"dimensions": {"databaseId": "x"}, "sum": {"rowsRead": 50, "rowsWritten": 2}},
                {"dimensions": {"databaseId": "other"}, "sum": {"rowsRead": 999, "rowsWritten": 999}},
            ],
        },
        ("a", "b"),
        {"x"},
    )
    usage = apply_request_reserve(usage, 5)
    assert usage["measuredRequests"] == 30 and usage["requests"] == 35
    assert usage["rowsRead"] == 50 and usage["rowsWritten"] == 2
    assert evaluate(usage, {"requests": 36, "rowsRead": 51, "rowsWritten": 3}) == []
    assert evaluate(usage, {"requests": 35, "rowsRead": 50, "rowsWritten": 2}) == [
        "requests", "rowsRead", "rowsWritten"
    ]
    print("daily budget self-test passed")
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    if not TOKEN or not WORKERS or not CONFIGS or any(value <= 0 for value in LIMITS.values()):
        raise RuntimeError("Cloudflare credentials, Workers, D1 config globs and positive budgets are required")

    account = account_id()
    dbs = database_ids()
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
    usage = apply_request_reserve(aggregate(accounts[0], WORKERS, dbs), REQUEST_RESERVE)
    violations = evaluate(usage, LIMITS)
    report = {
        "date": date,
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "usage": usage,
        "limits": LIMITS,
        "violations": violations,
        "source": "one Cloudflare GraphQL request plus configured request reserve",
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "daily-usage.json").write_text(json.dumps(report, indent=2) + "\n")

    labels = {"requests": "Worker and Pages requests", "rowsRead": "D1 rows read", "rowsWritten": "D1 rows written"}
    lines = [
        "## Cloudflare UTC daily budgets", "",
        f"- Date: `{date}`", f"- D1 databases: `{len(dbs)}`", "- Collection: one GraphQL request",
        f"- Measured Worker requests: `{usage['measuredRequests']:,}`",
        f"- Additional request reserve: `{usage['requestReserve']:,}`", "",
        "| Metric | Usage | Limit | Headroom | Status |", "|---|---:|---:|---:|---|",
    ]
    for key in ("requests", "rowsRead", "rowsWritten"):
        actual, limit = usage[key], LIMITS[key]
        lines.append(
            f"| {labels[key]} | {actual:,} | {limit:,} | {max(0, limit - actual):,} | "
            f"{'VIOLATION' if key in violations else 'OK'} |"
        )
    summary = "\n".join(lines) + "\n"
    (OUT / "summary.md").write_text(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
            output.write(summary)
    print("DAILY_USAGE=" + json.dumps(report, separators=(",", ":")))
    for key in violations:
        print(f"::error title=Cloudflare daily budget exceeded::{labels[key]}={usage[key]} limit={LIMITS[key]}")
    return 1 if violations else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"::error title=Cloudflare daily budget audit::{str(error).replace(chr(10), ' ')[:1000]}")
        raise
