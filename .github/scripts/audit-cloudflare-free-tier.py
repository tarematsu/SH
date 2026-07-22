#!/usr/bin/env python3
"""Run the free-tier audit with API-compatible pagination."""

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


core.paginated = paginated


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
