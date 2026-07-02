from pathlib import Path
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "database" / "migrations"


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(
            """
            CREATE TABLE sh_email_stream_snapshots (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              source_key TEXT NOT NULL UNIQUE,
              week_of TEXT NOT NULL,
              email_sent_at INTEGER NOT NULL,
              effective_at INTEGER NOT NULL,
              stream_count INTEGER NOT NULL,
              source TEXT NOT NULL,
              validation_status TEXT NOT NULL,
              timing_basis TEXT NOT NULL,
              timing_offset_minutes INTEGER NOT NULL,
              reference_source TEXT,
              estimated_stream_count INTEGER,
              difference INTEGER,
              relative_difference REAL,
              nearest_distance_minutes REAL,
              validation_notes TEXT,
              imported_at INTEGER NOT NULL
            );

            CREATE TABLE sh_weekly_summary (
              period_key TEXT PRIMARY KEY,
              period_start INTEGER NOT NULL,
              period_end INTEGER NOT NULL,
              sample_count INTEGER NOT NULL,
              reliable_sample_count INTEGER NOT NULL,
              listener_avg REAL,
              listener_min INTEGER,
              listener_max INTEGER,
              stream_start INTEGER,
              stream_end INTEGER,
              stream_growth INTEGER,
              member_start INTEGER,
              member_end INTEGER,
              member_growth INTEGER,
              likes_max INTEGER,
              distinct_tracks INTEGER,
              primary_host TEXT,
              quality_score REAL NOT NULL,
              quality_flags TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE sh_host_broadcast_sessions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              total_listens_end INTEGER,
              peak_listeners INTEGER,
              last_observed_at INTEGER,
              end_reason TEXT,
              status TEXT,
              ended_at INTEGER,
              raw_end_json TEXT
            );

            CREATE TABLE sh_host_station_snapshots (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id INTEGER NOT NULL,
              observed_at INTEGER NOT NULL,
              listener_count INTEGER,
              total_listens INTEGER
            );

            CREATE TABLE sh_host_raw_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id INTEGER NOT NULL,
              observed_at INTEGER NOT NULL,
              event TEXT,
              data_json TEXT
            );

            CREATE TABLE sh_channel_snapshots (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              observed_at INTEGER NOT NULL,
              station_id INTEGER,
              host_account_id INTEGER,
              host_handle TEXT
            );

            CREATE TABLE sh_queue_snapshots (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              observed_at INTEGER NOT NULL,
              station_id INTEGER
            );
            """
        )

    def apply(self, name):
        self.db.executescript((MIGRATIONS / name).read_text(encoding="utf-8"))

    def test_migrations_are_repeatable_and_triggers_work(self):
        for _ in range(2):
            self.apply("004_collector_coordination.sql")
            self.apply("005_cloud_host_monitor.sql")
            self.apply("006_email_weekly_summary.sql")
            self.apply("007_host_session_safety.sql")
            self.apply("008_runtime_query_indexes.sql")
            self.apply("016_email_stream_runtime.sql")
            self.apply("017_resend_health_alert.sql")

        rows = [
            ("stationhead-email:2026-06-08", "2026-06-08", 1781528583000, 1781525193000, 47576224),
            ("stationhead-email:2026-06-15", "2026-06-15", 1782133437000, 1782130047000, 47986298),
        ]
        self.db.executemany(
            """
            INSERT INTO sh_email_stream_snapshots (
              source_key,week_of,email_sent_at,effective_at,stream_count,source,
              validation_status,timing_basis,timing_offset_minutes,imported_at
            ) VALUES (?,?,?,?,?,'stationhead_email_recap','validated_good',
                      'email_sent_minus_offset',57,?)
            """,
            [(*row, row[3]) for row in rows],
        )
        weekly = self.db.execute(
            "SELECT stream_start,stream_end,stream_growth,quality_flags "
            "FROM sh_weekly_summary WHERE period_key='2026-06-15'"
        ).fetchone()
        self.assertEqual(weekly[0], 47576224)
        self.assertEqual(weekly[1], 47986298)
        self.assertEqual(weekly[2], 410074)
        self.assertIn("stationhead_email_recap", weekly[3])

        cursor = self.db.execute(
            "INSERT INTO sh_host_broadcast_sessions "
            "(total_listens_end,peak_listeners,last_observed_at,end_reason,status,ended_at,raw_end_json) "
            "VALUES (NULL,10,0,NULL,'active',NULL,NULL)"
        )
        session_id = cursor.lastrowid
        self.db.executemany(
            "INSERT INTO sh_host_station_snapshots "
            "(session_id,observed_at,listener_count,total_listens) VALUES (?,?,?,?)",
            [
                (session_id, 1000, 20, 10000),
                (session_id, 2000, 25, 10100),
            ],
        )
        self.db.execute(
            "INSERT INTO sh_host_raw_events "
            "(session_id,observed_at,event,data_json) VALUES (?,?,?,?)",
            (session_id, 2500, "listenerCount", '{"listener_count":42}'),
        )
        peak = self.db.execute(
            "SELECT peak_listeners FROM sh_host_broadcast_sessions WHERE id=?",
            (session_id,),
        ).fetchone()[0]
        self.assertEqual(peak, 42)

        self.db.execute(
            "UPDATE sh_host_broadcast_sessions SET "
            "total_listens_end=999999,end_reason='station_changed',status='ended',"
            "ended_at=3000,raw_end_json='{}' WHERE id=?",
            (session_id,),
        )
        ended = self.db.execute(
            "SELECT total_listens_end,raw_end_json FROM sh_host_broadcast_sessions WHERE id=?",
            (session_id,),
        ).fetchone()
        self.assertEqual(ended[0], 10100)
        self.assertIsNone(ended[1])

        alert = self.db.execute(
            "SELECT incident_open,incident_started_at,last_alert_at,last_error "
            "FROM sh_health_alert_state WHERE id='stationhead-collector'"
        ).fetchone()
        self.assertEqual(alert, (0, None, None, None))

        index_names = {
            row[0]
            for row in self.db.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            )
        }
        self.assertTrue({
            "idx_sh_channel_snapshots_station_observed",
            "idx_sh_channel_snapshots_host_account_observed",
            "idx_sh_channel_snapshots_host_handle_observed",
            "idx_sh_queue_snapshots_station_observed",
            "idx_sh_email_stream_snapshots_week",
        }.issubset(index_names))

    def tearDown(self):
        self.db.close()


if __name__ == "__main__":
    unittest.main()
