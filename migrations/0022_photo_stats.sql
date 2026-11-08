-- Public photo details: views on this site (lightbox opens) and how many Flickr galleries include the photo.
ALTER TABLE photos ADD COLUMN tsp_views INTEGER NOT NULL DEFAULT 0;
ALTER TABLE photos ADD COLUMN galleries INTEGER;       -- Flickr galleries (other people's curated collections) it's in
ALTER TABLE photos ADD COLUMN galleries_at INTEGER;    -- when that was last looked up
