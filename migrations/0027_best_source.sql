-- The biggest size we could actually get from Flickr for a photo. Free (non-Pro) accounts — and some photos —
-- only offer smaller sizes; without this the "upgrade to the big size" queue kept asking for an impossible
-- size again and again. Upgrades are only queued when a bigger source exists (re-checked after 30 days, e.g.
-- after the account goes Pro).
ALTER TABLE photos ADD COLUMN best_edge INTEGER;
ALTER TABLE photos ADD COLUMN best_at INTEGER;
