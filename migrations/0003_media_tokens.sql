-- Background video clips (Aerial page) + API tokens for the Mac uploader

CREATE TABLE media_clips (
  id TEXT PRIMARY KEY,
  page TEXT NOT NULL DEFAULT 'aerial',
  title TEXT NOT NULL DEFAULT '',
  source_name TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'uploading',   -- uploading | ready
  duration REAL,
  width INTEGER, height INTEGER,
  desktop_bytes INTEGER, mobile_bytes INTEGER, poster_bytes INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX media_clips_page ON media_clips(page, status, enabled, position);

CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,        -- SHA-256 of the token; the token itself is shown once and never stored
  prefix TEXT NOT NULL,             -- first characters, to recognise it in the list
  scope TEXT NOT NULL DEFAULT 'media',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at INTEGER,
  revoked_at INTEGER
);
