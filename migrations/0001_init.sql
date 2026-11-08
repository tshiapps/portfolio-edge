-- tonyshi.photos catalog

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nsid TEXT NOT NULL UNIQUE,
  username TEXT,
  realname TEXT,
  path_alias TEXT,
  token_enc TEXT NOT NULL,
  token_secret_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  flickr_count INTEGER,              -- what Flickr says the account holds (people.getInfo)
  first_upload INTEGER,
  sync_phase TEXT NOT NULL DEFAULT 'list',   -- list | albums | idle
  sync_state TEXT,                   -- JSON cursor for the current phase
  run_id INTEGER NOT NULL DEFAULT 1, -- increments each full listing; used to detect deletions
  last_full_sync INTEGER,
  last_album_sync INTEGER,
  last_recent_check INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE photos (
  id TEXT PRIMARY KEY,               -- Flickr photo id (globally unique)
  account_id INTEGER NOT NULL,
  secret TEXT, server TEXT, original_secret TEXT,
  title TEXT, description TEXT,
  tags TEXT,                         -- normalized, space separated (Flickr "tags")
  raw_tags TEXT,                     -- JSON array of tags as typed (from getInfo)
  machine_tags TEXT,
  date_taken TEXT, date_upload INTEGER, last_update INTEGER,
  latitude REAL, longitude REAL, geo_accuracy INTEGER,
  location TEXT,                     -- JSON: locality/region/country/etc
  is_public INTEGER, is_friend INTEGER, is_family INTEGER,
  license TEXT, views INTEGER, media TEXT, original_format TEXT,
  o_width INTEGER, o_height INTEGER,
  page_url TEXT,
  exif TEXT,                         -- JSON array
  info TEXT,                         -- JSON: full flickr.photos.getInfo payload
  width INTEGER, height INTEGER, bytes INTEGER,          -- stored master (R2)
  thumb_w INTEGER, thumb_h INTEGER, thumb_bytes INTEGER, -- stored display/thumb (R2)
  source_size TEXT,                  -- which Flickr size the master was made from
  status TEXT NOT NULL DEFAULT 'pending',  -- pending (needs image+meta) | meta (needs meta only) | ok | error | deleted
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  error TEXT,
  seen_run INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0, -- hide from the public site without touching Flickr
  synced_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX photos_work ON photos(status, lease_until);
CREATE INDEX photos_account ON photos(account_id, status);
CREATE INDEX photos_upload ON photos(date_upload);
CREATE INDEX photos_taken ON photos(date_taken);

CREATE TABLE albums (
  id TEXT PRIMARY KEY,               -- 'f:<flickr set id>' (mirrored, read-only) or 'l:<uuid>' (local)
  source TEXT NOT NULL,              -- flickr | local
  account_id INTEGER,
  flickr_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  cover_photo_id TEXT,
  photo_count INTEGER NOT NULL DEFAULT 0,
  seen_run INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE album_photos (
  album_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (album_id, photo_id)
);
CREATE INDEX album_photos_photo ON album_photos(photo_id);

CREATE TABLE api_usage (
  bucket INTEGER PRIMARY KEY,        -- unix hour
  calls INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE oauth_pending (
  token TEXT PRIMARY KEY,
  secret_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL DEFAULT (unixepoch()),
  level TEXT NOT NULL,
  account_id INTEGER,
  msg TEXT NOT NULL
);
CREATE INDEX sync_log_ts ON sync_log(ts);
