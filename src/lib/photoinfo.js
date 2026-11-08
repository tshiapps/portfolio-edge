// Public photo details for the grid (hover) and the lightbox: Flickr stats, place, Getty link, Instagram,
// camera, resolution / print size, license, and views on this site. Getty sales numbers are never public.
import { safeJson, now } from './util.js';
import { getSettings } from './settings.js';
import { Flickr, loadApp } from '../flickr/api.js';
import { igToken, hostOf, ig, V } from './instagram.js';

const PUBLIC = "p.status = 'ok' AND p.is_public = 1 AND p.hidden = 0";

// Flickr license ids (flickr.photos.licenses.getInfo)
const LICENSES = {
  0: ['©', 'All rights reserved', null], 1: ['CC', 'CC BY-NC-SA 2.0', 'https://creativecommons.org/licenses/by-nc-sa/2.0/'],
  2: ['CC', 'CC BY-NC 2.0', 'https://creativecommons.org/licenses/by-nc/2.0/'], 3: ['CC', 'CC BY-NC-ND 2.0', 'https://creativecommons.org/licenses/by-nc-nd/2.0/'],
  4: ['CC', 'CC BY 2.0', 'https://creativecommons.org/licenses/by/2.0/'], 5: ['CC', 'CC BY-SA 2.0', 'https://creativecommons.org/licenses/by-sa/2.0/'],
  6: ['CC', 'CC BY-ND 2.0', 'https://creativecommons.org/licenses/by-nd/2.0/'], 7: ['PD', 'No known copyright restrictions', 'https://www.flickr.com/commons/usage/'],
  8: ['PD', 'United States Government Work', 'http://www.usa.gov/copyright.shtml'], 9: ['CC0', 'Public Domain Dedication (CC0)', 'https://creativecommons.org/publicdomain/zero/1.0/'],
  10: ['PD', 'Public Domain Mark', 'https://creativecommons.org/publicdomain/mark/1.0/'],
  11: ['CC', 'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/'], 12: ['CC', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0/'],
  13: ['CC', 'CC BY-ND 4.0', 'https://creativecommons.org/licenses/by-nd/4.0/'], 14: ['CC', 'CC BY-NC 4.0', 'https://creativecommons.org/licenses/by-nc/4.0/'],
  15: ['CC', 'CC BY-NC-SA 4.0', 'https://creativecommons.org/licenses/by-nc-sa/4.0/'], 16: ['CC', 'CC BY-NC-ND 4.0', 'https://creativecommons.org/licenses/by-nc-nd/4.0/'],
};

// place only when Flickr shows it publicly (the owner's API view also returns private locations)
function place(loc, info) {
  const l = typeof loc === 'string' ? safeJson(loc) : loc;
  if (!l) return null;
  const gp = info?.geoperms;
  if (gp && +gp.ispublic !== 1) return null;
  const city = l.locality || l.neighbourhood || l.county || null;
  return { city, region: l.region || null, country: l.country || null,
    lat: l.latitude ?? null, lon: l.longitude ?? null, accuracy: l.accuracy ?? null };
}
const placeLabel = pl => pl ? [pl.city || pl.region, pl.country].filter(Boolean).join(', ') || null : null;

// tiles: one query for the stats + one for Getty links, added to a folder / featured list
export async function decorate(env, photos) {
  if (!photos?.length) return photos;
  const ids = JSON.stringify(photos.map(p => String(p.id)));
  const [st, gt] = await Promise.all([
    env.DB.prepare(
      `SELECT p.id, p.views, p.faves, p.comments, p.galleries, p.tsp_views,
         json_extract(p.location, '$.locality') city, json_extract(p.location, '$.neighbourhood') hood, json_extract(p.location, '$.county') county,
         json_extract(p.location, '$.region') region, json_extract(p.location, '$.country') country, json_extract(p.info, '$.geoperms.ispublic') geo
       FROM photos p WHERE p.id IN (SELECT value FROM json_each(?1))`
    ).bind(ids).all(),
    env.DB.prepare(
      `SELECT COALESCE(NULLIF(a.linked_photo_id, ''), a.photo_id) pid, a.asset_id, a.page_url FROM getty_assets a
       WHERE COALESCE(NULLIF(a.linked_photo_id, ''), a.photo_id) IN (SELECT value FROM json_each(?1)) AND COALESCE(a.in_portfolio, 1) = 1 AND a.is_video = 0`
    ).bind(ids).all().catch(() => ({ results: [] })),
  ]);
  const by = new Map(st.results.map(r => [String(r.id), r]));
  const gy = new Map();
  for (const g of gt.results) if (!gy.has(g.pid)) gy.set(g.pid, g);
  for (const p of photos) {
    const r = by.get(String(p.id));
    if (r) {
      p.s = [r.views || 0, r.faves || 0, r.comments || 0, r.galleries ?? null, r.tsp_views || 0];
      if (r.geo == null || +r.geo === 1) {
        const loc = [r.city || r.hood || r.county || r.region, r.country].filter(Boolean).join(', ');
        if (loc) p.loc = loc;
      }
    }
    const g = gy.get(String(p.id));
    if (g) { p.gid = p.gid || g.asset_id; if (!p.gu && g.asset_id === p.gid) p.gu = g.page_url || null; }
  }
  return photos;
}

const exifVal = (ex, ...tags) => {
  for (const t of tags) { const i = ex?.items?.find(x => x.tag === t); if (i?.clean || i?.raw) return String(i.clean || i.raw).trim(); }
  return null;
};
function camera(ex) {
  if (!ex) return null;
  const make = exifVal(ex, 'Make'), model = exifVal(ex, 'Model');
  let cam = model ? (make && !model.toLowerCase().startsWith(make.split(/\s/)[0].toLowerCase()) ? `${make.replace(/ CORPORATION| Corporation|, Inc\.?/g, '')} ${model}` : model) : ex.camera || null;
  const lens = exifVal(ex, 'LensModel', 'Lens', 'LensInfo');
  return cam ? { camera: cam.replace(/\s+/g, ' ').trim(), lens: lens && !/^\d/.test(lens) ? lens : null } : null;
}

// Flickr galleries that include the photo: looked up when someone opens it, at most every 3 days
async function galleriesFor(env, row) {
  if (row.galleries_at && now() - row.galleries_at < 3 * 86400) return row.galleries;
  try {
    const app = await loadApp(env);
    const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?1').bind(row.account_id).first();
    if (!app || !acc) return row.galleries;
    const s = await getSettings(env);
    const fl = await Flickr.forAccount(env, app, +s.api_budget || 3000, acc);
    const d = await fl.call('flickr.galleries.getListForPhoto', { photo_id: row.id, per_page: 1 });
    const n = +d.galleries?.total || 0;
    await env.DB.prepare('UPDATE photos SET galleries = ?2, galleries_at = ?3 WHERE id = ?1').bind(row.id, n, now()).run();
    return n;
  } catch { return row.galleries; }
}

export async function photoDetail(env, id) {
  const p = await env.DB.prepare(
    `SELECT p.id, p.account_id, p.title, p.description, p.date_taken, p.license, p.views, p.faves, p.comments, p.galleries, p.galleries_at, p.tsp_views,
       p.o_width, p.o_height, p.width, p.height, p.location, p.exif, p.info, p.page_url, p.media FROM photos p WHERE p.id = ?1 AND ${PUBLIC}`
  ).bind(id).first();
  if (!p) return null;
  const info = safeJson(p.info), ex = safeJson(p.exif);
  const pl = place(p.location, info);
  const W = p.o_width || p.width, H = p.o_height || p.height;
  const lic = LICENSES[+p.license] || LICENSES[0];
  const [galleries, getty, insta] = await Promise.all([
    galleriesFor(env, p),
    env.DB.prepare(
      `SELECT a.asset_id, a.page_url, a.collection, a.license_model FROM getty_assets a
       WHERE COALESCE(NULLIF(a.linked_photo_id, ''), a.photo_id) = ?1 AND COALESCE(a.in_portfolio, 1) = 1 AND a.is_video = 0
       ORDER BY (SELECT COUNT(*) FROM getty_sales s WHERE s.asset_id = a.asset_id) DESC, a.submitted_at LIMIT 3`
    ).bind(p.id).all().then(r => r.results).catch(() => []),
    env.DB.prepare(
      `SELECT m.id, m.post_id, m.permalink, m.like_count, m.comments_count, m.ts FROM ig_links l JOIN ig_media m ON m.id = l.ig_id
       WHERE l.photo_id = ?1 AND l.status IN ('confirmed', 'auto') AND m.deleted = 0 ORDER BY m.like_count DESC`
    ).bind(p.id).all().then(r => r.results).catch(() => []),
  ]);
  // one entry per Instagram post (carousel slides share the post's likes)
  const posts = []; const seenPost = new Set();
  for (const m of insta) if (!seenPost.has(m.post_id)) { seenPost.add(m.post_id); posts.push({ id: m.post_id, url: m.permalink, likes: m.like_count || 0, comments: m.comments_count || 0, ts: m.ts }); }
  const cam = camera(ex);
  const year = /^\d{4}/.test(p.date_taken || '') ? +String(p.date_taken).slice(0, 4) : null;
  return {
    id: p.id, title: p.title || '', taken: p.date_taken || null, year,
    flickr: { url: p.page_url || null, views: p.views || 0, faves: p.faves || 0, comments: p.comments || 0, galleries: galleries ?? null },
    tsp: { views: p.tsp_views || 0 },
    place: pl ? { ...pl, label: placeLabel(pl) } : null,
    getty: getty.length ? { id: getty[0].asset_id, url: getty[0].page_url || `https://www.gettyimages.com/detail/${getty[0].asset_id}`, more: getty.length - 1 } : null,
    instagram: posts,
    camera: cam?.camera || null, lens: cam?.lens || null,
    size: W && H ? { w: W, h: H, mp: Math.round(W * H / 1e5) / 10,
      // full detail at 300 ppi; large prints viewed from further away hold up at 150 ppi
      print300: { in: [W / 300, H / 300], cm: [W / 300 * 2.54, H / 300 * 2.54] },
      print150: { in: [W / 150, H / 150], cm: [W / 150 * 2.54, H / 150 * 2.54] } } : null,
    license: { code: +p.license || 0, mark: lic[0], name: lic[1], url: lic[2] },
  };
}

const plain = html => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<img[^>]*>/gi, '').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(+c)).replace(/&nbsp;/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// every comment, shown on the site itself (Flickr: with the commenter's buddy icon; Instagram: with replies)
export async function photoComments(env, id, src) {
  const p = await env.DB.prepare(`SELECT p.id, p.account_id FROM photos p WHERE p.id = ?1 AND ${PUBLIC}`).bind(id).first();
  if (!p) return null;
  if (src === 'ig') {
    const posts = (await env.DB.prepare(
      `SELECT DISTINCT m.post_id FROM ig_links l JOIN ig_media m ON m.id = l.ig_id
       WHERE l.photo_id = ?1 AND l.status IN ('confirmed', 'auto') AND m.deleted = 0 LIMIT 5`
    ).bind(id).all()).results;
    if (!posts.length) return { comments: [] };
    const s = await getSettings(env), token = await igToken(env);
    if (!token) return { comments: [], unavailable: true };
    const out = [];
    try {
      for (const m of posts) {
        let url = `${V}/${m.post_id}/comments`, params = { fields: 'id,username,text,timestamp,like_count,replies{username,text,timestamp}', limit: '50' };
        for (let page = 0; url && page < 6; page++) {   // up to 300 per post
          const d = await ig(url, token, params, hostOf(s));
          params = {};
          for (const c of d.data || []) out.push({ who: c.username || '', text: c.text || '', at: c.timestamp ? Math.floor(Date.parse(c.timestamp) / 1000) : null,
            likes: c.like_count || 0,
            replies: (c.replies?.data || []).map(r => ({ who: r.username || '', text: r.text || '', at: r.timestamp ? Math.floor(Date.parse(r.timestamp) / 1000) : null }))
              .sort((a, b) => (a.at || 0) - (b.at || 0)) });
          url = d.paging?.next || null;
        }
      }
    } catch (e) { if (!out.length) return { comments: [], unavailable: true }; }
    out.sort((a, b) => (a.at || 0) - (b.at || 0));
    return { comments: out };
  }
  // Flickr
  const app = await loadApp(env);
  const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?1').bind(p.account_id).first();
  if (!app || !acc) return { comments: [], unavailable: true };
  const s = await getSettings(env);
  try {
    const fl = await Flickr.forAccount(env, app, +s.api_budget || 3000, acc);
    const d = await fl.call('flickr.photos.comments.getList', { photo_id: id });
    return { comments: (d.comments?.comment || []).map(c => ({
      who: c.realname || c.authorname || '', at: +c.datecreate || null, text: plain(c._content),
      icon: +c.iconserver > 0 ? `https://farm${c.iconfarm}.staticflickr.com/${c.iconserver}/buddyicons/${c.author}.jpg` : null,
    })).filter(c => c.text) };
  } catch { return { comments: [], unavailable: true }; }
}

// a lightbox open = one view; the same visitor (IP) re-opening the same photo within 30 minutes doesn't count again
export async function countView(env, id, ip) {
  const c = caches.default, k = new Request(`https://views.tsp.local/${encodeURIComponent(ip || 'x')}/${id}`);
  if (ip && await c.match(k)) return false;
  const r = await env.DB.prepare(`UPDATE photos SET tsp_views = tsp_views + 1 WHERE id = ?1 AND ${PUBLIC.replace(/p\./g, '')}`).bind(id).run();
  if (ip) await c.put(k, new Response('1', { headers: { 'cache-control': 'max-age=1800' } }));
  return r.meta.changes > 0;
}
