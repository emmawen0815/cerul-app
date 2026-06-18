ALTER TABLE ignored_items ADD COLUMN raw_path TEXT;

CREATE INDEX idx_ignored_items_source_raw_path
    ON ignored_items(source_id, raw_path)
    WHERE raw_path IS NOT NULL AND TRIM(raw_path) <> '';
