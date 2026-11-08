-- Stored popularity score (recomputed when weights change and every few hours as counts/age change)
ALTER TABLE photos ADD COLUMN pop_score REAL;
CREATE INDEX photos_pop ON photos(pop_score);
