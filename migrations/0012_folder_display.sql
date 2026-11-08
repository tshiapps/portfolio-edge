-- How a folder's photos are ordered on the site: 'popular' (ranked) or 'random' (shuffled per visitor session)
ALTER TABLE folders ADD COLUMN display TEXT NOT NULL DEFAULT 'popular';
