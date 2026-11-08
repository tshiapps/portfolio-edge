-- Bigger masters (4K long edge) + an extra-large copy for photos in the Aerial reel, made by the Mac app.
-- refetch = 1: the photo stays on the site while the Mac app re-sizes it in the background.
ALTER TABLE photos ADD COLUMN refetch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE photos ADD COLUMN reel_w INTEGER;
ALTER TABLE photos ADD COLUMN reel_h INTEGER;
CREATE INDEX photos_refetch ON photos(refetch) WHERE refetch = 1;
-- new default master size, unless you had already changed it from the old default
UPDATE settings SET value = '3840' WHERE key = 'long_edge' AND value = '2500';
-- bigger files need more room (R2 is ~1.5¢ per GB-month)
UPDATE settings SET value = '20' WHERE key = 'storage_budget_gb' AND CAST(value AS REAL) < 20;
