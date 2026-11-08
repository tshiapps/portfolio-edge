// Instagram: connection + sync (admin), the Mac matcher's input/results (token-scoped under /media/ig),
// and the review queue where you confirm or reject the matcher's pairs.
import { json, readJson, HttpError, now } from '../lib/util.js';
import { getSettings, setSetting } from '../lib/settings.js';
import { scanForPosts, buildCaption } from '../lib/igpublish.js';
import { saveToken, syncInstagram, igImage, IgError } from '../lib/instagram.js';

const ELIGIBLE = "p.status = 'ok' AND p.is_public = 1";

async function status(env) {
  const s = await getSettings(env);
  const c = await env.DB.prepare(`SELECT
      COUNT(*) images, COUNT(DISTINCT post_id) posts,
      SUM(EXISTS (SELECT 1 FROM ig_links l WHERE l.ig_id = m.id AND l.status = 'confirmed')) confirmed,
      SUM(EXISTS (SELECT 1 FROM ig_links l WHERE l.ig_id = m.id AND l.status = 'auto')
          AND NOT EXISTS (SELECT 1 FROM ig_links l WHERE l.ig_id = m.id AND l.status = 'confirmed')) auto,
      SUM(EXISTS (SELECT 1 FROM ig_links l WHERE l.ig_id = m.id AND l.status = 'review')
          AND NOT EXISTS (SELECT 1 FROM ig_links l WHERE l.ig_id = m.id AND l.status IN ('confirmed', 'auto'))) review,
      SUM(m.matched_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ig_links l WHERE l.ig_id = m.id AND l.status IN ('confirmed', 'auto', 'review'))) unmatched,
      SUM(m.matched_at IS NULL) unchecked
    FROM ig_media m WHERE m.deleted = 0`).first();
  const linked = (await env.DB.prepare("SELECT COUNT(DISTINCT photo_id) n FROM ig_links WHERE status IN ('confirmed', 'auto')").first()).n;
  return {
    connected: !!s.ig_token, username: s.ig_username || null, lastSync: +s.ig_last_sync || null, tokenAt: +s.ig_token_at || null,
    error: s.ig_error || null, counts: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v || 0])), photosLinked: linked,
  };
}

// ---------- posting from Flickr ----------
const PUB_KEYS = { on: 'ig_publish', tag: 'ig_magic_tag', prefix: 'ig_hashtag_prefix', manual: 'ig_manual_word', fit: 'ig_fit', daily: 'ig_daily_max' };
async function publishState(env) {
  const s = await getSettings(env);
  const counts = Object.fromEntries((await env.DB.prepare('SELECT status, COUNT(*) n FROM ig_posts GROUP BY status').all()).results.map(r => [r.status, r.n]));
  const day = (await env.DB.prepare('SELECT COUNT(*) n FROM ig_posts WHERE published_at > ?1').bind(now() - 86400).first()).n;
  const { results } = await env.DB.prepare(
    `SELECT x.*, p.title, p.description, p.tags, p.raw_tags, p.synced_at v, p.width pw, p.height ph FROM ig_posts x LEFT JOIN photos p ON p.id = x.photo_id
     ORDER BY CASE x.status WHEN 'container' THEN 0 WHEN 'crop' THEN 1 WHEN 'queued' THEN 1 WHEN 'error' THEN 2 WHEN 'held' THEN 3 WHEN 'skipped' THEN 4 ELSE 5 END,
       COALESCE(x.published_at, x.created_at) DESC LIMIT 150`
  ).all();
  return {
    settings: { on: s.ig_publish === '1', tag: s.ig_magic_tag, prefix: s.ig_hashtag_prefix, manual: s.ig_manual_word, fit: s.ig_fit, daily: +s.ig_daily_max || 10 },
    counts, last24h: day,
    posts: results.map(({ description, tags, raw_tags, ...x }) => ({
      ...x,
      // what would go out now (Flickr text may have changed since it was queued)
      preview: x.status === 'published' ? x.caption : buildCaption({ title: x.title, description, tags, raw_tags }, s),
    })),
  };
}

// what the review / matched / unmatched lists show
async function list(env, view, offset) {
  const where = {
    review: `EXISTS (SELECT 1 FROM ig_links l WHERE l.ig_id = m.id AND l.status = 'review') AND NOT EXISTS (SELECT 1 FROM ig_links l WHERE l.ig_id = m.id AND l.status IN ('confirmed', 'auto'))`,
    matched: `EXISTS (SELECT 1 FROM ig_links l WHERE l.ig_id = m.id AND l.status IN ('confirmed', 'auto'))`,
    unmatched: `m.matched_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ig_links l WHERE l.ig_id = m.id AND l.status IN ('confirmed', 'auto', 'review'))`,
    unchecked: 'm.matched_at IS NULL',
  }[view] || '1';
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.post_id, m.position, m.media_type, m.product_type, m.permalink, m.caption, m.ts, m.like_count, m.comments_count, m.matched_at FROM ig_media m WHERE m.deleted = 0 AND ${where} ORDER BY m.ts DESC, m.position LIMIT 60 OFFSET ?1`
  ).bind(offset).all();
  if (!results.length) return [];
  const links = (await env.DB.prepare(
    `SELECT l.*, p.title, p.synced_at v, p.date_taken, p.account_id FROM ig_links l JOIN photos p ON p.id = l.photo_id
     WHERE l.ig_id IN (SELECT value FROM json_each(?1)) AND l.status != 'rejected' ORDER BY l.ig_id, l.rank`
  ).bind(JSON.stringify(results.map(r => r.id))).all()).results;
  const by = new Map();
  for (const l of links) (by.get(l.ig_id) ?? by.set(l.ig_id, []).get(l.ig_id)).push(l);
  return results.map(m => ({ ...m, candidates: by.get(m.id) || [] }));
}

export async function instagramAdmin(request, env, path, url) {
  const m = request.method;
  let r;
  try {
    // ---------- admin (browser) ----------
    if (path === '/ig/status' && m === 'GET') return json(await status(env));
    if (path === '/ig/token' && m === 'POST') {
      const b = await readJson(request);
      const me = await saveToken(env, b.token, b.ig_id);
      let synced = null;
      try { synced = await syncInstagram(env); } catch (e) { synced = { error: e.message }; }
      return json({ ok: true, username: me.username, synced });
    }
    if (path === '/ig/publish' && m === 'GET') return json(await publishState(env));
    if (path === '/ig/publish/settings' && m === 'POST') {
      const b = await readJson(request), s = await getSettings(env);
      if (b.tag != null) { const t = String(b.tag).trim(); if (!/^[\w-]{2,40}$/.test(t)) throw new HttpError(400, 'Magic tag: letters, numbers and hyphens'); await setSetting(env, PUB_KEYS.tag, t); }
      if (b.prefix != null) { const t = String(b.prefix).trim(); if (!/^[\w-]{2,40}$/.test(t)) throw new HttpError(400, 'Hashtag prefix: letters, numbers and hyphens'); await setSetting(env, PUB_KEYS.prefix, t); }
      if (b.manual != null) { const t = String(b.manual).trim().toLowerCase(); if (!/^[a-z0-9]{2,30}$/.test(t)) throw new HttpError(400, 'Manual-crop word: letters and numbers only'); await setSetting(env, PUB_KEYS.manual, t); }
      if (b.fit != null) await setSetting(env, PUB_KEYS.fit, b.fit === 'crop' ? 'crop' : 'pad');
      if (b.daily != null) await setSetting(env, PUB_KEYS.daily, String(Math.min(50, Math.max(1, parseInt(b.daily) || 10))));
      if (b.on != null) {
        const on = !!b.on;
        if (on && s.ig_publish !== '1') {
          await setSetting(env, 'ig_primed', '0'); // photos already carrying the tag wait for your OK
          await setSetting(env, 'ig_scan_at', '0');
          if (url.protocol === 'https:' && !url.hostname.endsWith('.workers.dev')) await setSetting(env, 'site_origin', url.origin);
        }
        await setSetting(env, PUB_KEYS.on, on ? '1' : '0');
      }
      return json(await publishState(env));
    }
    if (path === '/ig/publish/scan' && m === 'POST') {
      const found = await scanForPosts(env, await getSettings(env));
      return json({ found, ...(await publishState(env)) });
    }
    if ((r = path.match(/^\/ig\/publish\/(\d+)$/)) && m === 'POST') {
      const { action, crop } = await readJson(request);
      const x = await env.DB.prepare('SELECT status FROM ig_posts WHERE photo_id = ?1').bind(r[1]).first();
      if (!x) throw new HttpError(404, 'Not in the list');
      if (action === 'crop') { // save a hand crop and queue the post (or just the crop, for a post that's queued anyway)
        if (!['crop', 'held', 'skipped', 'error', 'cancelled', 'queued'].includes(x.status)) throw new HttpError(409, `It’s ${x.status}`);
        const c = crop && { x: +crop.x, y: +crop.y, w: +crop.w, h: +crop.h };
        if (!c || ![c.x, c.y, c.w, c.h].every(Number.isFinite) || c.x < 0 || c.y < 0 || c.w <= 0 || c.h <= 0 || c.x + c.w > 1.001 || c.y + c.h > 1.001) throw new HttpError(400, 'Bad crop');
        await env.DB.prepare(`UPDATE ig_posts SET crop = ?2, status = 'queued', note = NULL, updated_at = ?3 WHERE photo_id = ?1`).bind(r[1], JSON.stringify(c), now()).run();
      } else if (action === 'nocrop') {
        await env.DB.prepare(`UPDATE ig_posts SET crop = NULL, updated_at = ?2 WHERE photo_id = ?1`).bind(r[1], now()).run();
      } else if (action === 'publish') {
        if (!['held', 'skipped', 'error', 'cancelled', 'crop'].includes(x.status)) throw new HttpError(409, `It’s ${x.status}`);
        await env.DB.prepare(`UPDATE ig_posts SET status = 'queued', note = NULL, updated_at = ?2 WHERE photo_id = ?1`).bind(r[1], now()).run();
      } else if (action === 'cancel') {
        if (!['held', 'queued', 'error', 'skipped', 'crop'].includes(x.status)) throw new HttpError(409, `It’s ${x.status}`);
        await env.DB.prepare(`UPDATE ig_posts SET status = 'cancelled', updated_at = ?2 WHERE photo_id = ?1`).bind(r[1], now()).run();
      } else throw new HttpError(400, 'Unknown action');
      return json(await publishState(env));
    }
    if (path === '/ig/sync' && m === 'POST') return json({ ok: true, ...(await syncInstagram(env) || {}) });
    if (path === '/ig/list' && m === 'GET') return json({ items: await list(env, url.searchParams.get('view'), Math.max(0, +url.searchParams.get('offset') || 0)) });
    if (path === '/ig/decide' && m === 'POST') {
      const b = await readJson(request);
      const ig = String(b.ig_id || ''), pid = String(b.photo_id || '');
      if (!ig) throw new HttpError(400, 'ig_id required');
      const t = now();
      if (b.action === 'confirm') {
        if (!pid) throw new HttpError(400, 'photo_id required');
        if (!await env.DB.prepare(`SELECT 1 FROM photos WHERE id = ?1 AND status != 'deleted'`).bind(pid).first()) throw new HttpError(404, 'No such photo on the site');
        // one Instagram image ↔ one photo: confirming a pair rules out the other candidates
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO ig_links (ig_id, photo_id, rank, status, decided_at) VALUES (?1, ?2, 0, 'confirmed', ?3)
             ON CONFLICT(ig_id, photo_id) DO UPDATE SET status = 'confirmed', decided_at = ?3`).bind(ig, pid, t),
          env.DB.prepare(`UPDATE ig_links SET status = 'rejected', decided_at = ?3 WHERE ig_id = ?1 AND photo_id != ?2 AND status IN ('auto', 'review')`).bind(ig, pid, t),
        ]);
      } else if (b.action === 'reject') {
        await env.DB.prepare(`UPDATE ig_links SET status = 'rejected', decided_at = ?3 WHERE ig_id = ?1 AND photo_id = ?2`).bind(ig, pid, t).run();
      } else if (b.action === 'none') { // "this one isn't on the site"
        await env.DB.prepare(`UPDATE ig_links SET status = 'rejected', decided_at = ?2 WHERE ig_id = ?1 AND status != 'rejected'`).bind(ig, t).run();
      } else if (b.action === 'reset') {
        await env.DB.prepare(`DELETE FROM ig_links WHERE ig_id = ?1`).bind(ig).run();
        await env.DB.prepare(`UPDATE ig_media SET matched_at = NULL WHERE id = ?1`).bind(ig).run();
      } else throw new HttpError(400, 'Unknown action');
      return json({ ok: true });
    }

    // ---------- images (admin page and the Mac) ----------
    if ((r = path.match(/^\/(?:media\/)?ig\/img\/(\d+)$/)) && m === 'GET') {
      const res = await igImage(env, r[1]);
      return new Response(res.body, { headers: { 'content-type': res.headers.get('content-type') || 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
    }

    // ---------- the Mac matcher (upload token) ----------
    if (path === '/media/ig/input' && m === 'GET') {
      const [photos, media, decided] = await Promise.all([
        env.DB.prepare(`SELECT p.id, p.synced_at v, p.date_taken, p.date_upload FROM photos p WHERE ${ELIGIBLE} ORDER BY p.id`).all(),
        env.DB.prepare('SELECT id, post_id, ts, media_type, product_type, matched_at, media_url FROM ig_media WHERE deleted = 0 ORDER BY ts DESC').all(),
        env.DB.prepare("SELECT ig_id, photo_id, status FROM ig_links WHERE status IN ('confirmed', 'rejected')").all(),
      ]);
      return json({ photos: photos.results, ig: media.results, decided: decided.results });
    }
    if ((r = path.match(/^\/media\/ig\/photo\/(\d+)$/)) && m === 'GET') {
      const obj = await env.BUCKET.get(`t/${r[1]}.webp`);
      if (!obj) throw new HttpError(404, 'No stored copy');
      return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType || 'image/webp', 'cache-control': 'private, max-age=86400' } });
    }
    if (path === '/media/ig/results' && m === 'POST') {
      const b = await readJson(request);
      const t = now();
      let n = 0;
      for (const res of (b.results || []).slice(0, 2000)) {
        const ig = String(res.ig_id || '');
        if (!/^\d+$/.test(ig)) continue;
        const stmts = [
          // fresh guesses replace the old ones; your own decisions (confirmed / rejected) are never touched
          env.DB.prepare(`DELETE FROM ig_links WHERE ig_id = ?1 AND status IN ('auto', 'review')`).bind(ig),
          env.DB.prepare('UPDATE ig_media SET matched_at = ?2 WHERE id = ?1').bind(ig, t),
        ];
        (res.candidates || []).slice(0, 5).forEach((c, i) => {
          const st = c.status === 'auto' ? 'auto' : 'review';
          stmts.push(env.DB.prepare(
            `INSERT INTO ig_links (ig_id, photo_id, rank, score, cos, inliers, status)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
             WHERE NOT EXISTS (SELECT 1 FROM ig_links WHERE ig_id = ?1 AND status = 'confirmed')
             ON CONFLICT(ig_id, photo_id) DO NOTHING`
          ).bind(ig, String(c.photo_id), i, +c.score || 0, +c.cos || 0, Math.round(+c.inliers || 0), st));
        });
        await env.DB.batch(stmts);
        n++;
      }
      return json({ ok: true, saved: n });
    }
  } catch (e) {
    if (e instanceof IgError) throw new HttpError(e.code === 190 ? 401 : 502, e.code === 190 ? 'Instagram token expired or revoked — paste a new one' : e.message);
    throw e;
  }
  return null;
}
