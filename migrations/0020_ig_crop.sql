-- Hand crops for Instagram posts (tsp-ig-manual photos wait in status 'crop' until you crop them).
-- crop = {"x":…, "y":…, "w":…, "h":…} as fractions of the photo, plus "ratio" (w/h of the post)
ALTER TABLE ig_posts ADD COLUMN crop TEXT;
