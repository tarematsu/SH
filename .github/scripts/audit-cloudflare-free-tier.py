#!/usr/bin/env python3
"""Run the free-tier audit against account-wide included-usage meters."""

from __future__ import annotations

import importlib.util
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
    """Query the same account-wide meters that Cloudflare applies to allowances."""
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
          sum { activeTime rowsRead rowsWritten }
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


def aggregate(
    row: dict[str, Any],
    _queue_ids: set[str],
    _namespace_ids: set[str],
    _buckets: set[str],
    _kv_ids: set[str],
    _pipeline_ids: set[str],
) -> dict[str, Any]:
    """Normalize account-wide groups into the existing validated aggregator."""
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
    return _ORIGINAL_AGGREGATE(
        normalized,
        account,
        account,
        account,
        account,
        account,
    )


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
    for resource_identifier in (
        "namespaceId",
        "queueId",
        "bucketName",
        "pipelineId",
    ):
        assert resource_identifier not in document
    assert "dimensions { actionType }" in document
    assert "dimensions { datetime }" in document
    assert "dimensions { date }" in document

    usage = aggregate({
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
        "doPeriodic": [{"sum": {"activeTime": 1000, "rowsRead": 2, "rowsWritten": 1}}],
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
    assert usage["queueOperations"] == 30
    assert usage["r2ClassAOperations"] == 2 and usage["r2ClassBOperations"] == 5
    assert usage["r2StoredBytes"] == 105
    assert usage["doRequests"] == 10
    assert usage["doRowsRead"] == 2 and usage["doRowsWritten"] == 1
    assert usage["doStoredBytes"] == 50 and usage["doActiveGbSeconds"] == 0.128
    assert usage["kvReads"] == 7 and usage["kvWrites"] == 1
    assert usage["kvStoredBytes"] == 200
    assert usage["pipelineTransformBytes"] == 300
    assert usage["pipelineSinkBytes"] == 250
    assert usage["pipelineDecodeErrors"] == 2

    assert core.self_test() == 0
    print("account-wide free-tier audit self-test passed")
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
