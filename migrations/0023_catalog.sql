-- Catalog search / map: per-photo facets pulled out of the Flickr EXIF / location JSON (filled in by the cron,
-- a few hundred per minute, and again whenever a photo is re-synced).
ALTER TABLE photos ADD COLUMN make TEXT;      -- Nikon, Canon, Sony, DJI, Apple …
ALTER TABLE photos ADD COLUMN camera TEXT;    -- model as shown, e.g. "NIKON D850"
ALTER TABLE photos ADD COLUMN lens TEXT;
ALTER TABLE photos ADD COLUMN year INTEGER;
ALTER TABLE photos ADD COLUMN city TEXT;
ALTER TABLE photos ADD COLUMN region TEXT;
ALTER TABLE photos ADD COLUMN country TEXT;
ALTER TABLE photos ADD COLUMN lat REAL;       -- only when the location is public on Flickr
ALTER TABLE photos ADD COLUMN lon REAL;
ALTER TABLE photos ADD COLUMN geo_acc INTEGER;
ALTER TABLE photos ADD COLUMN facets_at INTEGER;
CREATE INDEX photos_year ON photos(year);
CREATE INDEX photos_make ON photos(make, camera);
CREATE INDEX photos_country ON photos(country);
CREATE INDEX photos_geo ON photos(lat, lon);
