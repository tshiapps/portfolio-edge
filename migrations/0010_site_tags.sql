-- Your own consistent tag scheme, separate from Flickr's free-form tags
CREATE TABLE site_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,          -- e.g. city, newyorkcity  (on Flickr: tag-city, tag-newyorkcity)
  label TEXT NOT NULL,                -- e.g. City, New York City
  kind TEXT NOT NULL,                 -- content | location
  parent_id INTEGER,                  -- City → Landscape; New York City → New York State → USA
  aliases TEXT NOT NULL DEFAULT '[]', -- Flickr words that mean this tag (normalised: lowercase letters+digits)
  geo_key TEXT,                       -- location tags made from geotags: 'country|region|locality'
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX site_tags_parent ON site_tags(parent_id);
CREATE UNIQUE INDEX site_tags_geo ON site_tags(geo_key) WHERE geo_key IS NOT NULL;

CREATE TABLE photo_tags (
  photo_id TEXT NOT NULL,
  tag_id INTEGER NOT NULL,
  source TEXT NOT NULL,               -- geo | flickr | ai | manual | removed (= you took it off; rules won't re-add)
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (photo_id, tag_id)
);
CREATE INDEX photo_tags_tag ON photo_tags(tag_id, source);

-- starter content scheme (edit freely on the Tags page)
INSERT INTO site_tags (slug, label, kind, position, aliases) VALUES
  ('landscape', 'Landscape', 'content', 1, '["landscape","landscapes","scenery","scenic","vista"]'),
  ('underwater', 'Underwater', 'content', 2, '["underwater","scuba","diving","snorkeling","snorkel","reef","coralreef"]'),
  ('events', 'Events', 'content', 3, '["event","events"]');
INSERT INTO site_tags (slug, label, kind, parent_id, position, aliases) VALUES
  ('city', 'City', 'content', (SELECT id FROM site_tags WHERE slug='landscape'), 1, '["city","cityscape","cityscapes","urban","skyline","skylines","downtown","skyscraper","skyscrapers","citylights","nightcity"]'),
  ('nature', 'Nature', 'content', (SELECT id FROM site_tags WHERE slug='landscape'), 2, '["nature","mountain","mountains","forest","waterfall","lake","nationalpark","wilderness","desert","glacier","canyon"]'),
  ('concert', 'Concert', 'content', (SELECT id FROM site_tags WHERE slug='events'), 1, '["concert","concerts","livemusic","gig","musicfestival"]'),
  ('sport', 'Sport', 'content', (SELECT id FROM site_tags WHERE slug='events'), 2, '["sport","sports","race","marathon","surfing","skiing","snowboarding","cycling"]'),
  ('parade', 'Parade', 'content', (SELECT id FROM site_tags WHERE slug='events'), 3, '["parade","parades","festival","procession"]');
