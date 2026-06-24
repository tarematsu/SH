-- 詳細履歴の日時範囲・カーソルページング用。
-- 既存の observed_at 単独インデックスがあっても安全に追加できます。
CREATE INDEX IF NOT EXISTS idx_sh_legacy_observed_cursor
ON sh_legacy_snapshots(observed_at, id);
