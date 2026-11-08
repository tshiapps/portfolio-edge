// Two stored sizes, to stay inside R2's free 10 GB:
//  • "showcase" photos — the ones visitors actually open: in the album-builder folders (incl. the city
//    sub-folders), on the Aerial reel, and the front page when it shows "top N" — keep the big size (4K);
//  • everything else is stored at the smaller base size (2048 px).
// The site works out the showcase set itself; photos that need the big size are queued for the Mac app
// (it downloads the original), and photos that no longer need it are shrunk here from the stored copy.
import { loadCtx, folderPhotos, autoChildren, placeFolder, ELIGIBLE } from './folders.js';
import { setSetting, log } from './settings.js';
import { now } from './util.js';

export const baseEdge = s => parseInt(s.base_edge) || 2048;
export const showEdge = s => parseInt(s.long_edge) || 3840;
// a photo's settings = the global ones, overridden by its account's (Dashboard → account → Sizes)
export const forAccount = (s, acc) => ({
  ...s,
  long_edge: acc?.long_edge ? String(acc.long_edge) : s.long_edge,
  base_edge: acc?.base_edge ? String(acc.base_edge) : s.base_edge,
  quality: acc?.quality ? String(acc.quality) : s.quality,
});
// the long edge a stored photo should have (SQL, per row): showcase → big size, else base size, per account
const target = s => `(CASE WHEN photos.showcase = 1
    THEN COALESCE((SELECT a.long_edge FROM accounts a WHERE a.id = photos.account_id), ${showEdge(s)})
    ELSE COALESCE((SELECT a.base_edge FROM accounts a WHERE a.id = photos.account_id), ${baseEdge(s)}) END)`;
// stored copy is landscape/portrait (not a panorama — panoramas keep their own sizing)
const notPano = s => {
  const W = 'COALESCE(o_width, width, 0)', H = 'COALESCE(o_height, height, 0)';
  return `(MAX(${W}, ${H}) * 1.0 / MAX(1, MIN(${W}, ${H}))) < ${parseFloat(s.pano_ratio) || 2.2}`;
};
const stored = 'MAX(COALESCE(width, 0), COALESCE(height, 0))';
const orig = 'COALESCE(NULLIF(MAX(COALESCE(o_width, 0), COALESCE(o_height, 0)), 0), 99999)';

export async function showcaseIds(env, s) {
  const ctx = await loadCtx(env);
  const ids = new Set();
  for (const f of ctx.folders) {
    if (f.hidden) continue;
    for (const p of await folderPhotos(ctx, f)) ids.add(p.id);
    if (f.auto) for (const a of await autoChildren(ctx, f)) {
      const pf = placeFolder(f, ctx.tagBySlug.get(a.slug));
      ctx.byId.set(pf.id, pf);
      for (const p of await folderPhotos(ctx, pf)) ids.add(p.id);
    }
  }
  const reel = (await env.DB.prepare("SELECT DISTINCT photo_id id FROM media_clips WHERE kind = 'photo' AND photo_id IS NOT NULL").all()).results;
  reel.forEach(r => ids.add(r.id));
  if (s.front_mode === 'top') {
    const top = (await env.DB.prepare(`SELECT p.id FROM photos p WHERE ${ELIGIBLE} ORDER BY COALESCE(p.pop_score, 0) DESC LIMIT ?1`)
      .bind(Math.max(1, parseInt(s.front_top_n) || 100)).all()).results;
    top.forEach(r => ids.add(r.id));
  }
  if (s.featured_album) {
    (await env.DB.prepare('SELECT photo_id id FROM album_photos WHERE album_id = ?1').bind(s.featured_album).all()).results.forEach(r => ids.add(r.id));
  }
  return [...ids];
}

// Recompute when folders / front page / reel change, and every 30 minutes anyway (tags and popularity move).
export async function refreshShowcase(env, s, { force = false } = {}) {
  const f = await env.DB.prepare('SELECT COUNT(*) n, MAX(updated_at) u FROM folders').first();
  const ac = await env.DB.prepare("SELECT group_concat(id || ':' || COALESCE(long_edge, '') || ':' || COALESCE(base_edge, '') || ':' || COALESCE(quality, ''), ',') k FROM accounts").first();
  const r = await env.DB.prepare("SELECT COUNT(*) n, MAX(updated_at) u FROM media_clips WHERE kind = 'photo'").first();
  const ver = [f.n, f.u, r.n, r.u, s.front_mode, s.front_top_n, s.featured_album, s.long_edge, s.base_edge, ac?.k, Math.floor(now() / 1800)].join('|');
  if (!force && ver === s.showcase_ver) return null;
  const ids = JSON.stringify(await showcaseIds(env, s));
  const inSet = 'id IN (SELECT value FROM json_each(?1))';
  await env.DB.prepare(`UPDATE photos SET showcase = CASE WHEN ${inSet} THEN 1 ELSE 0 END
     WHERE showcase != CASE WHEN ${inSet} THEN 1 ELSE 0 END`).bind(ids).run();
  // …and only when Flickr gave us something bigger than what's stored last time we looked (or that was > 30 days ago)
  const canGrow = `(best_edge IS NULL OR best_edge > ${stored} + 64 OR COALESCE(best_at, 0) < ${now() - 30 * 86400})`;
  const T = target(s), small = `${notPano(s)} AND ${stored} < MIN(${T}, ${orig}) - 64 AND ${canGrow}`;
  // upgrade work that isn't wanted any more (e.g. the earlier "upgrade everything" queue)
  const cancelled = (await env.DB.prepare(`UPDATE photos SET refetch = 0 WHERE refetch = 1 AND status = 'ok' AND NOT (${small})
     AND NOT (reel_w IS NULL AND id IN (SELECT photo_id FROM media_clips WHERE kind = 'photo'))`).run()).meta.changes || 0;
  // photos stored smaller than their account's size for them → the Mac app fetches the original
  const queued = (await env.DB.prepare(`UPDATE photos SET refetch = 1, attempts = 0, error = NULL, lease_until = NULL
     WHERE status = 'ok' AND refetch = 0 AND ${small}`).run()).meta.changes || 0;
  await setSetting(env, 'showcase_ver', ver);
  if (queued || cancelled) await log(env, 'info', `Sizes: ${queued} photo(s) queued for the big size (Mac app)${cancelled ? `, ${cancelled} big-size upgrade(s) no longer needed` : ''}`);
  return { queued, cancelled };
}

// Shrink stored copies that are bigger than they need to be — from R2, no Flickr download.
export async function shrinkLoop(env, s, deadline, summary) {
  if (!env.IMAGES) return;
  const accs = new Map((await env.DB.prepare('SELECT id, long_edge, base_edge, quality FROM accounts').all()).results.map(a => [a.id, a]));
  let budget = 40; // per sync run — at most ~80 image transformations a minute, well inside the free allowance
  while (budget > 0 && Date.now() < deadline - 6000) {
    const { results } = await env.DB.prepare(
      `SELECT id, account_id, showcase FROM photos WHERE status = 'ok' AND refetch = 0 AND ${notPano(s)}
         AND ${stored} > ${target(s)} + 64 AND (lease_until IS NULL OR lease_until < ?1) LIMIT 8`
    ).bind(now()).all();
    if (!results.length) return;
    for (const p of results) {
      budget--;
      const ps = forAccount(s, accs.get(p.account_id)), B = p.showcase ? showEdge(ps) : baseEdge(ps), Q = parseInt(ps.quality) || 75;
      // claim it; if the result is somehow still too big, it isn't retried for a day
      await env.DB.prepare('UPDATE photos SET lease_until = ?2 WHERE id = ?1').bind(p.id, now() + 86400).run();
      try {
        const obj = await env.BUCKET.get(`m/${p.id}.jpg`);
        if (!obj) { await env.DB.prepare('UPDATE photos SET lease_until = ?2 WHERE id = ?1').bind(p.id, now() + 86400).run(); continue; }
        const out = await (await env.IMAGES.input(obj.body).transform({ width: B, height: B, fit: 'scale-down' })
          .output({ format: 'image/jpeg', quality: Q })).response().arrayBuffer();
        const info = await env.IMAGES.info(new Blob([out]).stream());
        await env.BUCKET.put(`m/${p.id}.jpg`, out, { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: { ...(obj.customMetadata || {}), resized: 'shrunk' } });
        await env.DB.prepare('UPDATE photos SET width = ?2, height = ?3, bytes = ?4, synced_at = ?5, lease_until = CASE WHEN ?2 > ?6 OR ?3 > ?6 THEN lease_until ELSE NULL END WHERE id = ?1')
          .bind(p.id, info.width, info.height, out.byteLength, now(), B + 64).run();
        summary.shrunk = (summary.shrunk || 0) + 1;
      } catch (e) {
        await env.DB.prepare('UPDATE photos SET lease_until = ?2 WHERE id = ?1').bind(p.id, now() + 3600).run();
        console.error('shrink failed', p.id, e.message);
      }
    }
  }
}

export async function sizeStatus(env, s) {
  const B = baseEdge(s), L = showEdge(s), T = target(s);
  const r = await env.DB.prepare(`SELECT
      SUM(showcase = 1) showcase,
      SUM(refetch = 1) waiting_mac,
      SUM(refetch = 0 AND ${notPano(s)} AND ${stored} > ${T} + 64) to_shrink,
      SUM(showcase = 1 AND ${notPano(s)} AND ${stored} >= MIN(${T}, ${orig}) - 64) showcase_done
    FROM photos WHERE status = 'ok'`).first();
  return { base: B, big: L, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v || 0])) };
}

// Rough storage if an account used these sizes / quality — from what its stored photos weigh today.
const QF = q => 0.25 + 0.75 * Math.pow(Math.max(30, Math.min(100, q)) / 75, 2.2); // JPEG size vs quality, ≈1 at 75
export async function estimateAccount(env, s, accId, { long, base, quality }) {
  const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?1').bind(accId).first();
  const cur = forAccount(s, acc), R = parseFloat(s.pano_ratio) || 2.2;
  const { results } = await env.DB.prepare(`SELECT width, height, bytes, thumb_bytes, o_width, o_height, showcase, status, synced_at
    FROM photos WHERE account_id = ?1 AND status != 'deleted'`).bind(accId).all();
  let px = 0, by = 0, thumbs = 0, nThumbs = 0;
  for (const p of results) if (p.status === 'ok' && p.width && p.bytes) { px += p.width * p.height; by += p.bytes; if (p.thumb_bytes) { thumbs += p.thumb_bytes; nThumbs++; } }
  const bpp = px ? by / px / QF(parseInt(cur.quality) || 75) : 0.12; // bytes per pixel at quality 75
  const tb = nThumbs ? thumbs / nThumbs : 90e3;
  let total = 0, n = 0;
  for (const p of results) {
    const w = +p.o_width || +p.width || 0, h = +p.o_height || +p.height || 0;
    if (!w || !h) continue;
    n++;
    const ratio = Math.max(w, h) / Math.min(w, h);
    if (ratio >= R) { total += (p.bytes || 2e6) + tb; continue; } // panoramas keep their own sizing
    const T = p.showcase ? long : base, f = Math.min(1, T / Math.max(w, h));
    total += w * h * f * f * bpp * QF(quality) + tb;
  }
  return { photos: n, bytes: Math.round(total), now: by + thumbs };
}
