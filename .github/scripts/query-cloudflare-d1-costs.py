#!/usr/bin/env python3
"""Collect sanitized per-query D1 costs from Cloudflare GraphQL analytics."""

from __future__ import annotations

import datetime as dt
import glob
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

API = "https://api.cloudflare.com/client/v4/graphql"
REST_API = "https://api.cloudflare.com/client/v4"
TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
CONFIGS = tuple(x.strip() for x in os.environ.get("D1_CONFIG_GLOBS", "worker/wrangler*.jsonc").split(",") if x.strip())
LOOKBACK_MINUTES = max(15, min(31 * 24 * 60, int(os.environ.get("D1_QUERY_LOOKBACK_MINUTES", "1440"))))
LIMIT = max(1, min(100, int(os.environ.get("D1_QUERY_LIMIT", "30"))))
OUT = Path(os.environ.get("D1_QUERY_OUTPUT_DIR", "d1-query-costs"))
DB_RE = re.compile(
    r'"database_name"\s*:\s*"([^"]+)"[\s\S]{0,400}?"database_id"\s*:\s*"([0-9a-fA-F-]{36})"'
)
STRING_RE = re.compile(r"'(?:''|[^'])*'")
HEX_RE = re.compile(r"\b(?:0x)?[0-9a-fA-F]{24,}\b")

ORDERS = {
    "rowsRead": "sum_rowsRead_DESC",
    "rowsWritten": "sum_rowsWritten_DESC",
    "count": "count_DESC",
}


def graphql_document(order: str, limit: int) -> str:
    if order not in ORDERS.values():
        raise ValueError(f"Unsupported D1 query order: {order}")
    return f"""query D1QueryCosts($account: string, $filter: ZoneWorkersRequestsFilter_InputObject) {{
      viewer {{ accounts(filter: {{accountTag: $account}}) {{
        d1QueriesAdaptiveGroups(limit: {limit}, filter: $filter, orderBy: [{order}]) {{
          sum {{ queryDurationMs rowsRead rowsWritten rowsReturned }}
          avg {{ queryDurationMs rowsRead rowsWritten rowsReturned }}
          count
          dimensions {{ query }}
        }}
      }} }}
    }}"""


def sanitize_query(value: Any) -> str:
    query = re.sub(r"\s+", " ", str(value or "")).strip()
    query = STRING_RE.sub("'?'", query)
    query = HEX_RE.sub("?", query)
    return query[:800]


def number(value: Any) -> float:
    try:
        parsed = float(value or 0)
        return max(0, parsed)
    except (TypeError, ValueError):
        return 0


def databases() -> dict[str, str]:
    result: dict[str, str] = {}
    for pattern in CONFIGS:
        for name in glob.glob(pattern, recursive=True):
            path = Path(name)
            if not path.is_file():
                continue
            for match in DB_RE.finditer(path.read_text(errors="replace")):
                result[match.group(2).lower()] = match.group(1)
    if not result:
        raise RuntimeError("D1_CONFIG_GLOBS did not resolve any database bindings")
    return result


def account_id() -> str:
    if ACCOUNT:
        return ACCOUNT
    req = urllib.request.Request(
        f"{REST_API}/accounts?per_page=50",
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1200]
        raise RuntimeError(f"Cloudflare account discovery HTTP {error.code}: {detail}") from error
    rows = body.get("result") or []
    if body.get("success") is False or len(rows) != 1:
        raise RuntimeError(f"Expected one accessible Cloudflare account, got {len(rows)}")
    return str(rows[0]["id"])


def request(document: str, variables: dict[str, Any]) -> list[dict[str, Any]]:
    payload = json.dumps({"query": document, "variables": variables}, separators=(",", ":")).encode()
    req = urllib.request.Request(
        API,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "github-actions-d1-query-costs",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1200]
        raise RuntimeError(f"Cloudflare GraphQL HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Cloudflare GraphQL request failed: {error.reason}") from error
    if body.get("errors"):
        raise RuntimeError(f"Cloudflare GraphQL error: {json.dumps(body['errors'])[:1200]}")
    accounts = (((body.get("data") or {}).get("viewer") or {}).get("accounts") or [])
    if len(accounts) != 1:
        raise RuntimeError(f"Expected one GraphQL account row, got {len(accounts)}")
    return accounts[0].get("d1QueriesAdaptiveGroups") or []


def normalized_row(database: str, raw: dict[str, Any]) -> dict[str, Any] | None:
    raw_query = str((raw.get("dimensions") or {}).get("query") or "").strip()
    if not raw_query:
        return None
    sums, averages = raw.get("sum") or {}, raw.get("avg") or {}
    rows_read = number(sums.get("rowsRead"))
    rows_returned = number(sums.get("rowsReturned"))
    return {
        "database": database,
        "fingerprint": hashlib.sha256(raw_query.encode()).hexdigest()[:12],
        "query": sanitize_query(raw_query),
        "rowsRead": round(rows_read),
        "rowsWritten": round(number(sums.get("rowsWritten"))),
        "rowsReturned": round(rows_returned),
        "totalDurationMs": round(number(sums.get("queryDurationMs")), 3),
        "avgRowsRead": round(number(averages.get("rowsRead")), 3),
        "avgRowsWritten": round(number(averages.get("rowsWritten")), 3),
        "avgDurationMs": round(number(averages.get("queryDurationMs")), 3),
        "count": round(number(raw.get("count"))),
        "efficiency": round(rows_returned / rows_read, 6) if rows_read else 0,
    }


def markdown(report: dict[str, Any]) -> str:
    lines = [
        "## D1 query cost insights", "",
        f"- Window: `{report['window']['start']}` to `{report['window']['end']}`",
        f"- Databases: `{report['databaseCount']}`",
        f"- GraphQL requests: `{report['graphqlRequests']}`", "",
    ]
    for key, label in (("rowsRead", "Rows read"), ("rowsWritten", "Rows written"), ("count", "Executions")):
        lines.extend([
            f"### Top by {label.lower()}", "",
            "| DB | Fingerprint | Rows read | Rows written | Runs | Avg ms | Efficiency | Query |",
            "|---|---|---:|---:|---:|---:|---:|---|",
        ])
        for row in report["top"][key][:15]:
            query = row["query"].replace("|", "\\|")
            lines.append(
                f"| {row['database']} | `{row['fingerprint']}` | {row['rowsRead']:,} | "
                f"{row['rowsWritten']:,} | {row['count']:,} | {row['avgDurationMs']:,.3f} | "
                f"{row['efficiency']:.4f} | `{query}` |"
            )
        lines.append("")
    return "\n".join(lines)


def self_test() -> int:
    document = graphql_document("sum_rowsRead_DESC", 30)
    assert "d1QueriesAdaptiveGroups" in document and "sum_rowsRead_DESC" in document
    sanitized = sanitize_query(" SELECT *  FROM events WHERE token = 'secret-value' AND id = abcdef1234567890abcdef1234567890 ")
    assert "secret-value" not in sanitized and "abcdef123456" not in sanitized
    row = normalized_row("db", {
        "dimensions": {"query": "SELECT * FROM events WHERE id = ?"},
        "sum": {"rowsRead": 10, "rowsReturned": 2, "rowsWritten": 0, "queryDurationMs": 5},
        "avg": {"rowsRead": 5, "rowsWritten": 0, "queryDurationMs": 2.5},
        "count": 2,
    })
    assert row and row["efficiency"] == 0.2 and row["count"] == 2
    print("D1 query cost self-test passed")
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    if not TOKEN:
        raise RuntimeError("CLOUDFLARE_API_TOKEN is required")

    now = dt.datetime.now(dt.timezone.utc)
    start = now - dt.timedelta(minutes=LOOKBACK_MINUTES)
    dbs = databases()
    account = account_id()
    rows: dict[tuple[str, str], dict[str, Any]] = {}
    requests = 0
    for database_id, database_name in sorted(dbs.items(), key=lambda item: item[1]):
        filter_value = {
            "AND": [{
                "datetimeHour_geq": start.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "datetimeHour_leq": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "databaseId": database_id,
            }]
        }
        for order in ORDERS.values():
            requests += 1
            for raw in request(graphql_document(order, LIMIT), {"account": account, "filter": filter_value}):
                row = normalized_row(database_name, raw)
                if row:
                    rows[(database_name, row["fingerprint"])] = row

    values = list(rows.values())
    report = {
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "window": {
            "start": start.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "end": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "minutes": LOOKBACK_MINUTES,
        },
        "databaseCount": len(dbs),
        "graphqlRequests": requests,
        "queryCount": len(values),
        "top": {
            key: sorted(values, key=lambda row: row[key], reverse=True)[:LIMIT]
            for key in ("rowsRead", "rowsWritten", "count")
        },
        "privacy": "Bound parameters are omitted by Cloudflare; SQL string literals and long hex values are additionally redacted.",
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "query-costs.json").write_text(json.dumps(report, indent=2) + "\n")
    summary = markdown(report)
    (OUT / "summary.md").write_text(summary + "\n")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
            output.write(summary + "\n")
    print(summary)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"::error title=D1 query cost collection::{str(error).replace(chr(10), ' ')[:1000]}")
        raise
