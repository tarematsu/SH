#!/usr/bin/env python3
"""Prepare durable archive rows for stationhead-other and shared metadata.

The source database is a local backup. Runtime state, locks, jobs and current
playback state are intentionally excluded. Track metadata is emitted into a
separate stationhead-buddies import because it is shared collector data, while
the remaining output belongs to stationhead-other.
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


def literal(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, bool):
        return "1" if value else "0"
    return "'" + str(value).replace("'", "''") + "'"


def quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def write_table_rows(connection: sqlite3.Connection, output: Path, table: str, *, omit_id: bool) -> int:
    columns = [row[1] for row in connection.execute(f"PRAGMA table_info({quote(table)})")]
    if omit_id and "id" in columns:
        columns.remove("id")
    quoted = ",".join(quote(column) for column in columns)
    count = 0
    with output.open("a", encoding="utf-8", newline="\n") as stream:
        for row in connection.execute(
            f"SELECT {','.join(quote(column) for column in columns)} FROM {quote(table)} ORDER BY rowid"
        ):
            values = ",".join(literal(value) for value in row)
            verb = "INSERT OR IGNORE" if table == "sh_track_metadata" else "INSERT"
            stream.write(f"{verb} INTO {quote(table)}({quoted}) VALUES({values});\n")
            count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--legacy-sqlite", type=Path, required=True)
    parser.add_argument("--summary-sql", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    data_path = args.out_dir / "other-archive-data.sql"
    metadata_path = args.out_dir / "buddies-track-metadata.sql"
    legacy_history_path = args.out_dir / "other-legacy-history.sql"
    summary_path = args.out_dir / "other-summary-data-utc.sql"
    data_path.write_text("PRAGMA foreign_keys=OFF;\n", encoding="utf-8")
    metadata_path.write_text("PRAGMA foreign_keys=OFF;\n", encoding="utf-8")
    source = sqlite3.connect(args.legacy_sqlite)
    counts = {
        "sh_host_profile_snapshots": write_table_rows(
            source, data_path, "sh_host_profile_snapshots", omit_id=True
        ),
    }
    counts["sh_track_metadata"] = write_table_rows(
        source, metadata_path, "sh_track_metadata", omit_id=False
    )
    with data_path.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write("PRAGMA foreign_keys=ON;\n")
    with metadata_path.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write("PRAGMA foreign_keys=ON;\n")

    legacy_history_path.write_text("PRAGMA foreign_keys=OFF;\n", encoding="utf-8")
    counts["sh_legacy_snapshots"] = write_table_rows(
        source, legacy_history_path, "sh_legacy_snapshots", omit_id=False
    )
    counts["sh_channel_rankings"] = write_table_rows(
        source, legacy_history_path, "sh_channel_rankings", omit_id=False
    )
    with legacy_history_path.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write("PRAGMA foreign_keys=ON;\n")

    summary_lines = []
    for line in args.summary_sql.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.upper().startswith("DELETE FROM "):
            continue
        if stripped.startswith("INSERT INTO "):
            line = line.replace("INSERT INTO ", "INSERT OR REPLACE INTO ", 1)
        summary_lines.append(line)
    summary_path.write_text(
        "PRAGMA foreign_keys=OFF;\n" + "\n".join(summary_lines) + "\nPRAGMA foreign_keys=ON;\n",
        encoding="utf-8",
    )
    print({"data": counts, "summary_lines": len(summary_lines)})


if __name__ == "__main__":
    main()
