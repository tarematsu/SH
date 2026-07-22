#!/usr/bin/env python3
"""Run the free-tier audit with API-compatible, resource-scoped queries."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

CORE_PATH = Path(__file__).with_name("audit-cloudflare-free-tier-core.py")
SPEC = importlib.util.spec_from_file_location("cloudflare_free_tier_core", CORE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load free-tier audit from {CORE_PATH}")
core = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(core)

_ORIGINAL_RESOURCE_IDS = core.resource_ids
_ORIGINAL_AGGREGATE = core.aggregate
_ACTIVE_DO_IDS: tuple[str, ...] = ()
_ACTIVE_KV_IDS: tuple[str, ...] = ()


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


def resource_ids(account: str, queue_names: set[str]):
    global _ACTIVE_DO_IDS, _ACTIVE_KV_IDS
    result = _ORIGINAL_RESOURCE_IDS(account, queue_names)
    _ACTIVE_DO_IDS = tuple(sorted(result[1]))
    _ACTIVE_KV_IDS = tuple(sorted(result[2]))
    return result


def _namespace_literal(identifier: str) -> str:
    return json.dumps(str(identifier), ensure_ascii=True)


def graphql_document() -> str:
    """Query resource usage without requesting unsupported GraphQL fields.

    Current KV and Durable Object invocation/periodic datasets accept
    ``namespaceId`` as a filter but do not expose it as a dimensions field.
    Durable Object storage accepts neither the namespace filter nor namespace
    dimensions, so that account-level included-usage meter is queried once.
    """
    do_fields: list[str] = []
    for index, identifier in enumerate(_ACTIVE_DO_IDS):
        namespace = _namespace_literal(identifier)
        do_fields.extend([
            f"doInvocations{index}: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: {{date_geq: $day, date_leq: $day, namespaceId: {namespace}}}) {{ sum {{ requests }} }}",
            f"doPeriodic{index}: durableObjectsPeriodicGroups(limit: 10000, filter: {{date_geq: $day, date_leq: $day, namespaceId: {namespace}}}) {{ sum {{ activeTime rowsRead rowsWritten }} }}",
        ])

    kv_fields: list[str] = []
    for index, identifier in enumerate(_ACTIVE_KV_IDS):
        namespace = _namespace_literal(identifier)
        kv_fields.extend([
            f"kvOperations{index}: kvOperationsAdaptiveGroups(limit: 10000, filter: {{date_geq: $day, date_leq: $day, namespaceId: {namespace}}}) {{ sum {{ requests }} dimensions {{ actionType }} }}",
            f"kvStorage{index}: kvStorageAdaptiveGroups(limit: 10000, filter: {{date_geq: $day, date_leq: $day, namespaceId: {namespace}}}, orderBy: [date_DESC]) {{ max {{ keyCount byteCount }} dimensions {{ date }} }}",
        ])

    scoped = "\n        ".join(do_fields + kv_fields)
    return f"""query FreeTierBudget($account: string, $day: Date!, $now: Time!, $monthStart: Time!) {{
      viewer {{ accounts(filter: {{accountTag: $account}}) {{
        queues: queueMessageOperationsAdaptiveGroups(limit: 10000, filter: {{date_geq: $day, date_leq: $day}}) {{
          sum {{ billableOperations }} dimensions {{ queueId }}
        }}
        r2ops: r2OperationsAdaptiveGroups(limit: 10000, filter: {{datetime_geq: $monthStart, datetime_leq: $now}}) {{
          sum {{ requests }} dimensions {{ actionType bucketName }}
        }}
        r2storage: r2StorageAdaptiveGroups(limit: 10000, filter: {{datetime_geq: $monthStart, datetime_leq: $now}}, orderBy: [datetime_DESC]) {{
          max {{ payloadSize metadataSize }} dimensions {{ bucketName datetime }}
        }}
        doStorage: durableObjectsStorageGroups(limit: 10000, filter: {{date_geq: $day, date_leq: $day}}) {{
          max {{ storedBytes }}
        }}
        {scoped}
        pipelineOperators: pipelinesOperatorAdaptiveGroups(limit: 10000, filter: {{datetime_geq: $monthStart, datetime_leq: $now, streamId_neq: ""}}) {{
          sum {{ bytesIn recordsIn decodeErrors }} dimensions {{ pipelineId streamId }}
        }}
        pipelineSinks: pipelinesSinkAdaptiveGroups(limit: 10000, filter: {{datetime_geq: $monthStart, datetime_leq: $now}}) {{
          sum {{ bytesWritten uncompressedBytesWritten recordsWritten filesWritten }} dimensions {{ pipelineId sinkId }}
        }}
      }}}}
    }}"""


def _tag_namespace(groups: Any, identifier: str) -> list[dict[str, Any]]:
    tagged: list[dict[str, Any]] = []
    for group in groups or []:
        item = dict(group)
        dimensions = dict(item.get("dimensions") or {})
        dimensions["namespaceId"] = identifier
        item["dimensions"] = dimensions
        tagged.append(item)
    return tagged


def aggregate(
    row: dict[str, Any],
    queue_ids: set[str],
    namespace_ids: set[str],
    buckets: set[str],
    kv_ids: set[str],
    pipeline_ids: set[str],
) -> dict[str, Any]:
    alias_prefixes = ("doInvocations", "doPeriodic", "kvOperations", "kvStorage")
    has_scoped_aliases = any(
        key.startswith(prefix) and key != prefix
        for key in row
        for prefix in alias_prefixes
    )
    # Keep compatibility with the core module's executable self-test and older
    # fixtures that provide only the former combined keys.
    if not has_scoped_aliases:
        return _ORIGINAL_AGGREGATE(
            row, queue_ids, namespace_ids, buckets, kv_ids, pipeline_ids
        )

    normalized = dict(row)
    normalized["doInvocations"] = []
    normalized["doPeriodic"] = []
    normalized["doStorage"] = []
    normalized["kvOperations"] = []
    normalized["kvStorage"] = []

    ordered_do_ids = sorted(namespace_ids)
    for index, identifier in enumerate(ordered_do_ids):
        normalized["doInvocations"].extend(
            _tag_namespace(row.get(f"doInvocations{index}"), identifier)
        )
        normalized["doPeriodic"].extend(
            _tag_namespace(row.get(f"doPeriodic{index}"), identifier)
        )

    # durableObjectsStorageGroups exposes the account-level included-usage
    # meter without a namespace selector. Tag it once so the core aggregation
    # can retain its existing validation and maximum logic without double count.
    if ordered_do_ids:
        normalized["doStorage"].extend(
            _tag_namespace(row.get("doStorage"), ordered_do_ids[0])
        )

    for index, identifier in enumerate(sorted(kv_ids)):
        normalized["kvOperations"].extend(
            _tag_namespace(row.get(f"kvOperations{index}"), identifier)
        )
        normalized["kvStorage"].extend(
            _tag_namespace(row.get(f"kvStorage{index}"), identifier)
        )

    return _ORIGINAL_AGGREGATE(
        normalized, queue_ids, namespace_ids, buckets, kv_ids, pipeline_ids
    )


core.paginated = paginated
core.resource_ids = resource_ids
core.graphql_document = graphql_document
core.aggregate = aggregate


def self_test() -> int:
    global _ACTIVE_DO_IDS, _ACTIVE_KV_IDS
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

    _ACTIVE_DO_IDS = ("do-own",)
    _ACTIVE_KV_IDS = ("kv-own",)
    document = graphql_document()
    assert 'namespaceId: "do-own"' in document
    assert 'namespaceId: "kv-own"' in document
    assert "dimensions { namespaceId" not in document
    assert "doStorage: durableObjectsStorageGroups" in document
    storage_fragment = document.split("doStorage:", 1)[1].split("doInvocations0:", 1)[0]
    assert "namespaceId" not in storage_fragment
    assert "dimensions { actionType }" in document
    assert "dimensions { date }" in document

    usage = aggregate({
        "queues": [],
        "r2ops": [],
        "r2storage": [],
        "doInvocations0": [{"sum": {"requests": 10}}],
        "doPeriodic0": [{"sum": {"activeTime": 1000, "rowsRead": 2, "rowsWritten": 1}}],
        "doStorage": [{"max": {"storedBytes": 50}}],
        "kvOperations0": [
            {"dimensions": {"actionType": "read"}, "sum": {"requests": 7}},
            {"dimensions": {"actionType": "write"}, "sum": {"requests": 1}},
        ],
        "kvStorage0": [{"dimensions": {"date": "2026-07-22"}, "max": {"byteCount": 200}}],
        "pipelineOperators": [],
        "pipelineSinks": [],
    }, set(), {"do-own"}, set(), {"kv-own"}, set())
    assert usage["doRequests"] == 10
    assert usage["doRowsRead"] == 2 and usage["doRowsWritten"] == 1
    assert usage["doStoredBytes"] == 50 and usage["doActiveGbSeconds"] == 0.128
    assert usage["kvReads"] == 7 and usage["kvWrites"] == 1
    assert usage["kvStoredBytes"] == 200

    assert core.self_test() == 0
    print("free-tier compatibility wrapper self-test passed")
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    return core.main()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(
            "::error title=Cloudflare free-tier budget audit::"
            + str(error).replace("\n", " ")[:1000]
        )
        raise
