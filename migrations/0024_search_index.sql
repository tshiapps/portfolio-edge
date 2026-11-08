-- Catalog search: a full-text index (FTS5) so a keyword search reads only the matching photos instead of
-- scanning every row with LIKE. rowid = the photo id. Kept up to date by the cron together with the facets.
CREATE VIRTUAL TABLE photo_search USING fts5(body, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
INSERT INTO photo_search (rowid, body)
  SELECT CAST(id AS INTEGER), lower(COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(tags, '') || ' ' || COALESCE(raw_tags, '') || ' ' ||
    COALESCE(city, '') || ' ' || COALESCE(region, '') || ' ' || COALESCE(country, '') || ' ' || COALESCE(make, '') || ' ' || COALESCE(camera, '') || ' ' ||
    COALESCE(lens, '') || ' ' || COALESCE(year, ''))
  FROM photos WHERE status = 'ok';
