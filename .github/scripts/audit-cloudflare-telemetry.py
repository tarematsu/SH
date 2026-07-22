#!/usr/bin/env python3
"""Audit deployed Worker telemetry using Cloudflare's enforced CPU outcomes."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

CORE_PATH = Path(__file__).with_name("audit-cloudflare-telemetry-core.py")
SPEC = importlib.util.spec_from_file_location("cloudflare_telemetry_core", CORE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load telemetry audit from {CORE_PATH}")
core = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(core)

# Preserve the original module API because the deployed-version selector imports
# this file and replaces current_events at runtime.
for _name in dir(core):
    if not _name.startswith("__"):
        globals()[_name] = getattr(core, _name)

_CORE_EVALUATE = core.evaluate
_CORE_EXEMPT = core.exempt
WORKERS = core.WORKERS


def _sync_runtime_overrides() -> None:
    core.WORKERS = globals().get("WORKERS", core.WORKERS)
    core.current_events = globals().get("current_events", core.current_events)


def platform_flexible_cpu_exempt(event: dict[str, Any]) -> bool:
    """Do not fail successful invocations for tolerated CPU sampling overages.

    Workers Free has a 10 ms target, but Cloudflare explicitly allows infrequent
    overages and exposes an exceededCpu outcome when the platform actually
    terminates an invocation. Successful over-budget samples remain visible as
    exemptions; terminal CPU outcomes still fail through both CPU and error gates.
    """
    _, workers = core.fields(event)
    outcome = str(workers.get("outcome") or "").lower()
    if outcome in core.OK_OUTCOMES:
        return True
    return _CORE_EXEMPT(event)


def evaluate(events, truncated):
    _sync_runtime_overrides()
    original_exempt = core.exempt
    try:
        core.exempt = platform_flexible_cpu_exempt
        return _CORE_EVALUATE(events, truncated)
    finally:
        core.exempt = original_exempt


core.evaluate = evaluate


def self_test() -> int:
    original_workers = WORKERS
    globals()["WORKERS"] = ("a",)
    try:
        successful_overage = {
            "timestamp": "2026-07-23T00:00:00Z",
            "$metadata": {"id": "ok-overage", "service": "a"},
            "$workers": {"scriptVersion": {"id": "v1"}, "cpuTimeMs": 12, "outcome": "ok"},
        }
        terminal_overage = {
            "timestamp": "2026-07-23T00:01:00Z",
            "$metadata": {"id": "cpu-failed", "service": "a"},
            "$workers": {
                "scriptVersion": {"id": "v1"},
                "cpuTimeMs": 12,
                "outcome": "exceededCpu",
            },
        }
        violations, exempted, errors, samples, missing, coverage = evaluate(
            [successful_overage], False
        )
        assert not violations and len(exempted) == 1 and not errors
        assert samples["a"] == [12.0] and not missing and coverage

        violations, exempted, errors, _, _, _ = evaluate([terminal_overage], False)
        assert len(violations) == 1 and not exempted and len(errors) == 1
    finally:
        globals()["WORKERS"] = original_workers
        core.WORKERS = original_workers
    print("platform-aware telemetry audit self-test passed")
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    _sync_runtime_overrides()
    core.evaluate = evaluate
    return core.main()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(
            "::error title=Cloudflare Telemetry audit::"
            + str(error).replace("\n", " ")[:1000]
        )
        raise
