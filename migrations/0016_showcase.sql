-- Two stored sizes (R2 free tier is 10 GB): showcase = 1 for photos visitors actually open (album-builder
-- folders, Aerial reel, front-page "top N") — those keep the big size; the rest are stored at the base size.
ALTER TABLE photos ADD COLUMN showcase INTEGER NOT NULL DEFAULT 0;
CREATE INDEX photos_showcase ON photos(showcase, status);
-- back under the free tier (0013 had raised it to 20)
UPDATE settings SET value = '9.5' WHERE key = 'storage_budget_gb' AND CAST(value AS REAL) > 9.5;
