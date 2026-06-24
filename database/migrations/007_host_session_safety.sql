DROP TRIGGER IF EXISTS trg_sh_host_ws_listener_peak;
DROP TRIGGER IF EXISTS trg_sh_host_station_change_end;

CREATE TRIGGER trg_sh_host_ws_listener_peak
AFTER INSERT ON sh_host_raw_events
WHEN NEW.event='listenerCount'
  AND json_valid(NEW.data_json)
  AND COALESCE(
    json_extract(NEW.data_json,'$.listener_count'),
    json_extract(NEW.data_json,'$.count')
  ) IS NOT NULL
BEGIN
  UPDATE sh_host_broadcast_sessions
  SET peak_listeners=MAX(
        COALESCE(peak_listeners,0),
        CAST(COALESCE(
          json_extract(NEW.data_json,'$.listener_count'),
          json_extract(NEW.data_json,'$.count')
        ) AS INTEGER)
      ),
      last_observed_at=MAX(COALESCE(last_observed_at,0),NEW.observed_at)
  WHERE id=NEW.session_id;
END;

CREATE TRIGGER trg_sh_host_station_change_end
AFTER UPDATE OF end_reason,status,ended_at ON sh_host_broadcast_sessions
WHEN NEW.end_reason='station_changed'
BEGIN
  UPDATE sh_host_broadcast_sessions
  SET total_listens_end=COALESCE(
        (SELECT total_listens
         FROM sh_host_station_snapshots
         WHERE session_id=NEW.id AND total_listens IS NOT NULL
         ORDER BY observed_at DESC,id DESC LIMIT 1),
        OLD.total_listens_end,
        total_listens_end
      ),
      raw_end_json=NULL
  WHERE id=NEW.id;
END;
