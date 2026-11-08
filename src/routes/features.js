// "Featured": where the work has been published. Admin (browser or the TSP Uploader token) + public list/images.
import { json, readJson, HttpError } from '../lib/util.js';

const MAX_BYTES = 15e6;
// how an image sits in its 4:3 tile: fill (cropped to fit) or whole, on a blurred copy of itself / the plain tile / white
const FITS = ['cover', 'blur', 'plain', 'white'];
const cleanFit = v => (v === 'contain' ? 'blur' : FITS.includes(v) ? v : 'cover');
const clean = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
const cleanUrl = v => {
  const s = clean(v, 500);
  if (!s) return null;
  try { const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
};
const pub = f => ({
  id: f.id, title: f.title, caption: f.caption || null, url: f.url || null, width: f.width, height: f.height, fit: f.fit === 'contain' ? 'blur' : f.fit,
  src: `/media/feature/${f.id}.jpg?v=${f.updated_at}`,
});

export async function featuresAdmin(request, env, path, url) {
  const m = request.method;
  let r;
  if (path === '/media/features' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM features ORDER BY position, created_at DESC').all();
    return json({ features: results.map(f => ({ ...f, ...pub(f) })), shown: results.filter(f => f.enabled && f.status === 'ready').length });
  }
  if (path === '/media/features' && m === 'POST') {
    const b = await readJson(request);
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    // newest first, so a fresh upload is at the top of the page
    const pos = (await env.DB.prepare('SELECT COALESCE(MIN(position), 1) - 1 p FROM features').first()).p;
    await env.DB.prepare('INSERT INTO features (id, title, caption, url, position, fit) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(id, clean(b.title, 120) || '', clean(b.caption, 200), cleanUrl(b.url), pos, cleanFit(b.fit)).run();
    return json({ ok: true, id });
  }
  if (path === '/media/features/order' && m === 'POST') {
    const ids = ((await readJson(request)).ids || []).map(String).slice(0, 1000);
    await env.DB.batch(ids.map((id, i) => env.DB.prepare('UPDATE features SET position = ?2 WHERE id = ?1').bind(id, i + 1)));
    return json({ ok: true });
  }
  if ((r = path.match(/^\/media\/features\/([0-9a-f]{16})(\/image)?$/))) {
    const f = await env.DB.prepare('SELECT * FROM features WHERE id = ?1').bind(r[1]).first();
    if (!f) throw new HttpError(404, 'No such item');
    if (r[2] && m === 'PUT') {
      const len = +request.headers.get('content-length') || 0;
      if (!len) throw new HttpError(411, 'Content-Length required');
      if (len > MAX_BYTES) throw new HttpError(413, 'Image over 15 MB — crop or shrink it first');
      const type = request.headers.get('content-type') || '';
      if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new HttpError(415, 'Send a JPEG, PNG or WebP');
      await env.BUCKET.put(`f/${f.id}.jpg`, request.body, { httpMetadata: { contentType: type } });
      const q = url.searchParams;
      await env.DB.prepare(`UPDATE features SET status = 'ready', width = ?2, height = ?3, bytes = ?4, updated_at = unixepoch() WHERE id = ?1`)
        .bind(f.id, +q.get('w') || null, +q.get('h') || null, len).run();
      return json({ ok: true });
    }
    if (!r[2] && m === 'PATCH') {
      const b = await readJson(request);
      await env.DB.prepare(`UPDATE features SET title = ?2, caption = ?3, url = ?4, enabled = ?5, fit = ?6, updated_at = unixepoch() WHERE id = ?1`)
        .bind(f.id,
          b.title !== undefined ? clean(b.title, 120) || '' : f.title,
          b.caption !== undefined ? clean(b.caption, 200) : f.caption,
          b.url !== undefined ? cleanUrl(b.url) : f.url,
          b.enabled !== undefined ? (b.enabled ? 1 : 0) : f.enabled,
          b.fit !== undefined ? cleanFit(b.fit) : f.fit).run();
      return json({ ok: true });
    }
    if (!r[2] && m === 'DELETE') {
      await env.BUCKET.delete(`f/${f.id}.jpg`);
      await env.DB.prepare('DELETE FROM features WHERE id = ?1').bind(f.id).run();
      return json({ ok: true });
    }
  }
  return null;
}

export async function featuresPublic(request, env, ctx, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  let r;
  if (url.pathname === '/api/features') {
    const { results } = await env.DB.prepare("SELECT * FROM features WHERE enabled = 1 AND status = 'ready' ORDER BY position, created_at DESC").all();
    return json({ features: results.map(pub) }, 200, { 'cache-control': 'no-cache' });
  }
  if ((r = url.pathname.match(/^\/media\/feature\/([0-9a-f]{16})\.jpg$/))) {
    const row = await env.DB.prepare("SELECT 1 FROM features WHERE id = ?1 AND status = 'ready'").bind(r[1]).first();
    if (!row) return new Response('Not found', { status: 404 });
    const cache = caches.default;
    const hit = await cache.match(request);
    if (hit) return hit;
    const obj = await env.BUCKET.get(`f/${r[1]}.jpg`);
    if (!obj) return new Response('Not found', { status: 404 });
    const res = new Response(obj.body, { headers: {
      'content-type': obj.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'public, max-age=86400', etag: obj.httpEtag } });
    ctx?.waitUntil?.(cache.put(request, res.clone()));
    return res;
  }
  return null;
}
