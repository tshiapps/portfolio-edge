# PortfolioEdge

> **All rights reserved.** Published for viewing only — see [LICENSE](LICENSE). Not licensed for reuse.

Serverless JavaScript photography portfolio and asset manager — Flickr, Instagram and Getty Images joined into one data set,
served from Cloudflare's edge with no origin server. Live at [tonyshi.photos](https://tonyshi.photos).

No secrets live in this repo: API keys and tokens are Cloudflare Worker secrets or sealed (AES-GCM) in D1, and the
Cloudflare credentials come from your shell environment via `./cf`. Set `database_id` in `wrangler.toml` to your own D1 database.

One Cloudflare Worker: public portfolio (justified grid, About, Inquiry), admin portal, and a Flickr → R2 sync.

| Piece | Where |
|---|---|
| Catalog (photos, albums, sync state, settings) | D1 `tonyshi-photos` |
| Images: `m/<id>.jpg` master (2500px long edge, q75 JPEG) · `t/<id>.webp` display/thumb (1024px) | R2 `tonyshi-photos` |
| Resizing | Images binding (`env.IMAGES`) |
| Sync | Cron every minute, bounded work per tick, D1 lease so ticks never overlap |

## Deploy

```sh
cd portfolio-edge
export CLOUDFLARE_API_TOKEN=$CF_TONYSHIPHOTOS_API_TOKEN

npx wrangler d1 create tonyshi-photos          # paste database_id into wrangler.toml
npx wrangler r2 bucket create tonyshi-photos
npx wrangler d1 migrations apply tonyshi-photos --remote

openssl rand -hex 32 | npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put ADMIN_PASSWORD         # skip if you put Cloudflare Access in front of /admin
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put RESEND_API_KEY
# edit [vars] in wrangler.toml: INQUIRY_TO, TURNSTILE_SITE_KEY (and ACCESS_* if using Access)

npx wrangler deploy
```

Requirements: **Workers Paid** (cron ticks need more CPU/subrequests than the free plan allows) and the
**Images Paid** plan for the first import (2 transformations per photo → ~10k for 5,000 photos ≈ $2.50 once;
on the free plan new transformations stop at 5,000/month). The token needs Workers Scripts, D1, R2, and
DNS/Workers Routes edit on the zone.

## First sync (Goal 1)

1. Create a Flickr app (non-commercial key) at https://www.flickr.com/services/apps/create/ and set its
   callback URL to `https://tonyshi.photos/admin/flickr/callback`.
2. `https://tonyshi.photos/admin/#settings` → paste key + secret → **Connect a Flickr account**.
   Repeat **Connect** while signed into each other Flickr account (one key covers all accounts).
3. Dashboard shows, per account: what Flickr reports vs. what's cataloged (with a "matches" badge once the
   full listing finishes), stored count, queue, errors, R2 usage and API calls this hour.

How it syncs:
- **Full listing** per account, split into upload-date windows (auto-split above ~3,500 results) so big
  accounts are listed completely. Re-runs daily; anything no longer on Flickr is marked *deleted*
  (a sudden drop of >5% waits for "Confirm deletions" in the dashboard instead).
- **Changes** via `flickr.photos.recentlyUpdated` once a day: new uploads, edits, replaced photos.
  Metadata-only edits don't re-download the image.
- **Albums** (Flickr photosets) mirrored read-only once a day. Site albums (yours) are separate.
- **Ingest** per photo: getInfo + getExif + getSizes (3 calls), downloads the smallest Flickr size ≥ 2500px
  (usually 3K/4K rather than the original; originals over 20 MB are skipped for a smaller size), resizes,
  stores master + thumb.
- **Rate limit**: every Flickr call reserves from a per-hour budget in D1 (default 3,000 of Flickr's 3,600).
  At ~3 calls/photo, 5,000 photos take roughly 5–6 hours.
- **Storage guard**: image downloads pause when R2 usage reaches the budget (default 8 GB); metadata keeps syncing.
- Private/friends/family photos are cataloged and visible in the admin, but `/img/*` only ever serves
  photos that are public on Flickr, stored, and not hidden.

## Test

`node --experimental-sqlite --no-warnings test/sim.mjs` — runs the real Worker code against SQLite and a fake
Flickr (two accounts, 4,360 photos, albums, a 3,800-photo burst, edits, replacement, deletion) and checks
the catalog, R2 objects, admin API and the public privacy gate.

## Aerial page (background video)

`/aerial` plays the enabled clips in order as a silent, looping 2:1 band, crossfading between clips
(phones get a 960×480 version; reduced-motion visitors see a still). Clips live in R2 under `v/<id>/`.

Upload from the Mac with `tools/aerial.mjs` (needs `brew install ffmpeg`):

```sh
cd ~/"Claude Agent/tonyshi-photos" && npm link     # once: puts `aerial` on your PATH
aerial login                                      # paste a token from Admin → Settings → Upload tokens (saved in Keychain)
aerial add ~/Movies/DJI_0042.MOV --start 0:14 --end 0:26 --title "Glacier"
aerial list | aerial order <id> <id> | aerial hide <id> | aerial rm <id>
```

Each clip → 1920×960 and 960×480 H.264 (30 fps max, no audio, faststart) + a poster frame. HLG/HDR
sources are tone-mapped to SDR. Tokens can only touch `/api/admin/media/*`; revoke them in Settings.

### Aerial Uploader app

Double-click `tools/Aerial Uploader.app` (or `npm run app`). It opens a window with **Choose videos…**
(Finder picker), per-clip title / start / end / crop, **Compress & Upload**, progress bars and a live log.
First launch asks for an upload token (Admin → Settings → Upload tokens); it's kept in the Keychain.
The app only listens on 127.0.0.1 with a per-launch key and quits ~10 min after its window closes.
The app is self-contained (its code is in `Contents/Resources`): copy just the `.app` to another Mac.
That Mac needs `brew install node ffmpeg` (the app tells you, with a Copy command button, if they're missing)
and one login with an upload token.

## Photo fetcher (full-size downloads from your network)

Flickr throttles Cloudflare's shared outgoing IPs, so the Worker often gets HTTP 429 for 1600px+ sizes.
When that happens the photo's metadata is saved and the image is handed to the **photo fetcher**
(status `fetch`, shown as "Waiting for photo fetcher" on the dashboard). Run it on your Mac:

```sh
cd ~/"Claude Agent/tonyshi-photos" && npm run fetch            # work through the queue, then stop
npm run fetch -- --watch                                         # keep running (always-on Mac / Pi)
```

It uses the Aerial Uploader's token from the Keychain (on a Pi: `AERIAL_TOKEN=… AERIAL_SERVER=https://tonyshi.photos`),
downloads the best size (original if ≤ 20 MB, else 6K/5K/…), backs off on 429, and uploads; the Worker resizes and stores.
Dashboard checkbox "Always use the photo fetcher" skips the Worker's own attempts entirely.
