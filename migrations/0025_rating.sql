-- Your own star rating per photo (0 = not rated, 1–5). Album-builder rules can leave out low-rated photos.
ALTER TABLE photos ADD COLUMN rating INTEGER NOT NULL DEFAULT 0;
CREATE INDEX photos_rating ON photos(rating);
