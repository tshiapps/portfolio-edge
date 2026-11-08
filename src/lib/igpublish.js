// Posting to Instagram from Flickr. A public photo synced with the magic tag (default "tsp-ig") is posted once,
// with its Flickr description (or title) as the caption and its "tsp-ig-xxx" tags as #xxx. The post is then
// linked to the photo straight away (ig_media + a confirmed ig_links row), so Flickr ↔ site ↔ Instagram stay tied.
//
// Instagram's publishing API is two steps: create a container from a public image URL, wait for it to finish
// processing, then publish it. The cron does one step per post per tick; the JPEG Instagram downloads sits in R2
// under a random name only while it's needed.
import { getSettings, setSetting, log } from './settings.js';
import { now, randomHex, safeJson } from './util.js';
import { ig, igToken, isFb, hostOf, V, IgError } from './instagram.js';

const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const MAX_TAGS = 30, MAX_CAPTION = 2200;

// the photo's Flickr tags as written (raw), or Flickr's normalized ones if the details haven't been fetched
function photoTags(p) {
  const raw = safeJson(p.raw_tags, null);
  if (Array.isArray(raw) && raw.length) return { list: raw.map(String), raw: true };
  return { list: String(p.tags || '').split(/\s+/).filter(Boolean), raw: false };
}

// does it carry the magic tag, and which hashtags does it ask for
export function tagPlan(p, s) {
  const magic = norm(s.ig_magic_tag || 'tsp-ig');
  const prefixRaw = String(s.ig_hashtag_prefix || 'tsp-ig-').toLowerCase(), prefix = norm(prefixRaw);
  const manualRaw = prefixRaw + String(s.ig_manual_word || 'manual').toLowerCase(), manualN = norm(manualRaw);
  const { list, raw } = photoTags(p);
  let trigger = false, manual = false;
  const tags = [];
  for (const t of list) {
    const n = norm(t);
    if (!n) continue;
    if (n === magic) { trigger = true; continue; }
    if (manualN && n === manualN) { trigger = manual = true; continue; } // tsp-ig-manual: post after a hand crop
    let rest = null;
    if (raw && prefixRaw && t.toLowerCase().startsWith(prefixRaw)) rest = t.slice(prefixRaw.length);
    else if (!raw && prefix && n.startsWith(prefix) && n.length > prefix.length) rest = n.slice(prefix.length);
    if (rest == null) continue;
    const h = rest.replace(/[^\p{L}\p{N}_]/gu, '');
    if (h && !tags.some((x) => x.toLowerCase() === h.toLowerCase())) tags.push(h);
  }
  return { trigger, manual, hashtags: tags.slice(0, MAX_TAGS) };
}

// Flickr descriptions are HTML-ish
function plainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*/gi, '\n\n').replace(/<a\s[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function buildCaption(p, s) {
  const { hashtags } = tagPlan(p, s);
  let text = plainText(p.description) || String(p.title || '').trim();
  const tagLine = hashtags.map((h) => '#' + h).join(' ');
  const room = MAX_CAPTION - (tagLine ? tagLine.length + 2 : 0);
  if (text.length > room) text = text.slice(0, Math.max(0, room - 1)).trimEnd() + '…';
  return [text, tagLine].filter(Boolean).join('\n\n');
}

// ---------- finding photos to post ----------
// every few minutes: public, downloaded photos with the magic tag that have no ig_posts row yet
export async function scanForPosts(env, s) {
  const magic = norm(s.ig_magic_tag || 'tsp-ig');
  if (!magic) return 0;
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.title, p.description, p.tags, p.raw_tags, p.media FROM photos p
     WHERE p.status = 'ok' AND p.is_public = 1 AND COALESCE(p.media, 'photo') != 'video'
       AND (p.tags LIKE ?1 OR LOWER(p.raw_tags) LIKE ?2 OR p.tags LIKE ?3)
       AND NOT EXISTS (SELECT 1 FROM ig_posts x WHERE x.photo_id = p.id) LIMIT 200`
  ).bind(`%${magic}%`, `%${String(s.ig_magic_tag || '').toLowerCase().replace(/[%_]/g, '')}%`,
    `%${norm(String(s.ig_hashtag_prefix || 'tsp-ig-') + (s.ig_manual_word || 'manual'))}%`).all();
  const primed = s.ig_primed === '1', t = now(), stmts = [];
  for (const p of results) {
    const plan = tagPlan(p, s);
    if (!plan.trigger) continue;
    const onIg = await env.DB.prepare(
      `SELECT m.permalink FROM ig_links l JOIN ig_media m ON m.id = l.ig_id WHERE l.photo_id = ?1 AND l.status IN ('confirmed', 'auto') AND m.deleted = 0 LIMIT 1`
    ).bind(p.id).first();
    const [st, note] = onIg ? ['skipped', 'Already on Instagram'] : plan.manual ? ['crop', 'Waiting for your crop']
      : !primed ? ['held', 'Tagged before posting was turned on'] : ['queued', null];
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO ig_posts (photo_id, status, note, permalink, caption, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`
    ).bind(p.id, st, note, onIg?.permalink || null, buildCaption(p, s), t));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  if (!primed) await setSetting(env, 'ig_primed', '1');
  return stmts.length;
}

// ---------- the image Instagram downloads ----------
// Instagram takes JPEGs between 4:5 (tall) and 1.91:1 (wide), ideally 1440 px wide
async function prepareImage(env, s, photoId, crop) {
  const obj = await env.BUCKET.get(`m/${photoId}.jpg`);
  if (!obj) throw new Error('The photo’s image isn’t stored yet');
  const buf = await obj.arrayBuffer();
  const info = await env.IMAGES.info(new Blob([buf]).stream());
  const a = info.width / info.height, W = 1440;
  let tf;
  const c = crop && safeJson(crop, null);
  if (c && c.w > 0 && c.h > 0) {
    // your hand crop: cut it out of the stored photo, then size it for Instagram
    const left = Math.round(c.x * info.width), top = Math.round(c.y * info.height);
    const cw = Math.max(1, Math.min(info.width - left, Math.round(c.w * info.width)));
    const ch = Math.max(1, Math.min(info.height - top, Math.round(c.h * info.height)));
    const r = Math.min(1.91, Math.max(0.8, cw / ch));
    tf = { trim: { left, top, right: info.width - left - cw, bottom: info.height - top - ch }, width: W, height: Math.round(W / r), fit: 'cover' };
  } else if (a >= 0.8 && a <= 1.91) tf = { width: W, height: Math.round(W / a), fit: 'scale-down' };
  else {
    const r = a < 0.8 ? 0.8 : 1.91;
    tf = s.ig_fit === 'crop'
      ? { width: W, height: Math.round(W / r), fit: 'cover', gravity: 'auto' }
      : { width: W, height: Math.round(W / r), fit: 'pad', background: '#ffffff' };
  }
  const out = await (await env.IMAGES.input(new Blob([buf]).stream()).transform(tf)
    .output({ format: 'image/jpeg', quality: 92 })).response().arrayBuffer();
  const key = randomHex(16);
  await env.BUCKET.put(`igp/${key}.jpg`, out, { httpMetadata: { contentType: 'image/jpeg' } });
  return key;
}

// public, unguessable, only while a post is in flight: /ig-src/<key>.jpg
export async function serveSource(env, key) {
  if (!/^[0-9a-f]{32}$/.test(key)) return null;
  const live = await env.DB.prepare(`SELECT 1 FROM ig_posts WHERE src_key = ?1 AND status IN ('queued', 'container')`).bind(key).first();
  if (!live) return null;
  const obj = await env.BUCKET.get(`igp/${key}.jpg`);
  return obj ? new Response(obj.body, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' } }) : null;
}

async function dropSource(env, key) { if (key) await env.BUCKET.delete(`igp/${key}.jpg`).catch(() => {}); }

async function igSend(path, token, params, host) {
  const res = await fetch(`${host}/${V}/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ ...params, access_token: token }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.error) throw new IgError(d.error?.error_user_msg || d.error?.message || `Instagram HTTP ${res.status}`, d.error?.code);
  return d;
}

const friendly = (e) => (e.code === 10 || e.code === 200 || /permission/i.test(e.message))
  ? 'The Instagram token can’t publish — reconnect it with the instagram_content_publish permission'
  : e.code === 190 ? 'Instagram token expired or revoked — paste a new one' : String(e.message || e);

// ---------- one cron step ----------
export async function publishTick(env, s) {
  if (s.ig_publish !== '1' || !s.ig_token || !s.ig_user_id) return null;
  const out = {};
  if (now() - (+s.ig_scan_at || 0) >= 300) { // look for newly tagged photos every 5 minutes
    await setSetting(env, 'ig_scan_at', String(now()));
    const n = await scanForPosts(env, s);
    if (n) out.found = n;
  }
  const token = await igToken(env), host = hostOf(s), uid = s.ig_user_id;

  // 1) containers Instagram is processing → publish when done
  const waiting = (await env.DB.prepare(`SELECT * FROM ig_posts WHERE status = 'container' ORDER BY updated_at LIMIT 3`).all()).results;
  for (const p of waiting) {
    try {
      const st = await ig(`${V}/${p.container_id}`, token, { fields: 'status_code,status' }, host);
      if (st.status_code === 'IN_PROGRESS') {
        if (now() - p.updated_at > 3600) throw new Error('Instagram didn’t finish processing the image within an hour');
        continue;
      }
      if (st.status_code !== 'FINISHED') throw new Error(`Instagram couldn’t process the image (${st.status || st.status_code})`);
      const pub = await igSend(`${uid}/media_publish`, token, { creation_id: p.container_id }, host);
      const m = await ig(`${V}/${pub.id}`, token, { fields: 'id,permalink,timestamp,media_type,media_product_type,caption' }, host).catch(() => ({ id: pub.id }));
      const t = now(), ts = m.timestamp ? Math.floor(Date.parse(m.timestamp) / 1000) : t;
      await env.DB.batch([
        env.DB.prepare(`UPDATE ig_posts SET status = 'published', ig_media_id = ?2, permalink = ?3, published_at = ?4, updated_at = ?4, note = NULL, src_key = NULL WHERE photo_id = ?1`)
          .bind(p.photo_id, pub.id, m.permalink || null, t),
        // the link is known — no matching needed
        env.DB.prepare(`INSERT INTO ig_media (id, post_id, position, media_type, product_type, permalink, caption, ts, like_count, comments_count, seen_at, deleted, matched_at)
           VALUES (?1, ?1, 0, 'IMAGE', ?2, ?3, ?4, ?5, 0, 0, ?6, 0, ?7) ON CONFLICT(id) DO UPDATE SET permalink = excluded.permalink, matched_at = excluded.matched_at`)
          .bind(pub.id, m.media_product_type || 'FEED', m.permalink || null, m.caption ?? p.caption, ts, Date.now(), t),
        env.DB.prepare(`INSERT INTO ig_links (ig_id, photo_id, rank, status, decided_at) VALUES (?1, ?2, 0, 'confirmed', ?3)
           ON CONFLICT(ig_id, photo_id) DO UPDATE SET status = 'confirmed', decided_at = ?3`).bind(pub.id, p.photo_id, t),
      ]);
      await dropSource(env, p.src_key);
      await log(env, 'info', `Posted photo ${p.photo_id} to Instagram${m.permalink ? `: ${m.permalink}` : ''}`);
      out.published = (out.published || 0) + 1;
    } catch (e) {
      await env.DB.prepare(`UPDATE ig_posts SET status = 'error', note = ?2, updated_at = ?3, src_key = NULL WHERE photo_id = ?1`).bind(p.photo_id, friendly(e).slice(0, 300), now()).run();
      await dropSource(env, p.src_key);
      await log(env, 'error', `Instagram post for photo ${p.photo_id} failed: ${friendly(e)}`);
    }
  }

  // 2) start the next queued post, within the daily cap and one at a time
  const day = (await env.DB.prepare(`SELECT COUNT(*) n FROM ig_posts WHERE published_at > ?1`).bind(now() - 86400).first()).n;
  const inFlight = (await env.DB.prepare(`SELECT COUNT(*) n FROM ig_posts WHERE status = 'container'`).first()).n;
  const done = () => (Object.keys(out).length ? out : null);
  if (inFlight) return done();
  if (day >= (parseInt(s.ig_daily_max) || 10)) { out.capped = true; return done(); }
  const next = await env.DB.prepare(
    `SELECT x.*, p.title, p.description, p.tags, p.raw_tags, p.status pstatus, p.is_public FROM ig_posts x JOIN photos p ON p.id = x.photo_id
     WHERE x.status = 'queued' ORDER BY x.created_at, x.photo_id LIMIT 1`
  ).first();
  if (!next) return done();
  let key = null;
  try {
    if (next.pstatus !== 'ok' || !next.is_public) throw new Error('The photo isn’t public on the site any more');
    const caption = buildCaption(next, s); // current Flickr text and tags
    key = await prepareImage(env, s, next.photo_id, next.crop);
    await env.DB.prepare(`UPDATE ig_posts SET src_key = ?2, caption = ?3, attempts = attempts + 1, updated_at = ?4 WHERE photo_id = ?1`).bind(next.photo_id, key, caption, now()).run();
    const origin = String(s.site_origin || 'https://tonyshi.photos').replace(/\/$/, '');
    const c = await igSend(`${uid}/media`, token, { image_url: `${origin}/ig-src/${key}.jpg`, caption }, host);
    await env.DB.prepare(`UPDATE ig_posts SET status = 'container', container_id = ?2, updated_at = ?3 WHERE photo_id = ?1`).bind(next.photo_id, c.id, now()).run();
    out.started = next.photo_id;
  } catch (e) {
    await env.DB.prepare(`UPDATE ig_posts SET status = 'error', note = ?2, updated_at = ?3, src_key = NULL WHERE photo_id = ?1`).bind(next.photo_id, friendly(e).slice(0, 300), now()).run();
    await dropSource(env, key);
    await log(env, 'error', `Instagram post for photo ${next.photo_id} failed: ${friendly(e)}`);
  }
  return out;
}
