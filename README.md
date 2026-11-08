# PortfolioEdge

> **All rights reserved.** Published for viewing only — see [LICENSE](LICENSE). Not licensed for reuse.

**A serverless JavaScript photography portfolio and asset manager.** It joins a photographer's Flickr archive,
Instagram account and Getty Images portfolio into one data set — and serves it as a fast public site from
Cloudflare's edge, with no origin server at all.

Live at **[tonyshi.photos](https://tonyshi.photos)** · ~9,000 photos · 3 Flickr accounts · Instagram · Getty Images

---

## The problem

A working photographer's assets are scattered, and none of the places they live talk to each other:

- **Originals** sit on local drives and a NAS.
- **The archive** — titles, tags, albums, places, views and faves — lives on Flickr.
- **The audience** is on Instagram, with its own likes and comments.
- **The sales** happen on Getty Images, reported in monthly royalty statements.

So the same photo exists four times with nothing linking the copies, and simple questions have no answer:
*Which photos actually matter? Which ones sell? What should I post next?* Meanwhile the usual website options —
Wix, Squarespace, Adobe Portfolio — give you a pretty grid that knows nothing about any of it, served from one
place, uncached.

PortfolioEdge links every copy of every photo into **one record** with all of its numbers, and builds the
site, the catalog and the analytics on top of that.

---

## Highlights

### 📷 Flickr — the source of truth

- **Three accounts, one catalog**, synced every minute by a Cron Trigger: full listings split into date windows
  so huge accounts list completely, daily change feeds, albums *in the order you arranged them on Flickr*,
  collections, EXIF, places, views, faves, comments and galleries.
- **Respects Flickr's limits**: every API call draws from an hourly budget kept in D1; a deletion guard stops a
  bad listing from wiping the catalog; private photos are never served.
- **Images stored once, in every size the site needs**, resized with Cloudflare Images into R2. When Flickr
  throttles Cloudflare's shared IPs, a small **photo fetcher** on the Mac downloads the originals instead and
  hands them to the Worker. Non-Pro accounts (no original downloads) are detected so they never loop.

### 📱 Instagram — linked, read, published and measured

**Connecting** took real work. Meta's newer Instagram-login tokens couldn't read what was needed, so it uses the
**Instagram Graph API through Facebook Login**: a Meta developer app, the Instagram professional account linked
to a Facebook Page, the right permissions (`instagram_basic`, `pages_show_list`, `pages_read_engagement`,
`instagram_manage_comments`, `instagram_content_publish`), and a long-lived token exchanged for a **Page token
that never expires** — sealed with AES-GCM in D1. Both API flavours (graph.instagram.com and graph.facebook.com)
are supported.

**Matching posts to photos.** Instagram hands back recompressed, cropped, often filtered images with no link to the
original. A matcher on the Mac solves that:

1. Every site photo — plus Instagram-style **4:5 and 1:1 centre crops** of it — and every Instagram image is
   embedded with **DINOv2 on the Apple GPU** (vectors cached, so later runs only embed what's new).
2. The 10 nearest candidates are verified geometrically with **SIFT keypoints + RANSAC** (a similarity transform —
   crops, resizes, small rotations), which survives filters and rejects look-alikes.
3. Each post is decided: **auto** (clear winner), **review** (plausible, or near-duplicate bursts) or **no match**.
   Carousels are matched slide by slide.

An admin **review queue** confirms or rejects the doubtful ones, and a searchable **"Link a photo…"** picker handles
the rest by hand.

**Posting from Flickr.** Instagram becomes an output of the archive, not another place to upload to:

- Tag a Flickr upload **`tsp-ig`** and it's posted to Instagram with its Flickr caption.
- Tags like **`tsp-ig-newyorkcity`** become hashtags (`#newyorkcity`). The magic tag and prefix are configurable.
- **`tsp-ig-manual`** holds the photo in a **crop queue** — panoramas and wide shots get cropped by hand
  (1:1, 4:5 or 1.91:1) in an in-browser cropper first.
- The Worker prepares the JPEG with Cloudflare Images (trim, 1440 px, white padding or cover crop), serves it at a
  random temporary URL for Meta to fetch, then walks the container → status → publish flow, with a daily cap.

**Comments and stats.** Instagram (and Flickr) comments — with avatars and replies — are read right on the photo
page, never sending visitors away. An **Instagram stats page** adds what Instagram's app doesn't: follower history,
engagement rate, a **best-time-to-post heatmap** that compares each post with its own era, which kinds of post
work, hashtag performance, rising posts, and **"post next"** — the most-loved site photos never shown on Instagram.

### 💼 Getty Images — the hard one

**There is no contributor API.** Getty's API keys are for buyers — search and licensing — and the contributor
portal (ESP) has no way to export your own portfolio. Royalty statements only list images that *sold*, so photos
that never sold are invisible to them.

The way in was **DeepMeta**, a contributor tool that Getty authorizes through ESP:
its **"Export whole portfolio"** CSV is the only complete list of a contributor's Getty assets. PortfolioEdge
turns that manual export into a reliable data feed:

- **Idempotent diff import.** Upload the *whole* export every time; each asset row is hashed, so the import reports
  exactly what was **added, updated, unchanged, gone or back** — and only writes what changed.
- **Partial-export guard.** If an export looks short for an account (under 80% of what's known), nothing is
  marked as gone — a truncated file can never wipe the portfolio.
- **Sales from royalty statements**, attached to each asset, feed the stats (kept admin-only, never public).
- **Matching Getty assets to photos** reuses the Mac matcher in a **watermark-aware mode**: borders and credit
  strips are trimmed, keypoints sitting on the translucent watermark simply find no partner while the scene's
  keypoints do, and the auto-accept bar is set for low-resolution previews. Where previews were too poor, the
  **"Getty ↔ photos" review screen** made confirming by hand quick.
- On the public site, matched photos show **"Available on Getty Images"** and link to the exact Getty page.

### 🗂 A real catalog

Browse every account → collection → album (Flickr's own structure and order), **full-text search** with
camera / year / place / Getty filters (SQLite **FTS5**), a **clustered map** of 8,000+ geotagged photos (Leaflet),
and a **month-by-month camera roll** that loads each month only as it scrolls into view, as 3 KB thumbnails.

### 🔎 Every photo, fully told

The lightbox shows, in one quiet line: Flickr views, faves, comments and galleries · Instagram likes · Getty
availability with a direct link · camera and year · place with a map popover (pin or approximate circle) ·
resolution and **maximum print size** at 300 / 150 ppi · licence · views on the site itself. Plus comments,
a logo watermark, and a share menu.

### 📈 Stats that beat the platforms

Flickr forgets daily stats after 28 days; PortfolioEdge snapshots every photo daily (writing only what changed)
and keeps the history forever: totals and gains, rising photos, leaders by fave rate with Instagram likes and Getty
sales side by side, and **"what works"** breakdowns by year, camera, country, city, tag, album and shape.

### 🔗 Sharing

Every photo and album has a link. The Worker uses **HTMLRewriter** to inject Open Graph tags on the way out, so a
link pasted into iMessage, WhatsApp or X previews *that* photo. The share button uses the system share sheet on
phones and a compact menu elsewhere.

### 🛡 Security and protection

Strict **Content-Security-Policy** (inline scripts allowed by hash only), HSTS and friends · hotlink protection with
an allowlist · watermarked large views and save-as protection · every third-party secret **sealed with AES-GCM**
in D1, upload tokens stored only as SHA-256 hashes · Turnstile on the inquiry form.

---

## Why serverless

| | |
|---|---|
| **No origin** | Nothing to run, patch or get hacked — code and data live on Cloudflare's network. |
| **Cached at the edge** | Pages, data and images are served from the nearest of 300+ cities. Cache keys are *versioned* (content version + catalog version + album changes), so updates show instantly with no purging. |
| **Scales on its own** | No traffic costs nothing; a viral photo just means more edge machines answer. |
| **Data next to code** | D1 (SQLite) sits beside the Worker — full-text search and stats in milliseconds. |
| **No egress bills** | Images live in R2, which charges nothing to serve them. |
| **One-command deploys** | Code, database migrations and assets ship together; 20 test files run against the real Worker code first. |

## Architecture

```
                 Flickr API ──┐   Instagram Graph API ──┐   DeepMeta CSV + Getty royalty statements
                              │                         │                  │ (uploaded in admin)
                              ▼                         ▼                  ▼
   ┌──────────────────────────── Cloudflare Worker (one script) ────────────────────────────┐
   │  public site · catalog API · lightbox detail · admin API · cron sync · IG publisher     │
   │  Cache API (versioned keys) · HTMLRewriter (link previews) · security headers           │
   └──────┬──────────────────────┬──────────────────────┬──────────────────────┬───────────┘
          │                      │                      │                      │
     D1 (SQLite + FTS5)     R2 (masters, thumbs,   Cloudflare Images      Cron Trigger
     catalog, links, stats   tiny squares, reel)   (resize, crop, pad)    (every minute)
          ▲
          │  upload tokens (SHA-256)
   Mac helpers: matcher (DINOv2 + SIFT/RANSAC) · photo fetcher · aerial video uploader
```

## By the numbers

**~15,000 lines** of JavaScript, SQL, Python, HTML and CSS · **29** database migrations · **20** test files ·
**0** frameworks — vanilla JavaScript end to end, plus Leaflet for the map · **0** servers.

## Stack

Cloudflare Workers · D1 (SQLite, FTS5) · R2 · Cloudflare Images · Cron Triggers · Cache API · HTMLRewriter ·
Flickr API (OAuth 1.0a) · Instagram Graph API · Getty / DeepMeta portfolio data · Resend · Turnstile · Leaflet ·
Node.js and Python (PyTorch, DINOv2, OpenCV) on the Mac.

---

# Operating notes

The sections below are the original working notes for running the site.


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
