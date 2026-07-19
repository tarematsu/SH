#!/usr/bin/env python3
"""Download R2 Worker logs only when the selected window contains real events."""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import json
import os
import pathlib
import shutil
import subprocess
import time

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


def aws_json(*args: str) -> dict[str, object]:
    completed = subprocess.run(
        ["aws", *args],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return json.loads(completed.stdout or "{}")


def list_objects(endpoint: str, bucket: str) -> list[tuple[dt.datetime, str]]:
    payload = aws_json(
        "s3api",
        "list-objects-v2",
        "--endpoint-url",
        endpoint,
        "--bucket",
        bucket,
        "--output",
        "json",
    )
    OBJECTS_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    cutoff = cutoff_time()
    selected: list[tuple[dt.datetime, str]] = []
    for item in payload.get("Contents") or []:
        modified = dt.datetime.fromisoformat(str(item["LastModified"]).replace("Z", "+00:00"))
        if modified >= cutoff:
            selected.append((modified, str(item["Key"])))
    selected.sort(reverse=True)
    selection = {
        "cutoff": cutoff.isoformat().replace("+00:00", "Z"),
        "objects_available": len(payload.get("Contents") or []),
        "objects_selected": len(selected),
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


def observed_events() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    subprocess.run(["python3", str(ANALYZER_PATH)], check=False)
    if not SUMMARY_PATH.exists():
        return 0
    summary = json.loads(SUMMARY_PATH.read_text(encoding="utf-8"))
    return int(summary.get("events") or 0)


def main() -> None:
    endpoint = required("R2_ENDPOINT")
    bucket = required("R2_BUCKET")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for attempt in range(1, POLL_ATTEMPTS + 1):
        selected = list_objects(endpoint, bucket)
        if selected:
            download_selected(endpoint, bucket, selected)
            events = observed_events()
            print(
                f"Attempt {attempt}/{POLL_ATTEMPTS}: "
                f"selected {len(selected)} R2 objects with {events} Worker events"
            )
            if events > 0:
                return
        else:
            print(f"Attempt {attempt}/{POLL_ATTEMPTS}: no R2 objects in the audit window")
        if attempt < POLL_ATTEMPTS:
            time.sleep(POLL_SECONDS)
    raise SystemExit("No post-deployment Worker events arrived in R2 during the polling window")


if __name__ == "__main__":
    main()
