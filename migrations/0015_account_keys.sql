-- Each connected Flickr account remembers the API key it was authorized with. Flickr ties an account's
-- access token to that key, so changing the key in Settings must not break accounts connected earlier.
ALTER TABLE accounts ADD COLUMN app_key TEXT;
ALTER TABLE accounts ADD COLUMN app_secret_enc TEXT;
