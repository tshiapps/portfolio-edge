-- Instagram stats with memory: followers per day, and each post's likes / comments when they change.
CREATE TABLE ig_daily (
  day TEXT PRIMARY KEY,              -- 'YYYY-MM-DD' (UTC)
  followers INTEGER, follows INTEGER, posts INTEGER
);
CREATE TABLE ig_hist (
  post_id TEXT NOT NULL, day TEXT NOT NULL, likes INTEGER, comments INTEGER,
  PRIMARY KEY (post_id, day)
);
