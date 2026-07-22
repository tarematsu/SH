#!/usr/bin/env python3
"""Audit only Worker versions that are actively serving traffic."""

from __future__ import annotations

import importlib.util
import json
import sys
import urllib.parse
from pathlib import Path
from typing import Any, Iterable

SCRIPT_DIR = Path(__file__).resolve().parent
AUDIT_PATH = SCRIPT_DIR / "audit-cloudflare-telemetry.py"
SPEC = importlib.util.spec_from_file_location("cloudflare_telemetry_audit", AUDIT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load telemetry audit from {AUDIT_PATH}")
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def deployment_versions(response: dict[str, Any]) -> tuple[str, set[str]]:
    result = response.get("result") if isinstance(response, dict) else None
    deployments = result.get("deployments") if isinstance(result, dict) else None
    if not isinstance(deployments, list) or not deployments:
        raise RuntimeError("Cloudflare returned no active Worker deployment")
    deployment = deployments[0]
    if not isinstance(deployment, dict):
        raise RuntimeError("Cloudflare returned an invalid active Worker deployment")
    active = {
        str(item.get("version_id") or "")
        for item in deployment.get("versions") or []
        if isinstance(item, dict)
        and float(item.get("percentage") or 0) > 0
        and str(item.get("version_id") or "")
    }
    if not active:
        raise RuntimeError("Cloudflare active Worker deployment has no traffic-bearing version")
    return str(deployment.get("id") or ""), active


def active_deployments(account: str) -> tuple[dict[str, set[str]], dict[str, str]]:
    versions: dict[str, set[str]] = {}
    deployment_ids: dict[str, str] = {}
    for worker in audit.WORKERS:
        encoded = urllib.parse.quote(worker, safe="")
        response = audit.request_json(
            f"{audit.API_BASE}/accounts/{account}/workers/scripts/{encoded}/deployments"
        )
        deployment_id, active = deployment_versions(response)
        versions[worker] = active
        deployment_ids[worker] = deployment_id
    return versions, deployment_ids


def deployed_current_events(
    persisted: list[dict[str, Any]],
    live: list[dict[str, Any]],
    active: dict[str, set[str]],
) -> tuple[list[dict[str, Any]], dict[str, str], int]:
    selected_persisted: list[dict[str, Any]] = []
    persisted_invocations = 0
    selected_invocations = 0
    for event in persisted:
        worker = audit.worker_name(event)
        cpu_ms = audit.detail(event)["cpu_ms"]
        if cpu_ms is not None:
            persisted_invocations += 1
        if worker not in audit.WORKERS:
            continue
        version = audit.version_id(event)
        if version and version in active.get(worker, set()):
            selected_persisted.append(event)
            if cpu_ms is not None:
                selected_invocations += 1

    selected_live: list[dict[str, Any]] = []
    for event in live:
        worker = audit.worker_name(event)
        if worker not in audit.WORKERS:
            continue
        version = audit.version_id(event)
        if not version or version in active.get(worker, set()):
            selected_live.append(event)

    labels = {worker: ",".join(sorted(active.get(worker, set()))) for worker in audit.WORKERS}
    return (
        audit.merge_events(selected_persisted, selected_live),
        labels,
        persisted_invocations - selected_invocations,
    )


def self_test() -> int:
    response = {
        "result": {
            "deployments": [{
                "id": "deployment-1",
                "versions": [
                    {"version_id": "v2", "percentage": 90},
                    {"version_id": "v3", "percentage": 10},
                    {"version_id": "v1", "percentage": 0},
                ],
            }]
        }
    }
    deployment_id, active = deployment_versions(response)
    assert deployment_id == "deployment-1"
    assert active == {"v2", "v3"}

    old_late = {
        "timestamp": "2026-07-22T02:00:00Z",
        "$metadata": {"id": "old-late", "service": "a"},
        "$workers": {"scriptVersion": {"id": "v1"}, "cpuTimeMs": 99, "outcome": "ok"},
    }
    current_early = {
        "timestamp": "2026-07-22T01:00:00Z",
        "$metadata": {"id": "current-early", "service": "a"},
        "$workers": {"scriptVersion": {"id": "v2"}, "cpuTimeMs": 4, "outcome": "ok"},
    }
    weighted = {
        "timestamp": "2026-07-22T01:01:00Z",
        "$metadata": {"id": "weighted", "service": "a"},
        "$workers": {"scriptVersion": {"id": "v3"}, "cpuTimeMs": 5, "outcome": "ok"},
    }
    live_without_version = {
        "timestamp": "2026-07-22T01:02:00Z",
        "$metadata": {"id": "live", "service": "a"},
        "$workers": {"cpuTimeMs": 6, "outcome": "ok"},
        "_diagnostic_source": "live_tail",
    }
    original = audit.WORKERS
    audit.WORKERS = ("a",)
    try:
        selected, labels, excluded = deployed_current_events(
            [old_late, current_early, weighted],
            [live_without_version],
            {"a": {"v2", "v3"}},
        )
        assert labels == {"a": "v2,v3"}
        assert excluded == 1
        assert {audit.event_key(event) for event in selected} == {"current-early", "weighted", "live"}
        violations, _, errors, samples, missing, coverage = audit.evaluate(selected, False)
        assert not violations and not errors
        assert samples["a"] == [4.0, 5.0, 6.0]
        assert not missing and coverage
    finally:
        audit.WORKERS = original
    print("deployed telemetry audit self-test passed")
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    if not audit.TOKEN or not audit.WORKERS:
        raise RuntimeError("Cloudflare token and Worker list are required")
    account = audit.account_id()
    active, deployment_ids = active_deployments(account)
    print("ACTIVE_WORKER_DEPLOYMENTS=" + json.dumps({
        worker: {
            "deployment_id": deployment_ids[worker],
            "version_ids": sorted(active[worker]),
        }
        for worker in audit.WORKERS
    }, separators=(",", ":")))
    audit.current_events = lambda persisted, live: deployed_current_events(persisted, live, active)
    return audit.main()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"::error title=Cloudflare deployed-version telemetry audit::{str(error).replace(chr(10), ' ')[:1000]}")
        raise
