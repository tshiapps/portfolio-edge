-- Aerial reel can mix photos (from the catalog) between video clips, each with optional overlay text
ALTER TABLE media_clips ADD COLUMN kind TEXT NOT NULL DEFAULT 'video';   -- video | photo
ALTER TABLE media_clips ADD COLUMN photo_id TEXT;                        -- for kind = 'photo'
ALTER TABLE media_clips ADD COLUMN caption TEXT;                         -- overlay headline; empty = default for the kind
