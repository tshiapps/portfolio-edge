-- Per-account image sizes: e.g. fine-art account at 4K / quality 75, commercial account at 3K / quality 65.
-- NULL = use the global setting (Settings → Processing).
ALTER TABLE accounts ADD COLUMN long_edge INTEGER;  -- showcase photos (album folders, Aerial reel, front-page top N)
ALTER TABLE accounts ADD COLUMN base_edge INTEGER;  -- every other photo
ALTER TABLE accounts ADD COLUMN quality INTEGER;    -- JPEG quality of the stored copy
