// Key/value settings in D1 with defaults.
export const DEFAULTS = {
  long_edge: '3840',             // px, long edge for showcase photos (album folders, Aerial reel, front-page top N)
  base_edge: '2048',             // px, long edge for every other photo (keeps R2 under the free 10 GB)
  quality: '75',                 // master JPEG quality
  reel_edge: '6000',             // px: Aerial reel photos get a copy that covers a 16:9 screen this wide (6000 ≈ 5K + drift room)
  reel_quality: '60',            // its JPEG quality (it's on screen for seconds, moving)
  thumb_edge: '1024',            // px, display/thumbnail long edge (WebP)
  thumb_quality: '72',
  pano_ratio: '2.2',             // aspect at which a photo counts as a panorama
  pano_short: '1400',            // panorama master: short edge (px)
  pano_long_max: '8000',         // panorama master: long edge cap (px)
  pano_thumb_short: '640',       // panorama thumbnail: short edge (px)
  api_budget: '3000',            // Flickr calls per hour (hard limit is 3600 per key)
  storage_budget_gb: '9.5',      // R2 free tier is 10 GB        // stop downloading images once R2 usage reaches this
  paused: '0',
  fetch_mode: 'auto',            // 'auto': Worker downloads, hands off to the photo fetcher on 429; 'fetcher': always via the fetcher
  cdn_rate: '12',                // full-size image downloads per minute from Flickr (adapts on 429s)
  cdn_pause_until: '0',          // no image downloads before this time (set after a 429)
  cdn_rate_at: '0',              // last time cdn_rate changed
  featured_count: '60',
  featured_album: '',            // optional local album id that pins front-page photos
  home_page: 'photos',           // what tonyshi.photos/ shows: 'photos' (grid) or 'aerial' (video)
  pop_faves: '3',                // popularity weights (see lib/popularity.js)
  pop_views: '2',
  pop_comments: '0.5',
  pop_decay: '0.7',
  front_mode: 'weekly',          // photo page: 'weekly' (weighted weekly mix) or 'top' (most popular N)
  front_top_n: '100',
  front_order: 'shuffle',
  ig_publish: '0',               // post to Instagram from Flickr tags (off until the token can publish)
  ig_magic_tag: 'tsp-ig',        // Flickr tag that means "post this to Instagram"
  ig_hashtag_prefix: 'tsp-ig-',  // Flickr tags starting with this become hashtags: tsp-ig-newyorkcity → #newyorkcity
  ig_manual_word: 'manual',      // tsp-ig-manual (prefix + this word) = post it, but wait for a hand crop first
  ig_fit: 'pad',                 // photos outside Instagram's 4:5 … 1.91:1: 'pad' (white bars) or 'crop'
  ig_daily_max: '10',            // posts per 24 h at most (Instagram's own cap is higher)
  ig_primed: '0',                // first scan after turning it on holds photos already tagged before
  site_origin: 'https://tonyshi.photos',
  hotlink_protect: '1',          // photos only load on this site (and from search engines / direct links), not embedded on other sites
  getty_profile_url: '', // footer Getty icon; empty = Getty photographer search for the artist in the imported portfolio
  hotlink_allow: 'google, bing.com, duckduckgo.com, yahoo.com, yandex, baidu.com, ecosia.org', // other sites allowed to show them (part of the host name) // public address Instagram downloads the image from        // for 'top': 'shuffle' (re-shuffled weekly), 'daily' (re-shuffled daily) or 'rank'
};

export async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULTS };
  for (const r of results) s[r.key] = r.value;
  return s;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, String(value)).run();
}

export async function log(env, level, msg, accountId = null) {
  try {
    await env.DB.prepare('INSERT INTO sync_log (level, account_id, msg) VALUES (?1, ?2, ?3)')
      .bind(level, accountId, String(msg).slice(0, 2000)).run();
  } catch (e) {
    console.error('log write failed', e);
  }
}
