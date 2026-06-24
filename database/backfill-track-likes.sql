UPDATE sh_queue_items
SET bite_count = COALESCE(
  bite_count,
  CAST(json_extract(raw_json, '$.bite_count') AS INTEGER),
  CAST(json_extract(raw_json, '$.track.bite_count') AS INTEGER),
  CAST(json_extract(raw_json, '$.like_count') AS INTEGER),
  CAST(json_extract(raw_json, '$.likes') AS INTEGER),
  CAST(json_extract(raw_json, '$.いいね数') AS INTEGER)
)
WHERE bite_count IS NULL
  AND json_valid(raw_json)
  AND COALESCE(
    json_extract(raw_json, '$.bite_count'),
    json_extract(raw_json, '$.track.bite_count'),
    json_extract(raw_json, '$.like_count'),
    json_extract(raw_json, '$.likes'),
    json_extract(raw_json, '$.いいね数')
  ) IS NOT NULL;
