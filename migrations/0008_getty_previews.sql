-- Getty previews come from Getty's public oEmbed endpoint (official embed thumbnails, no API key)
ALTER TABLE getty_assets ADD COLUMN caption TEXT;
ALTER TABLE getty_assets ADD COLUMN preview_status TEXT;   -- ok | missing | error
