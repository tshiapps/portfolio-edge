-- "Featured" page: where Tony's work has been published — screenshots of sites, magazine / book covers.
-- Images (cropped on the Mac in TSP Uploader, or uploaded in the admin) live in R2 at f/<id>.jpg.
CREATE TABLE features (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',        -- e.g. "Wall Street Journal"
  caption TEXT,                          -- optional second line ("Cover, March 2019")
  url TEXT,                              -- optional link to the article
  width INTEGER, height INTEGER, bytes INTEGER,
  fit TEXT NOT NULL DEFAULT 'cover',     -- cover = fill the tile; blur / plain / white = whole image on that backdrop
  enabled INTEGER NOT NULL DEFAULT 1,    -- shown on the site
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploading', -- uploading | ready
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX features_order ON features(enabled, position);
