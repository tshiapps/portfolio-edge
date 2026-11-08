-- Instagram (@tonyshiphoto, via the official API) and its link to the photos on the site.
-- One row per image: a carousel post contributes one row per slide (post_id = the post).
CREATE TABLE ig_media (
  id TEXT PRIMARY KEY,               -- Instagram media id (the slide's own id for carousel children)
  post_id TEXT NOT NULL,             -- the post it belongs to (= id for single posts)
  position INTEGER NOT NULL DEFAULT 0, -- slide number in a carousel
  media_type TEXT,                   -- IMAGE | VIDEO
  product_type TEXT,                 -- FEED | REELS | STORY …
  permalink TEXT, caption TEXT, ts INTEGER,
  like_count INTEGER, comments_count INTEGER,
  media_url TEXT,                    -- Instagram CDN link from the last sync (expires after a while; the site can fetch a fresh one)
  seen_at INTEGER, deleted INTEGER NOT NULL DEFAULT 0, -- seen_at = stamp (ms) of the last sync that listed it
  matched_at INTEGER                 -- when the Mac matcher last looked at it
);
CREATE INDEX ig_media_post ON ig_media(post_id);

-- candidate / confirmed pairs. status: auto (confident match) | review (needs your eye) | confirmed | rejected
CREATE TABLE ig_links (
  ig_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0,   -- 0 = the matcher's best guess
  score REAL, cos REAL, inliers INTEGER,
  status TEXT NOT NULL,
  decided_at INTEGER,
  PRIMARY KEY (ig_id, photo_id)
);
CREATE INDEX ig_links_photo ON ig_links(photo_id, status);
CREATE INDEX ig_links_status ON ig_links(status, rank);
