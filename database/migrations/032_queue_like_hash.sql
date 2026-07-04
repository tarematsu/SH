-- Avoid reading every current track like on unchanged queue polls.
ALTER TABLE sh_queue_current ADD COLUMN likes_hash TEXT;
