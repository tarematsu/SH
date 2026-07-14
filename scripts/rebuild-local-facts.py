#!/usr/bin/env python3
"""Rebuild the canonical minute database from local D1 exports.

The input exports are intentionally kept outside Git.  This script produces a
small, deterministic facts database and a separate UTC summary patch.  It
does not contact Cloudflare and never includes credentials from unrelated
operational tables.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sqlite3
import time
from collections import Counter, defaultdict
from pathlib import Path


MINUTE_MS = 60_000
LEGACY_CHANNEL_ID = 318
LEGACY_QUALITY_REDUCED = 1024

# Queue jobs, receipts, leases, read models, and runtime checkpoints are
# deliberately rebuilt by live Workers and must not be replayed from a backup.
TRANSIENT_TABLES = {
    "sh_minute_fact_jobs",
    "sh_minute_fact_queue_receipts",
    "sh_minute_fact_runtime_state",
    "sh_minute_fact_rebuild_state",
    "sh_minute_comment_tasks",
    "sh_channel_read_model",
    "sh_queue_read_model_current",
    "sh_collector_read_model",
    "sh_migration_state",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--facts-export", type=Path, required=True)
    parser.add_argument("--legacy-export", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--channel-id", type=int, default=LEGACY_CHANNEL_ID)
    parser.add_argument("--reuse-local", action="store_true", help="reuse facts-rebuilt.sqlite and legacy-source.sqlite")
    return parser.parse_args()


def execute_dump(connection: sqlite3.Connection, path: Path) -> int:
    """Execute a Wrangler D1 export without loading the whole SQL file."""
    statements = 0
    buffer = ""
    batch: list[str] = []

    def flush_batch() -> None:
        if not batch:
            return
        connection.executescript("BEGIN;\n" + "\n".join(batch) + "\nCOMMIT;")
        batch.clear()

    with path.open("r", encoding="utf-8") as source:
        for line in source:
            buffer += line
            if not sqlite3.complete_statement(buffer):
                continue
            statement = buffer.strip()
            buffer = ""
            if not statement or statement in {"BEGIN TRANSACTION;", "COMMIT;"}:
                continue
            batch.append(statement)
            statements += 1
            if len(batch) >= 1000:
                flush_batch()
    if buffer.strip():
        batch.append(buffer)
        statements += 1
    flush_batch()
    return statements


def normalize(value: object) -> str:
    return str(value or "").strip().lower()


def text(value: object) -> str | None:
    value = str(value).strip() if value is not None else ""
    return value or None


def integer(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def minute_bucket(value: int) -> int:
    return value // MINUTE_MS * MINUTE_MS


def score_code(value: object) -> int:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = 1.0
    return max(0, min(100, round(number * 100)))


def sql_literal(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def table_sql(connection: sqlite3.Connection, table: str) -> str:
    row = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row[0] if row else ""


def build_host(connection: sqlite3.Connection, cache: dict[str, int], legacy_id: object, handle: object, at: int) -> int | None:
    legacy = integer(legacy_id)
    handle_text = text(handle)
    key = f"legacy_host_id:{legacy}" if legacy is not None else f"legacy_handle:{normalize(handle_text)}"
    if key in cache:
        return cache[key]
    row = connection.execute("SELECT id FROM sh_hosts WHERE canonical_key=?", (key,)).fetchone()
    if row:
        cache[key] = int(row[0])
        return cache[key]
    connection.execute(
        "INSERT OR IGNORE INTO sh_hosts(canonical_key,stationhead_account_id,current_handle,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)",
        (key, None, handle_text, at, at),
    )
    row = connection.execute("SELECT id FROM sh_hosts WHERE canonical_key=?", (key,)).fetchone()
    if not row:
        return None
    host_id = int(row[0])
    connection.execute(
        "INSERT OR IGNORE INTO sh_host_aliases(alias_type,alias_value,host_id,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)",
        ("handle", normalize(handle_text), host_id, at, at),
    )
    cache[key] = host_id
    return host_id


def build_track(connection: sqlite3.Connection, cache: dict[str, int], legacy_id: object, title: object, artist: object, at: int) -> int | None:
    legacy = integer(legacy_id)
    title_text = text(title)
    artist_text = text(artist)
    if legacy is not None:
        key = f"legacy_track_id:{legacy}"
    else:
        key = f"legacy_track:{normalize(title_text)}\x1f{normalize(artist_text)}"
    if key in cache:
        return cache[key]
    row = connection.execute("SELECT id FROM sh_tracks WHERE canonical_key=?", (key,)).fetchone()
    if row:
        cache[key] = int(row[0])
        return cache[key]
    connection.execute(
        "INSERT OR IGNORE INTO sh_tracks(canonical_key,isrc,spotify_id,stationhead_track_id,title,artist,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)",
        (key, None, None, None, title_text, artist_text, at, at),
    )
    row = connection.execute("SELECT id FROM sh_tracks WHERE canonical_key=?", (key,)).fetchone()
    if not row:
        return None
    track_id = int(row[0])
    connection.execute(
        "INSERT OR IGNORE INTO sh_track_aliases(alias_type,alias_value,track_id,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)",
        ("legacy", key, track_id, at, at),
    )
    cache[key] = track_id
    return track_id


def load_legacy_rows(legacy: sqlite3.Connection):
    normalized_sql = """
        SELECT s.legacy_id AS source_id,s.observed_at,s.listener_count,s.total_stream_count,
               s.likes,s.total_member_count,t.id AS legacy_track_id,t.title AS track_title,
               t.artist_name,h.id AS legacy_host_id,h.handle AS host_handle,b.id AS legacy_broadcast_id,
               b.event_name,'legacy_normalized' AS source
        FROM sh_legacy_samples s
        LEFT JOIN sh_legacy_tracks t ON t.id=s.track_id
        LEFT JOIN sh_legacy_hosts h ON h.id=s.host_id
        LEFT JOIN sh_legacy_broadcasts b ON b.id=s.broadcast_id
    """
    raw_sql = """
        SELECT l.id AS source_id,l.observed_at,l.listener_count,l.total_stream_count,
               l.likes,l.total_member_count,NULL AS legacy_track_id,l.track_title,
               l.artist_name,NULL AS legacy_host_id,l.host_handle,NULL AS legacy_broadcast_id,
               l.source_note AS event_name,'legacy_raw' AS source
        FROM sh_legacy_snapshots l
        WHERE NOT EXISTS (SELECT 1 FROM sh_legacy_samples s WHERE s.legacy_id=l.id)
    """
    query = f"SELECT * FROM ({normalized_sql} UNION ALL {raw_sql}) ORDER BY observed_at ASC, source_id ASC"
    yield from legacy.execute(query)


def session_key(row: sqlite3.Row, host_id: int | None) -> str:
    broadcast = integer(row["legacy_broadcast_id"])
    if broadcast is not None:
        label = f"broadcast:{broadcast}"
    else:
        event_name = normalize(row["event_name"])
        host_handle = normalize(row["host_handle"])
        label = f"label:{event_name}\x1f{host_handle}"
    source = row["source"]
    return f"{source}:{LEGACY_CHANNEL_ID}:{label}:{host_id or 0}"


def add_legacy_facts(facts: sqlite3.Connection, legacy: sqlite3.Connection, channel_id: int) -> tuple[int, int]:
    facts.row_factory = sqlite3.Row
    legacy.row_factory = sqlite3.Row
    host_cache: dict[str, int] = {}
    track_cache: dict[str, int] = {}
    active: dict[str, tuple[int, int]] = {}
    fact_rows: list[tuple] = []
    context_rows: list[tuple] = []
    count = 0
    for row in load_legacy_rows(legacy):
        observed = integer(row["observed_at"])
        if observed is None:
            continue
        host_id = build_host(facts, host_cache, row["legacy_host_id"], row["host_handle"], observed)
        track_id = build_track(facts, track_cache, row["legacy_track_id"], row["track_title"], row["artist_name"], observed)
        key = session_key(row, host_id)
        previous = active.get(key)
        if previous and observed - previous[1] <= 6 * 60 * 60_000:
            session_id = previous[0]
        else:
            session_key_value = f"{key}:{observed}"
            facts.execute(
                "INSERT OR IGNORE INTO sh_broadcast_sessions(session_key,channel_id,station_id,host_id,broadcast_start_time,first_observed_at,last_observed_at,ended_at,status,source) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (session_key_value, channel_id, None, host_id, None, observed, observed, None, "active", row["source"]),
            )
            found = facts.execute("SELECT id FROM sh_broadcast_sessions WHERE session_key=?", (session_key_value,)).fetchone()
            session_id = int(found[0]) if found else None
        if session_id is not None:
            facts.execute(
                "UPDATE sh_broadcast_sessions SET last_observed_at=MAX(last_observed_at,?) WHERE id=?",
                (observed, session_id),
            )
            active[key] = (session_id, observed)
        score = score_code(row["quality_score"] if "quality_score" in row.keys() else 1)
        flags = LEGACY_QUALITY_REDUCED if score < 100 else 0
        source = row["source"]
        source_code = 3 if source == "legacy_normalized" else 4
        source_priority = 80 if source == "legacy_normalized" else 70
        minute_at = minute_bucket(observed)
        values = (
            channel_id, minute_at, observed, observed, source_code, source_priority,
            f"{source}:{row['source_id']}", 3, session_id, 1,
            integer(row["listener_count"]), None, integer(row["total_member_count"]), None,
            integer(row["total_stream_count"]), None, 0, 0, 100 if track_id is not None else 0,
            1 if track_id is not None else 0, None, None, 0, score, flags,
        )
        fact_rows.append(values)
        context_rows.append((channel_id, minute_at, source_priority, score, observed, None, host_id, track_id, integer(row["likes"])))
        count += 1
        if len(fact_rows) >= 5000:
            flush_facts(facts, fact_rows, context_rows)
            fact_rows.clear()
            context_rows.clear()
    flush_facts(facts, fact_rows, context_rows)
    facts.commit()
    return count, len(host_cache),


def flush_facts(connection: sqlite3.Connection, fact_rows: list[tuple], context_rows: list[tuple]) -> None:
    if not fact_rows:
        return
    connection.executemany(
        """INSERT INTO sh_minute_facts(
          channel_id,minute_at,observed_at,received_at,source_code,source_priority,source_record_id,
          collector_code,broadcast_session_id,is_broadcasting,listener_count,online_member_count,
          total_member_count,guest_count,reported_total_listens,reported_current_stream_count,is_paused,
          track_detection_code,track_confidence_code,schedule_valid,comment_count,comment_total,
          comments_degraded,quality_score_code,quality_flags
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(channel_id,minute_at) DO UPDATE SET
          observed_at=excluded.observed_at,received_at=excluded.received_at,source_code=excluded.source_code,
          source_priority=excluded.source_priority,source_record_id=excluded.source_record_id,
          collector_code=excluded.collector_code,broadcast_session_id=excluded.broadcast_session_id,
          is_broadcasting=excluded.is_broadcasting,listener_count=excluded.listener_count,
          online_member_count=excluded.online_member_count,total_member_count=excluded.total_member_count,
          guest_count=excluded.guest_count,reported_total_listens=excluded.reported_total_listens,
          reported_current_stream_count=excluded.reported_current_stream_count,is_paused=excluded.is_paused,
          track_detection_code=excluded.track_detection_code,track_confidence_code=excluded.track_confidence_code,
          schedule_valid=excluded.schedule_valid,comment_count=excluded.comment_count,comment_total=excluded.comment_total,
          comments_degraded=excluded.comments_degraded,quality_score_code=excluded.quality_score_code,
          quality_flags=excluded.quality_flags
        WHERE excluded.source_priority>sh_minute_facts.source_priority
           OR (excluded.source_priority=sh_minute_facts.source_priority AND excluded.quality_score_code>sh_minute_facts.quality_score_code)
           OR (excluded.source_priority=sh_minute_facts.source_priority AND excluded.quality_score_code=sh_minute_facts.quality_score_code AND excluded.observed_at>=sh_minute_facts.observed_at)
        """,
        fact_rows,
    )
    for channel_id, minute_at, priority, score, observed, station_id, host_id, track_id, bite_count in context_rows:
        fact = connection.execute(
            "SELECT id,source_priority,quality_score_code,observed_at FROM sh_minute_facts WHERE channel_id=? AND minute_at=?",
            (channel_id, minute_at),
        ).fetchone()
        if not fact:
            continue
        winner = (
            priority > int(fact[1])
            or (priority == int(fact[1]) and score > int(fact[2]))
            or (priority == int(fact[1]) and score == int(fact[2]) and observed >= int(fact[3]))
        )
        if winner and (host_id is not None or track_id is not None or bite_count is not None):
            connection.execute(
                """INSERT INTO sh_minute_fact_context(fact_id,station_id,host_id,broadcast_start_time,queue_revision_id,queue_id,queue_start_time,queue_track_count,queue_available,track_id,queue_position,track_bite_count)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(fact_id) DO UPDATE SET host_id=excluded.host_id,track_id=excluded.track_id,track_bite_count=excluded.track_bite_count""",
                (fact[0], station_id, host_id, None, None, None, None, None, 0, track_id, None, bite_count),
            )


def write_summary_sql(facts: sqlite3.Connection, path: Path, now: int) -> dict[str, int]:
    facts.row_factory = sqlite3.Row
    hosts = {int(row["id"]): row["current_handle"] for row in facts.execute("SELECT id,current_handle FROM sh_hosts")}
    source_rows: list[dict] = []
    for row in facts.execute("""SELECT f.observed_at,f.listener_count,f.reported_total_listens,f.total_member_count,
             f.quality_score_code,c.track_id,c.host_id,c.track_bite_count
             FROM sh_minute_facts f LEFT JOIN sh_minute_fact_context c ON c.fact_id=f.id
             ORDER BY f.observed_at ASC,f.id ASC"""):
        source_rows.append(dict(row))

    def group_rows(key_fn):
        groups = defaultdict(list)
        for row in source_rows:
            groups[key_fn(int(row["observed_at"]), row)] .append(row)
        return groups

    def summarize(key: str, rows: list[dict]) -> tuple:
        listeners = [int(row["listener_count"]) for row in rows if row["listener_count"] is not None]
        streams = [int(row["reported_total_listens"]) for row in rows if row["reported_total_listens"] is not None]
        members = [int(row["total_member_count"]) for row in rows if row["total_member_count"] is not None]
        scores = [int(row["quality_score_code"]) for row in rows]
        hosts_seen = Counter(
            hosts[int(row["host_id"])]
            for row in rows
            if row["host_id"] is not None and int(row["host_id"]) in hosts and hosts[int(row["host_id"])]
        )
        track_ids = {int(row["track_id"]) for row in rows if row["track_id"] is not None}
        start = int(rows[0]["observed_at"])
        end = int(rows[-1]["observed_at"])
        return (
            key, start, end, len(rows), len(listeners),
            sum(listeners) / len(listeners) if listeners else None,
            min(listeners) if listeners else None, max(listeners) if listeners else None,
            streams[0] if streams else None, streams[-1] if streams else None,
            streams[-1] - streams[0] if len(streams) > 1 and streams[-1] >= streams[0] else None,
            members[0] if members else None, members[-1] if members else None,
            members[-1] - members[0] if len(members) > 1 else None,
            max((int(row["track_bite_count"]) for row in rows if row["track_bite_count"] is not None), default=None),
            len(track_ids), hosts_seen.most_common(1)[0][0] if hosts_seen else None,
            sum(scores) / len(scores) / 100 if scores else 1.0, '["utc_rebuilt"]', now,
        )

    def day_key(timestamp: int, _row: dict) -> str:
        return dt.datetime.fromtimestamp(timestamp / 1000, dt.timezone.utc).strftime("%Y-%m-%d")

    def week_key(timestamp: int, _row: dict) -> str:
        date = dt.datetime.fromtimestamp(timestamp / 1000, dt.timezone.utc).date()
        return (date - dt.timedelta(days=date.weekday())).isoformat()

    def month_key(timestamp: int, _row: dict) -> str:
        return dt.datetime.fromtimestamp(timestamp / 1000, dt.timezone.utc).strftime("%Y-%m")

    daily_rows = [summarize(key, rows) for key, rows in sorted(group_rows(day_key).items())]
    weekly_rows = [summarize(key, rows) for key, rows in sorted(group_rows(week_key).items())]
    monthly_rows = [summarize(key, rows) for key, rows in sorted(group_rows(month_key).items())]

    columns = "period_key,period_start,period_end,sample_count,reliable_sample_count,listener_avg,listener_min,listener_max,stream_start,stream_end,stream_growth,member_start,member_end,member_growth,likes_max,distinct_tracks,primary_host,quality_score,quality_flags,updated_at"
    with path.open("w", encoding="utf-8", newline="\n") as output:
        output.write("DELETE FROM sh_daily_summary;\nDELETE FROM sh_weekly_summary;\nDELETE FROM sh_monthly_summary;\n")
        for table, rows in (("sh_daily_summary", daily_rows), ("sh_weekly_summary", weekly_rows), ("sh_monthly_summary", monthly_rows)):
            for row in rows:
                output.write(f"INSERT INTO {table}({columns}) VALUES({','.join(sql_literal(value) for value in row)});\n")
    return {"daily": len(daily_rows), "weekly": len(weekly_rows), "monthly": len(monthly_rows)}


def write_manifest(path: Path, facts: sqlite3.Connection, imported: int, summaries: dict[str, int]) -> None:
    counts = {}
    for (name,) in facts.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        if name.startswith("sqlite_") or name in TRANSIENT_TABLES:
            continue
        counts[name] = facts.execute(f"SELECT COUNT(*) FROM \"{name}\"").fetchone()[0]
    path.write_text(json.dumps({"facts_rows_imported": imported, "tables": counts, "summaries": summaries}, indent=2) + "\n", encoding="utf-8")


def write_upload_files(facts: sqlite3.Connection, out_dir: Path, rows_per_file: int = 10_000) -> list[dict]:
    """Emit schema, bounded data chunks, and indexes for staged D1 upload."""
    ordered = [
        "sh_hosts", "sh_host_aliases", "sh_tracks", "sh_track_aliases",
        "sh_broadcast_sessions", "sh_queue_revisions", "sh_queue_revision_items",
        "sh_queue_state_events", "sh_playback_current", "sh_track_bite_observations",
        "sh_minute_fact_collectors", "sh_minute_facts", "sh_minute_fact_context",
        "sh_system_settings",
    ]
    existing = {row[0] for row in facts.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    ordered = [table for table in ordered if table in existing and table not in TRANSIENT_TABLES]
    schema_path = out_dir / "facts-schema.sql"
    index_path = out_dir / "facts-indexes.sql"
    with schema_path.open("w", encoding="utf-8", newline="\n") as schema:
        schema.write("PRAGMA foreign_keys=OFF;\n")
        for table in ordered:
            definition = table_sql(facts, table)
            if definition:
                schema.write(definition.rstrip(";") + ";\n")
    with index_path.open("w", encoding="utf-8", newline="\n") as indexes:
        for (definition,) in facts.execute("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name"):
            if any(re.search(rf"ON [\"']?{re.escape(table)}[\"']?", definition, re.IGNORECASE) for table in TRANSIENT_TABLES):
                continue
            indexes.write(definition.rstrip(";") + ";\n")

    for old in out_dir.glob("facts-data-*.sql"):
        old.unlink()
    batches: list[dict] = []
    batch_rows = 0
    batch_number = 0
    output = None

    def open_batch():
        nonlocal batch_number, batch_rows, output
        batch_number += 1
        batch_rows = 0
        path = out_dir / f"facts-data-{batch_number:03d}.sql"
        output = path.open("w", encoding="utf-8", newline="\n")
        output.write("PRAGMA foreign_keys=OFF;\n")
        batches.append({"file": path.name, "rows": 0})

    def close_batch():
        nonlocal output
        if output is not None:
            output.write("PRAGMA foreign_keys=ON;\n")
            output.close()
            output = None

    for table in ordered:
        columns = [row[1] for row in facts.execute(f"PRAGMA table_info(\"{table}\")")]
        quoted_columns = ",".join(f'"{column}"' for column in columns)
        for row in facts.execute(f"SELECT {quoted_columns} FROM \"{table}\" ORDER BY rowid"):
            if output is None or batch_rows >= rows_per_file:
                close_batch()
                open_batch()
            values = ",".join(sql_literal(value) for value in row)
            output.write(f"INSERT OR IGNORE INTO \"{table}\"({quoted_columns}) VALUES({values});\n")
            batch_rows += 1
            batches[-1]["rows"] += 1
    close_batch()
    (out_dir / "upload-manifest.json").write_text(json.dumps({
        "rows_per_file": rows_per_file,
        "tables": ordered,
        "batches": batches,
        "schema": schema_path.name,
        "indexes": index_path.name,
    }, indent=2) + "\n", encoding="utf-8")
    return batches


def main() -> None:
    args = parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    facts_path = args.out_dir / "facts-rebuilt.sqlite"
    legacy_path = args.out_dir / "legacy-source.sqlite"
    if args.reuse_local and facts_path.exists() and legacy_path.exists():
        facts = sqlite3.connect(facts_path)
        legacy = sqlite3.connect(legacy_path)
        facts_statements = legacy_statements = 0
        print("Reusing local SQLite inputs", flush=True)
    else:
        if facts_path.exists():
            facts_path.unlink()
        facts = sqlite3.connect(facts_path)
        facts.execute("PRAGMA journal_mode=MEMORY")
        facts.execute("PRAGMA synchronous=OFF")
        print(f"Loading facts export: {args.facts_export}", flush=True)
        facts_statements = execute_dump(facts, args.facts_export)
        facts.commit()
        if legacy_path.exists():
            legacy_path.unlink()
        legacy = sqlite3.connect(legacy_path)
        legacy.execute("PRAGMA journal_mode=MEMORY")
        legacy.execute("PRAGMA synchronous=OFF")
        print(f"Loading legacy export: {args.legacy_export}", flush=True)
        legacy_statements = execute_dump(legacy, args.legacy_export)
        legacy.commit()
    imported = 0 if args.reuse_local else add_legacy_facts(facts, legacy, args.channel_id)[0]
    summaries = write_summary_sql(facts, args.out_dir / "summaries-rebuilt-utc.sql", int(time.time() * 1000))
    facts.commit()
    batches = write_upload_files(facts, args.out_dir)
    write_manifest(args.out_dir / "rebuild-manifest.json", facts, imported, summaries)
    print(json.dumps({"facts_export_statements": facts_statements, "legacy_export_statements": legacy_statements, "legacy_rows_imported": imported, "summaries": summaries, "upload_batches": batches}, ensure_ascii=False))


if __name__ == "__main__":
    main()
