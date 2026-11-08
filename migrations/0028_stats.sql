-- Stats with memory. Flickr's own stats page keeps 28 days; we keep everything from now on.
-- photo_hist: a photo's Flickr counts on a day — written only when they changed since the last snapshot
CREATE TABLE photo_hist (
  photo_id TEXT NOT NULL,
  day TEXT NOT NULL,                 -- 'YYYY-MM-DD' (UTC)
  views INTEGER, faves INTEGER, comments INTEGER, tsp INTEGER,
  PRIMARY KEY (photo_id, day)
);
CREATE INDEX photo_hist_day ON photo_hist(day);
-- account totals per day (from our own counts) — cheap charts even before per-photo history piles up
CREATE TABLE account_daily (
  account_id INTEGER NOT NULL, day TEXT NOT NULL,
  photos INTEGER, views INTEGER, faves INTEGER, comments INTEGER, tsp INTEGER,
  PRIMARY KEY (account_id, day)
);
-- Flickr's own stats API (Pro accounts): daily views by kind, and which sites the views came from
CREATE TABLE flickr_daily (
  account_id INTEGER NOT NULL, day TEXT NOT NULL,
  total INTEGER, photos INTEGER, photostream INTEGER, sets INTEGER, galleries INTEGER, collections INTEGER,
  PRIMARY KEY (account_id, day)
);
CREATE TABLE flickr_domains (
  account_id INTEGER NOT NULL, day TEXT NOT NULL, domain TEXT NOT NULL, views INTEGER,
  PRIMARY KEY (account_id, day, domain)
);
ALTER TABLE accounts ADD COLUMN stats_ok INTEGER;     -- 1 = Flickr stats API works (Pro), 0 = not available
ALTER TABLE accounts ADD COLUMN stats_checked INTEGER;
