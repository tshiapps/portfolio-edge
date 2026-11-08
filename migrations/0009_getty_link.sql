-- Manual Getty asset → Flickr photo links (overrides automatic matching)
ALTER TABLE getty_assets ADD COLUMN linked_photo_id TEXT;
