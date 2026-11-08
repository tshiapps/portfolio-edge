// Public API: site config, weekly featured selection, gated image serving, inquiry form.
import { json, err, readJson, HttpError } from '../lib/util.js';
import { getSettings } from '../lib/settings.js';
import { mediaPublic } from './media.js';
import { foldersPublic } from './folders.js';
import { featuresPublic } from './features.js';
import { gettyRanks } from '../lib/folders.js';
import { decorate, photoDetail, photoComments, countView } from '../lib/photoinfo.js';
import { catalogTree, albumPhotos, searchPhotos, catalogFacets, catalogGeo, rollIndex, rollMonth } from '../lib/catalog.js';
import { inquiryConfig, sendEmail, fromVisitor } from '../lib/inquiry.js';

// ---------- weekly featured selection ----------

function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return ((h >>> 0) + 1) / 4294967298;
}

// v0 algorithm (to be designed further): weighted random sample, re-seeded each ISO week.
// Weight favours faves, views, comments and recent uploads; an optional pinned local album goes first.
async function featured(env) {
  const s = await getSettings(env);
  const n = parseInt(s.featured_count) || 60;
  const week = isoWeek();
  const eligible = "p.status = 'ok' AND p.is_public = 1 AND p.hidden = 0 AND p.media = 'photo'";
  let pinned = [];
  if (s.featured_album) {
    pinned = (await env.DB.prepare(
      `SELECT p.id, p.thumb_w w, p.thumb_h h, p.title, p.synced_at v FROM album_photos ap JOIN photos p ON p.id = ap.photo_id
       WHERE ap.album_id = ?1 AND ${eligible} ORDER BY ap.position LIMIT ?2`
    ).bind(s.featured_album, n).all()).results;
  }
  if (s.front_mode === 'top') {
    // Most popular N by the admin-tuned score; optionally re-shuffled weekly so the page still feels fresh.
    const topN = Math.max(1, parseInt(s.front_top_n) || 100);
    const taken0 = new Set(pinned.map(p => p.id));
    const top = (await env.DB.prepare(
      `SELECT p.id, p.thumb_w w, p.thumb_h h, p.title, p.synced_at v FROM photos p WHERE ${eligible}
       ORDER BY COALESCE(p.pop_score, 0) DESC, p.id LIMIT ?1`
    ).bind(topN + pinned.length).all()).results.filter(p => !taken0.has(p.id)).slice(0, Math.max(0, topN - pinned.length));
    // re-shuffle weekly (ISO week) or daily (UTC date); 'rank' keeps score order
    const seed = s.front_order === 'daily' ? new Date().toISOString().slice(0, 10) : week;
    if (s.front_order !== 'rank') top.sort((a, b) => hash01(`${seed}/order:${a.id}`) - hash01(`${seed}/order:${b.id}`));
    return { week, mode: 'top', photos: [...pinned, ...top].map(({ id, w, h, title, v }) => ({ id, w, h, title, v })) };
  }
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.thumb_w w, p.thumb_h h, p.title, p.synced_at v, p.views, p.faves, p.comments, p.date_upload FROM photos p WHERE ${eligible}`
  ).all();
  const t = Date.now() / 1000;
  const taken = new Set(pinned.map(p => p.id));
  const picks = results
    .filter(p => !taken.has(p.id))
    .map(p => {
      const w = 1 + Math.log10(1 + (p.views || 0)) + 2 * Math.log10(1 + (p.faves || 0)) + Math.log10(1 + (p.comments || 0))
        + (t - (p.date_upload || 0) < 90 * 86400 ? 1.5 : 0);
      return { p, k: Math.pow(hash01(`${week}:${p.id}`), 1 / w) };
    })
    .sort((a, b) => b.k - a.k)
    .slice(0, Math.max(0, n - pinned.length))
    .map(x => x.p)
    .sort((a, b) => hash01(`${week}/order:${a.id}`) - hash01(`${week}/order:${b.id}`));
  return { week, photos: [...pinned, ...picks].map(({ id, w, h, title, v }) => ({ id, w, h, title, v })) };
}

// ---------- inquiry ----------

// "Photo #52759839641 …" → a link to the image on the site, so you see which one they mean
const photoLink = (request, asset) => {
  const id = /#?\b(\d{8,12})\b/.exec(asset)?.[1];
  return id ? `${new URL(request.url).origin}/img/${id}/m` : null;
};

async function inquiry(request, env) {
  const b = await readJson(request);
  if (b.website) return json({ ok: true }); // honeypot
  const name = String(b.name || '').trim().slice(0, 200);
  const email = String(b.email || '').trim().slice(0, 200);
  const subject = String(b.subject || '').trim().slice(0, 200);
  const message = String(b.message || '').trim().slice(0, 10000);
  const asset = String(b.asset || '').trim().slice(0, 300);
  if (!name || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Please fill in your name, a valid email and a message.');
  const cfg = await inquiryConfig(env);
  if (!cfg.siteKey || !cfg.turnstileSecret || !cfg.resendKey || !cfg.to) throw new HttpError(503, 'The inquiry form is not configured yet.');

  const form = new FormData();
  form.append('secret', cfg.turnstileSecret);
  form.append('response', String(b.token || ''));
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) form.append('remoteip', ip);
  const ts = await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })).json();
  if (!ts.success) throw new HttpError(403, 'Anti-bot check failed — please try again.');

  try {
    await sendEmail(cfg, {
      subject: `[tonyshi.photos] ${subject || (asset ? 'Photo inquiry' : 'New inquiry')} — ${name}`,
      text: `From: ${name} <${email}>\nSubject: ${subject || '(none)'}\n`
        + (asset ? `Photo / asset: ${asset}\n` + (photoLink(request, asset) ? `Image: ${photoLink(request, asset)}\n` : '') : '')
        + `IP: ${ip || 'unknown'}\n\n${message}\n`,
      replyTo: email,
      from: fromVisitor(cfg, name),
    });
  } catch (e) {
    console.error(e.message);
    throw new HttpError(502, 'Could not send right now — please try again later.');
  }
  return json({ ok: true });
}

// ---------- images (public, ok, not hidden only) ----------

// hotlink protection: another site embedding the photos gets a 403. No Referer (direct link, apps, email,
// link previews) is fine; so are this site, its subdomains and the search engines in the allow list.
async function hotlinked(request, env) {
  const ref = request.headers.get('referer');
  if (!ref) return false;
  const s = await getSettings(env);
  if (s.hotlink_protect === '0') return false;
  let host;
  try { host = new URL(ref).hostname.toLowerCase(); } catch { return false; }
  const own = new URL(request.url).hostname.toLowerCase().replace(/^www\./, '');
  if (host === own || host.endsWith('.' + own) || host === 'localhost') return false;
  const allow = String(s.hotlink_allow || '').split(/[\s,]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
  return !allow.some(a => host.includes(a));
}

// s = tiny square (120 px) for the camera roll: made once from the thumbnail and kept in R2 (≈3 KB each);
// remade if the thumbnail changes; if Images can't make it, the normal thumbnail is served instead
async function tiny(env, id) {
  const [t, s] = await Promise.all([env.BUCKET.head(`t/${id}.webp`), env.BUCKET.get(`s/${id}.webp`)]);
  if (!t) return s;
  if (s && s.customMetadata?.src === t.etag) return s;
  try {
    const src = await env.BUCKET.get(`t/${id}.webp`);
    const out = await (await env.IMAGES.input(src.body).transform({ width: 120, height: 120, fit: 'cover' }).output({ format: 'image/webp', quality: 60 })).response();
    const buf = await out.arrayBuffer();
    await env.BUCKET.put(`s/${id}.webp`, buf, { httpMetadata: { contentType: 'image/webp' }, customMetadata: { src: t.etag } });
    return { body: buf, httpMetadata: { contentType: 'image/webp' }, httpEtag: `"s-${t.etag}"` };
  } catch {
    return env.BUCKET.get(`t/${id}.webp`);
  }
}

async function image(request, env, ctx, id, variant) {
  if (await hotlinked(request, env)) return new Response('Photos on tonyshi.photos can’t be embedded on other sites.', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  const row = await env.DB.prepare(
    "SELECT 1 FROM photos WHERE id = ?1 AND status = 'ok' AND is_public = 1 AND hidden = 0"
  ).bind(id).first();
  if (!row) return new Response('Not found', { status: 404 });
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  // r = extra-large copy for the Aerial reel (falls back to the master until the Mac app has made it)
  const obj = variant === 's' ? await tiny(env, id)
    : (variant === 'r' && await env.BUCKET.get(`r/${id}.jpg`)) || await env.BUCKET.get(variant === 't' ? `t/${id}.webp` : `m/${id}.jpg`);
  if (!obj) return new Response('Not found', { status: 404 });
  const res = new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType || 'image/jpeg',
      'cache-control': 'public, max-age=86400',
      etag: obj.httpEtag,
    },
  });
  ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}

export async function publicApi(request, env, ctx, url) {
  const path = url.pathname;
  const m = request.method;
  let r;
  const feat = await featuresPublic(request, env, ctx, url);
  if (feat) return feat;
  const media = await mediaPublic(request, env, url);
  if (media) return media;
  if ((r = path.match(/^\/img\/(\d+)\/(t|m|r|s)$/)) && m === 'GET') return image(request, env, ctx, r[1], r[2]);
  if (path === '/api/config' && m === 'GET') {
    const cfg = await inquiryConfig(env);
    return json({ siteName: env.SITE_NAME, turnstileSiteKey: cfg.siteKey, inquiryReady: !!(cfg.siteKey && cfg.turnstileSecret && cfg.resendKey && cfg.to) },
      200, { 'cache-control': 'public, max-age=60' });
  }
  if (path === '/api/featured' && m === 'GET') {
    const f = await featured(env), g = await gettyRanks(env);
    for (const p of f.photos) if (g.get(p.id)) p.gid = g.get(p.id).asset; // link to the Getty Images page, nothing more
    await decorate(env, f.photos);
    return json(f, 200, { 'cache-control': 'public, max-age=600' });
  }
  // lightbox details (cached briefly at the edge), comments on demand, and a view count per open
  if ((r = path.match(/^\/api\/photo\/(\d+)(\/comments)?$/)) && m === 'GET') {
    const c = caches.default, hit = await c.match(request);
    if (hit) return hit;
    const d = r[2] ? await photoComments(env, r[1], url.searchParams.get('src') === 'ig' ? 'ig' : 'flickr') : await photoDetail(env, r[1]);
    if (!d) return err('Not found', 404);
    const res = json(d, 200, { 'cache-control': `public, max-age=${r[2] ? 900 : 300}` });
    ctx.waitUntil(c.put(request, res.clone()));
    return res;
  }
  if ((r = path.match(/^\/api\/photo\/(\d+)\/view$/)) && m === 'POST') {
    await countView(env, r[1], request.headers.get('cf-connecting-ip'));
    return new Response(null, { status: 204 });
  }
  if (path === '/api/inquiry' && m === 'POST') return inquiry(request, env);
  // footer Getty icon → your Getty page (set in Settings), else Getty's photographer search for the portfolio's artist name
  if (path === '/api/go/getty' && m === 'GET') {
    const s = await getSettings(env);
    let to = /^https:\/\/([a-z0-9-]+\.)*gettyimages\.[a-z.]+\//i.test(s.getty_profile_url || '') ? s.getty_profile_url : null;
    if (!to) {
      const a = await env.DB.prepare("SELECT artist, COUNT(*) n FROM getty_assets WHERE artist IS NOT NULL AND artist != '' AND COALESCE(in_portfolio, 1) = 1 GROUP BY artist ORDER BY n DESC LIMIT 1").first().catch(() => null);
      to = a ? 'https://www.gettyimages.com/search/photographer?photographer=' + encodeURIComponent(a.artist) : 'https://www.gettyimages.com/';
    }
    return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'public, max-age=3600' } });
  }
  // catalog: tree / facets / map points are cached at the edge until photos or albums change (or 30 min pass)
  if (path.startsWith('/api/catalog/') && m === 'GET') {
    const what = path.slice('/api/catalog/'.length);
    const build = { tree: () => catalogTree(env), facets: () => catalogFacets(env), geo: () => catalogGeo(env),
      album: () => albumPhotos(env, url.searchParams.get('id') || ''), search: () => searchPhotos(env, url.searchParams),
      roll: () => url.searchParams.get('m') ? rollMonth(env, url.searchParams.get('m')) : rollIndex(env) }[what];
    if (!build) return err('Not found', 404);
    // cache version: two settings rows (bumped when photos are re-indexed / tags change), album changes, and a 30-minute clock
    // + when albums last changed (title / order / photos) — a few hundred rows, cheap
    const vs = (await env.DB.prepare(
      "SELECT value FROM settings WHERE key IN ('catalog_ver', 'content_ver') UNION ALL SELECT MAX(updated_at) FROM albums"
    ).all()).results;
    const ver = vs.map(r => r.value).join('-');
    const qs = new URLSearchParams([...url.searchParams].filter(([k]) => k !== '_').sort(([a], [b]) => a.localeCompare(b)));
    const key = new Request(`${url.origin}/__catalog/${ver}-${Math.floor(Date.now() / 1800e3)}/${what}?${qs}`);
    const c = caches.default, hit = await c.match(key);
    const fresh = r => { const x = new Response(r.body, r); x.headers.set('cache-control', 'public, max-age=60'); return x; };
    if (hit) return fresh(hit);
    const d = await build();
    if (!d) return err('Not found', 404);
    const res = json(d, 200, { 'cache-control': 'public, max-age=1800' });
    ctx.waitUntil(c.put(key, res.clone()));
    return fresh(res);
  }
  const fo = await foldersPublic(request, env, ctx, url);
  if (fo) return fo;
  return err('Not found', 404);
}
