#!/usr/bin/env python3
"""Enforce repository-scoped Cloudflare usage at 80% of included limits."""

from __future__ import annotations

import datetime as dt
import glob
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

API = "https://api.cloudflare.com/client/v4"
TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
WORKER = os.environ.get("CLOUDFLARE_RUNTIME_WORKER", "sh-runtime-orchestrator").strip()
CONFIGS = tuple(x.strip() for x in os.environ.get("CLOUDFLARE_CONFIG_GLOBS", "").split(",") if x.strip())
EXTRA_BUCKETS = tuple(x.strip() for x in os.environ.get("CLOUDFLARE_STORAGE_BUCKETS", "").split(",") if x.strip())
KV_BINDINGS = tuple(x.strip() for x in os.environ.get("CLOUDFLARE_KV_BINDINGS", "").split(",") if x.strip())
PIPELINE_NAMES = tuple(x.strip() for x in os.environ.get("CLOUDFLARE_PIPELINE_NAMES", "").split(",") if x.strip())
OUT = Path(os.environ.get("FREE_TIER_USAGE_OUTPUT_DIR", "free-tier-usage"))
GB = 1_000_000_000

LIMITS = {
    "queueOperations": 8_000,
    "doRequests": 80_000,
    "doActiveGbSeconds": 10_400.0,
    "doRowsRead": 4_000_000,
    "doRowsWritten": 80_000,
    "doStoredBytes": 4 * GB,
    "r2ClassAOperations": 800_000,
    "r2ClassBOperations": 8_000_000,
    "r2StoredBytes": 8 * GB,
    "kvReads": 80_000,
    "kvWrites": 800,
    "kvDeletes": 800,
    "kvLists": 800,
    "kvStoredBytes": 800_000_000,
    # Repository policy: cap each monthly Pipelines billing meter at 80% of
    # the user-specified 1 GB no-charge allowance.
    "pipelineTransformBytes": 800_000_000,
    "pipelineSinkBytes": 800_000_000,
}

R2_CLASS_A = frozenset(x.lower() for x in (
    "ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject",
    "CompleteMultipartUpload", "CreateMultipartUpload", "LifecycleStorageTierTransition",
    "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts",
    "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration",
))
R2_CLASS_B = frozenset(x.lower() for x in (
    "HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption",
    "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration",
))


def api(url: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=None if payload is None else json.dumps(payload, separators=(",", ":")).encode(),
        method="POST" if payload is not None else "GET",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "github-actions-cloudflare-free-tier-budget",
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


def configured_resources() -> tuple[set[str], set[str]]:
    queues: set[str] = set()
    buckets = set(EXTRA_BUCKETS)
    files = 0
    for pattern in CONFIGS:
        for name in glob.glob(pattern, recursive=True):
            path = Path(name)
            if not path.is_file():
                continue
            files += 1
            config = json.loads(path.read_text(encoding="utf-8"))
            queue_config = config.get("queues") or {}
            queues.update(str(row["queue"]) for row in queue_config.get("consumers") or [] if row.get("queue"))
            queues.update(str(row["dead_letter_queue"]) for row in queue_config.get("consumers") or [] if row.get("dead_letter_queue"))
            queues.update(str(row["queue"]) for row in queue_config.get("producers") or [] if row.get("queue"))
            buckets.update(str(row["bucket_name"]) for row in config.get("r2_buckets") or [] if row.get("bucket_name"))
    if not files or not queues or not buckets:
        raise RuntimeError("CLOUDFLARE_CONFIG_GLOBS did not resolve repository Queue and R2 resources")
    return queues, buckets


def paginated(account: str, path: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    page = 1
    while True:
        separator = "&" if "?" in path else "?"
        body = api(f"{API}/accounts/{account}/{path}{separator}per_page=100&page={page}")
        batch = body.get("result") or []
        rows.extend(batch)
        info = body.get("result_info") or {}
        if page >= int(info.get("total_pages") or 1) or not batch:
            return rows
        page += 1


def resource_ids(account: str, queue_names: set[str]) -> tuple[set[str], set[str], set[str], set[str]]:
    queue_rows = paginated(account, "queues")
    queue_ids = {
        str(row.get("queue_id") or row.get("id"))
        for row in queue_rows if str(row.get("queue_name") or row.get("name")) in queue_names
    }
    missing = queue_names - {
        str(row.get("queue_name") or row.get("name")) for row in queue_rows
    }
    if missing:
        raise RuntimeError(f"Configured Queues missing from Cloudflare: {', '.join(sorted(missing))}")

    namespaces = paginated(account, "workers/durable_objects/namespaces")
    namespace_ids = set()
    for row in namespaces:
        script = str(row.get("script") or row.get("script_name") or row.get("worker") or "")
        class_name = str(row.get("class") or row.get("class_name") or row.get("name") or "")
        if script == WORKER or class_name == "RuntimeCoordinator":
            identifier = row.get("id") or row.get("namespace_id")
            if identifier:
                namespace_ids.add(str(identifier))
    if not namespace_ids:
        raise RuntimeError(f"No Durable Object namespace resolved for {WORKER}")

    worker_settings = api(f"{API}/accounts/{account}/workers/scripts/{urllib.parse.quote(WORKER, safe='')}/settings").get("result") or {}
    bindings = worker_settings.get("bindings") or []
    kv_ids = {
        str(row.get("namespace_id") or row.get("id"))
        for row in bindings
        if str(row.get("name") or "") in KV_BINDINGS
        and str(row.get("type") or "") in {"kv_namespace", "kv_namespace_text"}
        and (row.get("namespace_id") or row.get("id"))
    }
    missing_kv = set(KV_BINDINGS) - {
        str(row.get("name") or "") for row in bindings if str(row.get("type") or "") in {"kv_namespace", "kv_namespace_text"}
    }
    if missing_kv or not kv_ids:
        raise RuntimeError(f"Configured KV bindings missing from deployed Worker: {', '.join(sorted(missing_kv))}")

    pipeline_ids: set[str] = set()
    if PIPELINE_NAMES:
        pipeline_rows = paginated(account, "pipelines/v1/pipelines")
        # The provisioning helper also supports legacy Pipelines. Only query
        # that endpoint when the v1 list did not resolve every configured name.
        resolved_names = {str(row.get("name") or "") for row in pipeline_rows}
        if set(PIPELINE_NAMES) - resolved_names:
            pipeline_rows.extend(paginated(account, "pipelines"))
        pipeline_ids = {
            str(row.get("id") or row.get("pipeline_id"))
            for row in pipeline_rows
            if str(row.get("name") or row.get("pipeline_name") or "") in PIPELINE_NAMES
            and (row.get("id") or row.get("pipeline_id"))
        }
        missing_pipelines = set(PIPELINE_NAMES) - {
            str(row.get("name") or row.get("pipeline_name") or "") for row in pipeline_rows
        }
        # Pipelines is provisioned best-effort and requires Workers Paid. An
        # absent pipeline consumes zero included usage and must not block the
        # observability workflow for Free-plan deployments.
        if missing_pipelines:
            print(f"::notice title=Cloudflare Pipelines unavailable::Not provisioned: {', '.join(sorted(missing_pipelines))}")
    return queue_ids, namespace_ids, kv_ids, pipeline_ids


def graphql_document() -> str:
    return """query FreeTierBudget($account: string, $day: Date!, $now: Time!, $monthStart: Time!) {
      viewer { accounts(filter: {accountTag: $account}) {
        queues: queueMessageOperationsAdaptiveGroups(limit: 10000, filter: {date_geq: $day, date_leq: $day}) {
          sum { billableOperations } dimensions { queueId }
        }
        r2ops: r2OperationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $monthStart, datetime_leq: $now}) {
          sum { requests } dimensions { actionType bucketName }
        }
        r2storage: r2StorageAdaptiveGroups(limit: 10000, filter: {datetime_geq: $monthStart, datetime_leq: $now}, orderBy: [datetime_DESC]) {
          max { payloadSize metadataSize } dimensions { bucketName datetime }
        }
        doInvocations: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: {date_geq: $day, date_leq: $day}) {
          sum { requests } dimensions { namespaceId }
        }
        doPeriodic: durableObjectsPeriodicGroups(limit: 10000, filter: {date_geq: $day, date_leq: $day}) {
          sum { activeTime rowsRead rowsWritten } dimensions { namespaceId }
        }
        doStorage: durableObjectsStorageGroups(limit: 10000, filter: {date_geq: $day, date_leq: $day}) {
          max { storedBytes } dimensions { namespaceId }
        }
        kvOperations: kvOperationsAdaptiveGroups(limit: 10000, filter: {date_geq: $day, date_leq: $day}) {
          sum { requests } dimensions { namespaceId actionType }
        }
        kvStorage: kvStorageAdaptiveGroups(limit: 10000, filter: {date_geq: $day, date_leq: $day}, orderBy: [date_DESC]) {
          max { keyCount byteCount } dimensions { namespaceId date }
        }
        pipelineOperators: pipelinesOperatorAdaptiveGroups(limit: 10000, filter: {datetime_geq: $monthStart, datetime_leq: $now, streamId_neq: ""}) {
          sum { bytesIn recordsIn decodeErrors } dimensions { pipelineId streamId }
        }
        pipelineSinks: pipelinesSinkAdaptiveGroups(limit: 10000, filter: {datetime_geq: $monthStart, datetime_leq: $now}) {
          sum { bytesWritten uncompressedBytesWritten recordsWritten filesWritten } dimensions { pipelineId sinkId }
        }
      }}
    }"""


def number(value: Any) -> int:
    try:
        return max(0, int(float(value or 0)))
    except (TypeError, ValueError):
        return 0


def aggregate(
    row: dict[str, Any],
    queue_ids: set[str],
    namespace_ids: set[str],
    buckets: set[str],
    kv_ids: set[str],
    pipeline_ids: set[str],
) -> dict[str, Any]:
    usage: dict[str, Any] = {key: 0 for key in LIMITS}
    for group in row.get("queues") or []:
        if str((group.get("dimensions") or {}).get("queueId")) in queue_ids:
            usage["queueOperations"] += number((group.get("sum") or {}).get("billableOperations"))

    unknown_r2: set[str] = set()
    for group in row.get("r2ops") or []:
        dimensions = group.get("dimensions") or {}
        if str(dimensions.get("bucketName")) not in buckets:
            continue
        action = str(dimensions.get("actionType") or "").lower()
        requests = number((group.get("sum") or {}).get("requests"))
        if action in R2_CLASS_B:
            usage["r2ClassBOperations"] += requests
        else:
            usage["r2ClassAOperations"] += requests
            if action and action not in R2_CLASS_A:
                unknown_r2.add(action)

    latest_storage: dict[str, tuple[str, int]] = {}
    for group in row.get("r2storage") or []:
        dimensions = group.get("dimensions") or {}
        bucket = str(dimensions.get("bucketName") or "")
        if bucket not in buckets:
            continue
        timestamp = str(dimensions.get("datetime") or "")
        maximum = group.get("max") or {}
        size = number(maximum.get("payloadSize")) + number(maximum.get("metadataSize"))
        if bucket not in latest_storage or timestamp > latest_storage[bucket][0]:
            latest_storage[bucket] = (timestamp, size)
    usage["r2StoredBytes"] = sum(value[1] for value in latest_storage.values())

    for group in row.get("doInvocations") or []:
        if str((group.get("dimensions") or {}).get("namespaceId")) in namespace_ids:
            usage["doRequests"] += number((group.get("sum") or {}).get("requests"))
    active_ms = 0
    for group in row.get("doPeriodic") or []:
        if str((group.get("dimensions") or {}).get("namespaceId")) not in namespace_ids:
            continue
        sums = group.get("sum") or {}
        active_ms += number(sums.get("activeTime"))
        usage["doRowsRead"] += number(sums.get("rowsRead"))
        usage["doRowsWritten"] += number(sums.get("rowsWritten"))
    usage["doActiveGbSeconds"] = round(active_ms / 1000 * 0.128, 3)
    for group in row.get("doStorage") or []:
        if str((group.get("dimensions") or {}).get("namespaceId")) in namespace_ids:
            usage["doStoredBytes"] = max(
                usage["doStoredBytes"], number((group.get("max") or {}).get("storedBytes")),
            )

    kv_key = {"read": "kvReads", "write": "kvWrites", "delete": "kvDeletes", "list": "kvLists"}
    for group in row.get("kvOperations") or []:
        dimensions = group.get("dimensions") or {}
        if str(dimensions.get("namespaceId")) not in kv_ids:
            continue
        key = kv_key.get(str(dimensions.get("actionType") or "").lower())
        if key:
            usage[key] += number((group.get("sum") or {}).get("requests"))
    latest_kv: dict[str, tuple[str, int]] = {}
    for group in row.get("kvStorage") or []:
        dimensions = group.get("dimensions") or {}
        namespace = str(dimensions.get("namespaceId") or "")
        if namespace not in kv_ids:
            continue
        date = str(dimensions.get("date") or "")
        size = number((group.get("max") or {}).get("byteCount"))
        if namespace not in latest_kv or date > latest_kv[namespace][0]:
            latest_kv[namespace] = (date, size)
    usage["kvStoredBytes"] = sum(item[1] for item in latest_kv.values())

    pipeline_decode_errors = 0
    for group in row.get("pipelineOperators") or []:
        if str((group.get("dimensions") or {}).get("pipelineId")) not in pipeline_ids:
            continue
        sums = group.get("sum") or {}
        usage["pipelineTransformBytes"] += number(sums.get("bytesIn"))
        pipeline_decode_errors += number(sums.get("decodeErrors"))
    for group in row.get("pipelineSinks") or []:
        if str((group.get("dimensions") or {}).get("pipelineId")) in pipeline_ids:
            usage["pipelineSinkBytes"] += number((group.get("sum") or {}).get("uncompressedBytesWritten"))
    usage["pipelineDecodeErrors"] = pipeline_decode_errors
    usage["unknownR2ActionsChargedAsClassA"] = sorted(unknown_r2)
    return usage


def evaluate(usage: dict[str, Any]) -> list[str]:
    return [key for key, limit in LIMITS.items() if float(usage[key]) >= float(limit)]


def self_test() -> int:
    document = graphql_document()
    for dataset in ("queueMessageOperationsAdaptiveGroups", "r2OperationsAdaptiveGroups", "durableObjectsPeriodicGroups", "kvOperationsAdaptiveGroups", "pipelinesOperatorAdaptiveGroups", "pipelinesSinkAdaptiveGroups"):
        assert dataset in document
    usage = aggregate({
        "queues": [{"dimensions": {"queueId": "q"}, "sum": {"billableOperations": 30}}],
        "r2ops": [
            {"dimensions": {"bucketName": "b", "actionType": "PutObject"}, "sum": {"requests": 2}},
            {"dimensions": {"bucketName": "b", "actionType": "GetObject"}, "sum": {"requests": 5}},
        ],
        "r2storage": [{"dimensions": {"bucketName": "b", "datetime": "2026-01-01T00:00:00Z"}, "max": {"payloadSize": 100, "metadataSize": 5}}],
        "doInvocations": [{"dimensions": {"namespaceId": "d"}, "sum": {"requests": 10}}],
        "doPeriodic": [{"dimensions": {"namespaceId": "d"}, "sum": {"activeTime": 1000, "rowsRead": 0, "rowsWritten": 0}}],
        "doStorage": [{"dimensions": {"namespaceId": "d"}, "max": {"storedBytes": 0}}],
        "kvOperations": [
            {"dimensions": {"namespaceId": "k", "actionType": "read"}, "sum": {"requests": 7}},
            {"dimensions": {"namespaceId": "k", "actionType": "write"}, "sum": {"requests": 1}},
        ],
        "kvStorage": [{"dimensions": {"namespaceId": "k", "date": "2026-01-01"}, "max": {"byteCount": 200}}],
        "pipelineOperators": [{"dimensions": {"pipelineId": "p"}, "sum": {"bytesIn": 300, "decodeErrors": 2}}],
        "pipelineSinks": [{"dimensions": {"pipelineId": "p"}, "sum": {"uncompressedBytesWritten": 250}}],
    }, {"q"}, {"d"}, {"b"}, {"k"}, {"p"})
    assert usage["queueOperations"] == 30
    assert usage["r2ClassAOperations"] == 2 and usage["r2ClassBOperations"] == 5
    assert usage["r2StoredBytes"] == 105 and usage["doRequests"] == 10
    assert usage["doActiveGbSeconds"] == 0.128 and evaluate(usage) == []
    assert usage["kvReads"] == 7 and usage["kvWrites"] == 1 and usage["kvStoredBytes"] == 200
    assert usage["pipelineTransformBytes"] == 300 and usage["pipelineSinkBytes"] == 250
    assert usage["pipelineDecodeErrors"] == 2
    assert LIMITS["queueOperations"] == 8_000 and LIMITS["doRequests"] == 80_000
    print("free-tier budget self-test passed")
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    if not TOKEN or not CONFIGS or not WORKER or not KV_BINDINGS or not PIPELINE_NAMES:
        raise RuntimeError("Cloudflare credentials, runtime Worker, config globs, KV bindings, and Pipeline names are required")
    account = account_id()
    queue_names, buckets = configured_resources()
    queue_ids, namespace_ids, kv_ids, pipeline_ids = resource_ids(account, queue_names)
    now = dt.datetime.now(dt.timezone.utc)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = day_start.replace(day=1)
    body = api(f"{API}/graphql", {
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
    usage = aggregate(accounts[0], queue_ids, namespace_ids, buckets, kv_ids, pipeline_ids)
    violations = evaluate(usage)
    report = {
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "worker": WORKER,
        "resourceCounts": {"queues": len(queue_ids), "durableObjectNamespaces": len(namespace_ids), "r2Buckets": len(buckets), "kvNamespaces": len(kv_ids), "pipelines": len(pipeline_ids)},
        "usage": usage,
        "limits": LIMITS,
        "violations": violations,
        "policy": "80% of Cloudflare free/no-charge allowances, including the repository's 1 GB monthly Pipelines allowance",
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "free-tier-usage.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    lines = ["## Cloudflare free-tier 80% budgets", "", "| Metric | Usage | Limit | Status |", "|---|---:|---:|---|"]
    for key, limit in LIMITS.items():
        lines.append(f"| {key} | {usage[key]:,} | {limit:,} | {'VIOLATION' if key in violations else 'OK'} |")
    summary = "\n".join(lines) + "\n"
    (OUT / "summary.md").write_text(summary, encoding="utf-8")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
            output.write(summary)
    print("FREE_TIER_USAGE=" + json.dumps(report, separators=(",", ":")))
    for key in violations:
        print(f"::error title=Cloudflare free-tier budget exceeded::{key}={usage[key]} limit={LIMITS[key]}")
    return 1 if violations else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"::error title=Cloudflare free-tier budget audit::{str(error).replace(chr(10), ' ')[:1000]}")
        raise
