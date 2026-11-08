-- Albums keep the order you arranged them in on Flickr (flickr.photosets.getList returns them in that order).
ALTER TABLE albums ADD COLUMN position INTEGER;
CREATE INDEX albums_position ON albums(account_id, position);
-- re-read every account's album list on the next sync run so the order is filled in straight away
UPDATE accounts SET last_album_sync = NULL;
