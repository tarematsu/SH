-- Preview:
--   SELECT COUNT(*) AS target_rows, MIN(observed_at) AS earliest, MAX(observed_at) AS latest
--   FROM sh_track_like_observations
--   WHERE like_count = 0
--     AND json_valid(raw_json)
--     AND COALESCE(
--       CAST(json_extract(raw_json, '$.bite_count') AS INTEGER),
--       CAST(json_extract(raw_json, '$.track.bite_count') AS INTEGER),
--       CAST(json_extract(raw_json, '$.biteCount') AS INTEGER),
--       CAST(json_extract(raw_json, '$.likes') AS INTEGER),
--       CAST(json_extract(raw_json, '$.like_count') AS INTEGER)
--     ) > 0;

UPDATE sh_track_like_observations
SET like_count = COALESCE(
  CAST(json_extract(raw_json, '$.bite_count') AS INTEGER),
  CAST(json_extract(raw_json, '$.track.bite_count') AS INTEGER),
  CAST(json_extract(raw_json, '$.biteCount') AS INTEGER),
  CAST(json_extract(raw_json, '$.likes') AS INTEGER),
  CAST(json_extract(raw_json, '$.like_count') AS INTEGER)
)
WHERE like_count = 0
  AND json_valid(raw_json)
  AND COALESCE(
    CAST(json_extract(raw_json, '$.bite_count') AS INTEGER),
    CAST(json_extract(raw_json, '$.track.bite_count') AS INTEGER),
    CAST(json_extract(raw_json, '$.biteCount') AS INTEGER),
    CAST(json_extract(raw_json, '$.likes') AS INTEGER),
    CAST(json_extract(raw_json, '$.like_count') AS INTEGER)
  ) > 0;

-- Post-check:
--   SELECT COUNT(*) AS still_zero
--   FROM sh_track_like_observations
--   WHERE like_count = 0
--     AND json_valid(raw_json)
--     AND COALESCE(
--       CAST(json_extract(raw_json, '$.bite_count') AS INTEGER),
--       CAST(json_extract(raw_json, '$.track.bite_count') AS INTEGER),
--       CAST(json_extract(raw_json, '$.biteCount') AS INTEGER),
--       CAST(json_extract(raw_json, '$.likes') AS INTEGER),
--       CAST(json_extract(raw_json, '$.like_count') AS INTEGER)
--     ) > 0;
