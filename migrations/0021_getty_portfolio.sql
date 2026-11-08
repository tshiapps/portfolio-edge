-- Getty portfolio (every accepted asset, sold or not — from DeepMeta's "Export whole Portfolio" CSV) and
-- pixel-matched links to the site's photos. getty_assets already held previews/manual links for sold assets.
ALTER TABLE getty_assets ADD COLUMN artist TEXT;            -- Getty account (artist name)
ALTER TABLE getty_assets ADD COLUMN asset_type TEXT;        -- Creative Photo | Editorial Photo | Creative Video
ALTER TABLE getty_assets ADD COLUMN is_video INTEGER NOT NULL DEFAULT 0;
ALTER TABLE getty_assets ADD COLUMN title TEXT;
ALTER TABLE getty_assets ADD COLUMN description TEXT;
ALTER TABLE getty_assets ADD COLUMN object_name TEXT;       -- the file name you submitted
ALTER TABLE getty_assets ADD COLUMN width INTEGER;
ALTER TABLE getty_assets ADD COLUMN height INTEGER;
ALTER TABLE getty_assets ADD COLUMN orientation TEXT;
ALTER TABLE getty_assets ADD COLUMN created_on TEXT;        -- date taken (as Getty has it)
ALTER TABLE getty_assets ADD COLUMN submitted_at TEXT;
ALTER TABLE getty_assets ADD COLUMN collection TEXT;
ALTER TABLE getty_assets ADD COLUMN license_model TEXT;     -- royaltyfree | rightsmanaged …
ALTER TABLE getty_assets ADD COLUMN editorial INTEGER;
ALTER TABLE getty_assets ADD COLUMN city TEXT;
ALTER TABLE getty_assets ADD COLUMN state TEXT;
ALTER TABLE getty_assets ADD COLUMN country TEXT;
ALTER TABLE getty_assets ADD COLUMN keywords TEXT;          -- comma-separated, Getty vocabulary
ALTER TABLE getty_assets ADD COLUMN page_url TEXT;
ALTER TABLE getty_assets ADD COLUMN deactivated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE getty_assets ADD COLUMN in_portfolio INTEGER;   -- 1 = in the latest full export, 0 = gone since, NULL = only known from sales
ALTER TABLE getty_assets ADD COLUMN row_hash TEXT;          -- of the exported row: unchanged rows are skipped
ALTER TABLE getty_assets ADD COLUMN first_seen INTEGER;
ALTER TABLE getty_assets ADD COLUMN last_seen INTEGER;
ALTER TABLE getty_assets ADD COLUMN photo_id TEXT;          -- resolved link to a site photo (confirmed > auto > file name); linked_photo_id (manual) still wins
ALTER TABLE getty_assets ADD COLUMN matched_at INTEGER;     -- when the Mac matcher last looked at it
CREATE INDEX getty_assets_photo ON getty_assets(photo_id);

-- candidate / confirmed pairs, same shape as ig_links. status: auto | review | confirmed | rejected;
-- how: matcher | filename | you
CREATE TABLE getty_links (
  asset_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0,
  score REAL, cos REAL, inliers INTEGER,
  status TEXT NOT NULL,
  how TEXT,
  decided_at INTEGER,
  PRIMARY KEY (asset_id, photo_id)
);
CREATE INDEX getty_links_photo ON getty_links(photo_id, status);
CREATE INDEX getty_links_status ON getty_links(status, rank);
-- links you made by hand on the sales report count as confirmed
INSERT OR IGNORE INTO getty_links (asset_id, photo_id, status, how, decided_at)
  SELECT asset_id, linked_photo_id, 'confirmed', 'you', unixepoch() FROM getty_assets WHERE linked_photo_id IS NOT NULL AND linked_photo_id != '';

CREATE TABLE getty_portfolio_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT, at INTEGER NOT NULL,
  rows INTEGER, added INTEGER, updated INTEGER, unchanged INTEGER, gone INTEGER, back INTEGER,
  partial INTEGER NOT NULL DEFAULT 0, note TEXT
);
