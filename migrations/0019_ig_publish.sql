-- Posting to Instagram from Flickr: a photo synced with the "magic tag" (default tsp-ig) gets posted once.
-- One row per photo; status: held (needs your OK) | skipped (already on Instagram) | queued | container
-- (uploaded to Instagram, waiting for it to process) | published | error | cancelled
CREATE TABLE ig_posts (
  photo_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  note TEXT,                         -- why it's held/skipped, or the last error
  src_key TEXT,                      -- random name of the temporary public JPEG Instagram downloads
  container_id TEXT,
  ig_media_id TEXT, permalink TEXT,
  caption TEXT,                      -- what was posted
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER, published_at INTEGER
);
CREATE INDEX ig_posts_status ON ig_posts(status, created_at);
