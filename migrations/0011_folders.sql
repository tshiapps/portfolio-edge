-- Album builder: your own folder tree for the public Photos menu (Landscape › City › New York City …)
CREATE TABLE folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER,                    -- NULL = top level
  title TEXT NOT NULL,
  slug TEXT NOT NULL,                   -- URL piece: /photos/landscape/city
  position INTEGER NOT NULL DEFAULT 0,
  -- photo rules, combined (OR): [{ tags:[slug], match:'all'|'any', exclude:[slug], top:20, rank:'flickr'|'getty'|'newest' }]
  rules TEXT NOT NULL DEFAULT '[]',
  within_parent INTEGER NOT NULL DEFAULT 1, -- only photos that also fit the parent folder
  -- automatic sub-folders, one per place: { by:'city'|'state'|'country', top:20, rank:'flickr', min:3 }
  auto TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX folders_parent ON folders(parent_id, position);
