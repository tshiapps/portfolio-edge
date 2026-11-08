// Background video clips: admin management (browser or Mac uploader token) + public playlist and
// Range-capable file serving. Files live in R2 at v/<id>/{desktop.mp4,mobile.mp4,poster.jpg}.
import { json, readJson, HttpError, now } from '../lib/util.js';
import { createToken } from '../lib/tokens.js';

const VARIANTS = {
  desktop: { file: 'desktop.mp4', type: 'video/mp4', col: 'desktop_bytes', max: 60e6 },
  mobile: { file: 'mobile.mp4', type: 'video/mp4', col: 'mobile_bytes', max: 30e6 },
  poster: { file: 'poster.jpg', type: 'image/jpeg', col: 'poster_bytes', max: 3e6 },
};
const PAGES = ['aerial'];
const key = (id, v) => `v/${id}/${VARIANTS[v].file}`;

function publicClip(c) {
  const v = c.updated_at;
  if (c.kind === 'photo') {
    return {
      kind: 'photo', id: c.id, title: c.title, caption: c.caption || null, overlay: c.overlay || 'auto', duration: c.duration || 7,
      width: c.width, height: c.height, src: `/img/${c.photo_id}/${c.photo_reel_w ? 'r' : 'm'}?v=${c.photo_v || v}`,
    };
  }
  return {
    kind: 'video', caption: c.caption || null, overlay: c.overlay || 'auto',
    id: c.id, title: c.title, duration: c.duration, width: c.width, height: c.height,
    desktop: `/media/${c.id}/desktop.mp4?v=${v}`,
    mobile: c.mobile_bytes ? `/media/${c.id}/mobile.mp4?v=${v}` : null,
    poster: `/media/${c.id}/poster.jpg?v=${v}`,
  };
}

// ---------- admin: /api/admin/media/* and /api/admin/tokens/* ----------

export async function mediaAdmin(request, env, path) {
  const m = request.method;
  let r;

  if (path === '/media' && m === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT m.*, p.synced_at photo_v, p.reel_w photo_reel_w, p.is_public photo_public, p.hidden photo_hidden, p.status photo_status
       FROM media_clips m LEFT JOIN photos p ON p.id = m.photo_id
       ORDER BY m.page, CASE m.status WHEN 'ready' THEN 0 ELSE 1 END, m.position, m.created_at`
    ).all();
    return json({ clips: results.map(c => ({
      ...c, urls: publicClip(c),
      // a photo slide only shows publicly if the photo itself is public, stored and not hidden
      photo_visible: c.kind === 'photo' ? !!(c.photo_public && !c.photo_hidden && c.photo_status === 'ok') : undefined,
    })) });
  }

  if (path === '/media' && m === 'POST') {
    const b = await readJson(request);
    const page = PAGES.includes(b.page) ? b.page : 'aerial';
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    await env.DB.prepare(
      `INSERT INTO media_clips (id, page, title, source_name, duration, width, height)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    ).bind(id, page, String(b.title || '').slice(0, 200), String(b.source_name || '').slice(0, 300),
      +b.duration || null, +b.width || null, +b.height || null).run();
    return json({ id });
  }

  // add catalog photos to the reel (appended at the end)
  if (path === '/media/photos' && m === 'POST') {
    const b = await readJson(request);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter(x => /^\d+$/.test(x)).slice(0, 100);
    if (!ids.length) throw new HttpError(400, 'No photos');
    let pos = (await env.DB.prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS n FROM media_clips WHERE page = 'aerial' AND status = 'ready'"
    ).first()).n;
    const added = [];
    for (const pid of ids) {
      const p = await env.DB.prepare("SELECT id, title, width, height FROM photos WHERE id = ?1 AND status = 'ok'").bind(pid).first();
      if (!p) continue;
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      await env.DB.prepare(
        `INSERT INTO media_clips (id, page, kind, photo_id, title, status, position, duration, width, height)
         VALUES (?1, 'aerial', 'photo', ?2, ?3, 'ready', ?4, 7, ?5, ?6)`
      ).bind(id, p.id, p.title || '', pos++, p.width, p.height).run();
      added.push(id);
      // the Mac app makes its extra-large copy next time it runs (the photo stays up meanwhile)
      await env.DB.prepare('UPDATE photos SET refetch = 1, attempts = 0, error = NULL WHERE id = ?1 AND reel_w IS NULL').bind(p.id).run();
    }
    return json({ ok: true, added: added.length });
  }

  if (path === '/media/order' && m === 'POST') {
    const b = await readJson(request);
    const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
    if (!ids.length) throw new HttpError(400, 'ids required');
    await env.DB.batch(ids.map((id, i) => env.DB.prepare(
      'UPDATE media_clips SET position = ?2, updated_at = updated_at WHERE id = ?1'
    ).bind(id, i)));
    return json({ ok: true });
  }

  if ((r = path.match(/^\/media\/([0-9a-f]{16})\/file\/(desktop|mobile|poster)$/)) && m === 'PUT') {
    const [, id, variant] = r;
    const clip = await env.DB.prepare('SELECT id FROM media_clips WHERE id = ?1').bind(id).first();
    if (!clip) throw new HttpError(404, 'No such clip');
    const len = +request.headers.get('content-length') || 0;
    const V = VARIANTS[variant];
    if (!len) throw new HttpError(411, 'Content-Length required');
    if (len > V.max) throw new HttpError(413, `${variant} file too large (${(len / 1e6).toFixed(1)} MB > ${V.max / 1e6} MB)`);
    await env.BUCKET.put(key(id, variant), request.body, {
      httpMetadata: { contentType: V.type }, customMetadata: { clip: id },
    });
    await env.DB.prepare(`UPDATE media_clips SET ${V.col} = ?2, updated_at = ?3 WHERE id = ?1`).bind(id, len, now()).run();
    return json({ ok: true, bytes: len });
  }

  if ((r = path.match(/^\/media\/([0-9a-f]{16})\/finalize$/)) && m === 'POST') {
    const c = await env.DB.prepare('SELECT * FROM media_clips WHERE id = ?1').bind(r[1]).first();
    if (!c) throw new HttpError(404, 'No such clip');
    if (!c.desktop_bytes || !c.poster_bytes) throw new HttpError(400, 'Upload desktop.mp4 and poster.jpg first');
    const pos = (await env.DB.prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS n FROM media_clips WHERE page = ?1 AND status = 'ready'"
    ).bind(c.page).first()).n;
    await env.DB.prepare("UPDATE media_clips SET status = 'ready', position = ?2, updated_at = ?3 WHERE id = ?1")
      .bind(c.id, c.status === 'ready' ? c.position : pos, now()).run();
    return json({ ok: true, id: c.id, position: pos });
  }

  if ((r = path.match(/^\/media\/([0-9a-f]{16})$/))) {
    const c = await env.DB.prepare('SELECT * FROM media_clips WHERE id = ?1').bind(r[1]).first();
    if (!c) throw new HttpError(404, 'No such clip');
    if (m === 'PATCH') {
      const b = await readJson(request);
      const dur = b.duration !== undefined && c.kind === 'photo' ? Math.min(30, Math.max(3, +b.duration || 7)) : null;
      await env.DB.prepare(
        `UPDATE media_clips SET title = COALESCE(?2, title), enabled = COALESCE(?3, enabled), updated_at = ?4,
           caption = CASE WHEN ?5 = 1 THEN ?6 ELSE caption END, duration = COALESCE(?7, duration),
           overlay = COALESCE(?8, overlay) WHERE id = ?1`
      ).bind(c.id, b.title !== undefined ? String(b.title).slice(0, 200) : null,
        b.enabled !== undefined ? (b.enabled ? 1 : 0) : null, now(),
        b.caption !== undefined ? 1 : 0, b.caption !== undefined ? String(b.caption).slice(0, 200) : null, dur,
        ['auto', 'licensing', 'brand', 'prints'].includes(b.overlay) ? b.overlay : null).run();
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      await env.BUCKET.delete(Object.keys(VARIANTS).map(v => key(c.id, v)));
      await env.DB.prepare('DELETE FROM media_clips WHERE id = ?1').bind(c.id).run();
      return json({ ok: true });
    }
  }

  // Tokens — browser admin only (index.js never lets a bearer token reach these paths).
  if (path === '/tokens' && m === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, name, prefix, scope, created_at, last_used_at, revoked_at FROM api_tokens ORDER BY id DESC'
    ).all();
    return json({ tokens: results });
  }
  if (path === '/tokens' && m === 'POST') {
    const b = await readJson(request);
    const name = String(b.name || '').trim().slice(0, 100) || 'Mac uploader';
    return json({ token: await createToken(env, name, 'media') });
  }
  if ((r = path.match(/^\/tokens\/(\d+)$/)) && m === 'DELETE') {
    await env.DB.prepare('UPDATE api_tokens SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL').bind(+r[1], now()).run();
    return json({ ok: true });
  }

  return null;
}

// ---------- public ----------

export async function mediaPublic(request, env, url) {
  let r;
  if ((r = url.pathname.match(/^\/api\/(aerial)$/)) && request.method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT m.*, p.synced_at photo_v, p.reel_w photo_reel_w FROM media_clips m LEFT JOIN photos p ON p.id = m.photo_id
       WHERE m.page = ?1 AND m.status = 'ready' AND m.enabled = 1
         AND (m.kind != 'photo' OR (p.status = 'ok' AND p.is_public = 1 AND p.hidden = 0))
       ORDER BY m.position, m.created_at`
    ).bind(r[1]).all();
    return json({ clips: results.map(publicClip) }, 200, { 'cache-control': 'public, max-age=60' });
  }

  if ((r = url.pathname.match(/^\/media\/([0-9a-f]{16})\/(desktop\.mp4|mobile\.mp4|poster\.jpg)$/)) && ['GET', 'HEAD'].includes(request.method)) {
    const [, id, file] = r;
    const ok = await env.DB.prepare("SELECT 1 FROM media_clips WHERE id = ?1 AND status = 'ready' AND enabled = 1").bind(id).first();
    if (!ok) return new Response('Not found', { status: 404 });
    const k = `v/${id}/${file}`;
    // Parse Range ourselves and hand R2 explicit numbers — browsers always ask for ranges before playing video.
    const head = await env.BUCKET.head(k);
    if (!head) return new Response('Not found', { status: 404 });
    const size = head.size;
    const headers = new Headers({
      'content-type': head.httpMetadata?.contentType || 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=86400',
      etag: head.httpEtag,
    });
    const m = /^bytes=(\d*)-(\d*)$/.exec((request.headers.get('range') || '').trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      let start, end;
      if (m[1] === '') { start = Math.max(0, size - +m[2]); end = size - 1; }          // bytes=-N (last N)
      else { start = +m[1]; end = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1); } // bytes=a- / bytes=a-b
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
      }
      const length = end - start + 1;
      headers.set('content-range', `bytes ${start}-${end}/${size}`);
      headers.set('content-length', String(length));
      if (request.method === 'HEAD') return new Response(null, { status: 206, headers });
      const obj = await env.BUCKET.get(k, { range: { offset: start, length } });
      return new Response(obj.body, { status: 206, headers });
    }
    headers.set('content-length', String(size));
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    const obj = await env.BUCKET.get(k);
    return new Response(obj.body, { status: 200, headers });
  }
  return null;
}
