-- Popularity metrics + Flickr collections

ALTER TABLE photos ADD COLUMN faves INTEGER;
ALTER TABLE photos ADD COLUMN comments INTEGER;
ALTER TABLE photos ADD COLUMN metrics_at INTEGER;  -- when faves/comments/views were last refreshed
CREATE INDEX photos_faves ON photos(faves);
CREATE INDEX photos_views ON photos(views);
CREATE INDEX photos_metrics ON photos(status, metrics_at);

-- Flickr collections (folders of albums, can nest). Mirrored read-only.
CREATE TABLE collections (
  id TEXT PRIMARY KEY,               -- 'c:<flickr collection id>'
  account_id INTEGER NOT NULL,
  flickr_id TEXT NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  seen_run INTEGER
);

-- Albums under each collection, flattened: a collection also lists the albums of its sub-collections
-- (direct = 0) so "photos in collection X" is one join.
CREATE TABLE collection_albums (
  collection_id TEXT NOT NULL,
  album_id TEXT NOT NULL,
  direct INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, album_id)
);
CREATE INDEX collection_albums_album ON collection_albums(album_id);
