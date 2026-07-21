#!/usr/bin/env python3
"""Download R2 Worker logs only when all active Workers have real events."""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import json
import os
import pathlib
import shutil
import subprocess
import time
from typing import Any

ROOT = pathlib.Path.cwd()
RAW_DIR = ROOT / "raw"
OUTPUT_DIR = ROOT / "observability-logs"
OBJECTS_PATH = ROOT / "objects.json"
KEYS_PATH = ROOT / "keys.txt"
SELECTION_PATH = ROOT / "selection.json"
SUMMARY_PATH = OUTPUT_DIR / "summary.json"
ANALYZER_PATH = ROOT / ".github/scripts/analyze-worker-observability.py"
POLL_ATTEMPTS = max(1, int(os.environ.get("R2_LOG_POLL_ATTEMPTS", "10")))
POLL_SECONDS = max(1, int(os.environ.get("R2_LOG_POLL_SECONDS", "30")))
DOWNLOAD_WORKERS = 8
ACTIVE_WORKERS = tuple(
    name.strip()
    for name in os.environ.get(
        "REQUIRED_ACTIVE_WORKERS",
        "sh-buddies-ingest,sh-minute-enrichment,sh-sakurazaka46jp,sh-runtime-orchestrator",
    ).split(",")
    if name.strip()
)


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def cutoff_time() -> dt.datetime:
    since = os.environ.get("LOG_SINCE", "").strip()
    if since:
        parsed = dt.datetime.fromisoformat(since.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)
    minutes = max(1, int(os.environ.get("LOOKBACK_MINUTES", "90")))
    return dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=minutes)


def aws_json(*args: str) -> dict[str, Any]:
    completed = subprocess.run(
        ["aws", *args],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    payload = json.loads(completed.stdout or "{}")
    if not isinstance(payload, dict):
        raise RuntimeError("AWS CLI returned a non-object JSON payload")
    return payload


def list_all_objects(endpoint: str, bucket: str) -> tuple[list[dict[str, Any]], int]:
    objects: list[dict[str, Any]] = []
    continuation_token: str | None = None
    page_count = 0
    while True:
        args = [
            "s3api",
            "list-objects-v2",
            "--endpoint-url",
            endpoint,
            "--bucket",
            bucket,
            "--output",
            "json",
        ]
        if continuation_token:
            args.extend(["--continuation-token", continuation_token])
        payload = aws_json(*args)
        page_count += 1
        page_objects = payload.get("Contents") or []
        if not isinstance(page_objects, list):
            raise RuntimeError("R2 object listing returned an invalid Contents value")
        objects.extend(item for item in page_objects if isinstance(item, dict))
        if not payload.get("IsTruncated"):
            break
        next_token = str(payload.get("NextContinuationToken") or "").strip()
        if not next_token or next_token == continuation_token:
            raise RuntimeError("R2 object listing was truncated without a usable continuation token")
        continuation_token = next_token
    return objects, page_count


def list_objects(endpoint: str, bucket: str) -> list[tuple[dt.datetime, str]]:
    objects, page_count = list_all_objects(endpoint, bucket)
    OBJECTS_PATH.write_text(
        json.dumps({"Contents": objects, "pages": page_count}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    cutoff = cutoff_time()
    selected: list[tuple[dt.datetime, str]] = []
    for item in objects:
        modified = dt.datetime.fromisoformat(str(item["LastModified"]).replace("Z", "+00:00"))
        if modified >= cutoff:
            selected.append((modified, str(item["Key"])))
    selected.sort(reverse=True)
    selection = {
        "cutoff": cutoff.isoformat().replace("+00:00", "Z"),
        "objects_available": len(objects),
        "objects_selected": len(selected),
        "object_listing_pages": page_count,
        "newest_object_modified": selected[0][0].isoformat().replace("+00:00", "Z") if selected else None,
        "oldest_object_modified": selected[-1][0].isoformat().replace("+00:00", "Z") if selected else None,
    }
    SELECTION_PATH.write_text(json.dumps(selection, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    KEYS_PATH.write_text("".join(f"{key}\n" for _, key in selected), encoding="utf-8")
    return selected


def download_one(endpoint: str, bucket: str, index_key: tuple[int, str]) -> None:
    index, key = index_key
    target = RAW_DIR / f"{index:04d}.log"
    subprocess.run(
        [
            "aws",
            "s3api",
            "get-object",
            "--endpoint-url",
            endpoint,
            "--bucket",
            bucket,
            "--key",
            key,
            str(target),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )


def download_selected(endpoint: str, bucket: str, selected: list[tuple[dt.datetime, str]]) -> None:
    shutil.rmtree(RAW_DIR, ignore_errors=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as executor:
        list(executor.map(
            lambda item: download_one(endpoint, bucket, item),
            enumerate((key for _, key in selected), start=1),
        ))
    downloaded = sum(1 for path in RAW_DIR.iterdir() if path.is_file())
    if downloaded != len(selected):
        raise RuntimeError(f"Downloaded {downloaded} of {len(selected)} selected R2 objects")


def observation_status() -> tuple[int, list[str]]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    try:
        SUMMARY_PATH.unlink()
    except FileNotFoundError:
        pass
    subprocess.run(["python3", str(ANALYZER_PATH)], check=False)
    if not SUMMARY_PATH.exists():
        return 0, list(ACTIVE_WORKERS)
    summary = json.loads(SUMMARY_PATH.read_text(encoding="utf-8"))
    scripts = summary.get("scripts") or {}
    missing = [
        name
        for name in ACTIVE_WORKERS
        if int((scripts.get(name) or {}).get("events") or 0) <= 0
        or int(((scripts.get(name) or {}).get("cpu_ms") or {}).get("samples") or 0) <= 0
    ]
    return int(summary.get("events") or 0), missing


def main() -> None:
    endpoint = required("R2_ENDPOINT")
    bucket = required("R2_BUCKET")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    last_missing = list(ACTIVE_WORKERS)
    for attempt in range(1, POLL_ATTEMPTS + 1):
        selected = list_objects(endpoint, bucket)
        if selected:
            download_selected(endpoint, bucket, selected)
            events, missing = observation_status()
            last_missing = missing
            print(
                f"Attempt {attempt}/{POLL_ATTEMPTS}: "
                f"selected {len(selected)} R2 objects with {events} Worker events; "
                f"missing active Workers: {','.join(missing) if missing else 'none'}"
            )
            if events > 0 and not missing:
                return
        else:
            print(f"Attempt {attempt}/{POLL_ATTEMPTS}: no R2 objects in the audit window")
        if attempt < POLL_ATTEMPTS:
            time.sleep(POLL_SECONDS)
    detail = ",".join(last_missing) if last_missing else "unknown"
    raise SystemExit(f"No complete active Worker CPU sample arrived; missing: {detail}")


if __name__ == "__main__":
    main()
