// Getty ↔ site photo linking: portfolio import (DeepMeta CSV), the Mac matcher's input/results (token-scoped
// under /media/getty) and the review queue. Same shape as Instagram (routes/instagram.js).
import { json, readJson, HttpError, now } from '../lib/util.js';
import { importPortfolio, resolveLinks } from '../lib/gettyportfolio.js';

const ELIGIBLE = "p.status = 'ok'";
// assets the matcher works on: in the portfolio, photos (not video)
const MATCHABLE = "a.in_portfolio = 1 AND a.is_video = 0";
const LINKED = `(a.linked_photo_id IS NOT NULL AND a.linked_photo_id != '') OR EXISTS (SELECT 1 FROM getty_links l WHERE l.asset_id = a.asset_id AND l.status IN ('confirmed', 'auto'))`;
const VIEWS = {
  review: `NOT (${LINKED}) AND EXISTS (SELECT 1 FROM getty_links l WHERE l.asset_id = a.asset_id AND l.status = 'review')`,
  matched: LINKED,
  unmatched: `a.matched_at IS NOT NULL AND NOT (${LINKED}) AND NOT EXISTS (SELECT 1 FROM getty_links l WHERE l.asset_id = a.asset_id AND l.status = 'review')`,
  unchecked: `a.matched_at IS NULL AND NOT (${LINKED})`,
};

async function status(env) {
  const c = await env.DB.prepare(`SELECT COUNT(*) assets,
      SUM(${VIEWS.matched}) matched, SUM(${VIEWS.review}) review, SUM(${VIEWS.unmatched}) unmatched, SUM(${VIEWS.unchecked}) unchecked
    FROM getty_assets a WHERE ${MATCHABLE}`).first();
  const other = await env.DB.prepare(`SELECT SUM(in_portfolio = 1 AND is_video = 1) videos, SUM(in_portfolio = 0) gone,
      SUM(in_portfolio = 1) portfolio, (SELECT COUNT(DISTINCT asset_id) FROM getty_sales) sold FROM getty_assets`).first();
  const last = await env.DB.prepare('SELECT * FROM getty_portfolio_imports ORDER BY id DESC LIMIT 5').all();
  const how = Object.fromEntries((await env.DB.prepare(
    `SELECT how, COUNT(DISTINCT asset_id) n FROM getty_links WHERE status = 'confirmed' GROUP BY how`).all()).results.map(r => [r.how || 'you', r.n]));
  return { counts: Object.fromEntries(Object.entries({ ...c, ...other }).map(([k, v]) => [k, v || 0])), confirmedBy: how, imports: last.results };
}

async function list(env, view, offset, q) {
  const where = VIEWS[view] || '1';
  const args = [offset];
  let search = '';
  if (q) { args.push(`%${q.replace(/[%_]/g, '')}%`, q); search = ` AND (a.title LIKE ?2 OR a.keywords LIKE ?2 OR a.object_name LIKE ?2 OR a.city LIKE ?2 OR a.asset_id = ?3)`; }
  const { results } = await env.DB.prepare(
    `SELECT a.asset_id, a.artist, a.title, a.description, a.object_name, a.collection, a.created_on, a.submitted_at, a.city, a.state, a.country,
       a.page_url, a.thumb_url, a.width, a.height, a.matched_at, a.linked_photo_id,
       (SELECT COUNT(*) FROM getty_sales s WHERE s.asset_id = a.asset_id) sales
     FROM getty_assets a WHERE ${MATCHABLE} AND ${where}${search} ORDER BY a.submitted_at DESC LIMIT 60 OFFSET ?1`
  ).bind(...args).all();
  if (!results.length) return [];
  const links = (await env.DB.prepare(
    `SELECT l.*, p.title ptitle, p.synced_at v FROM getty_links l JOIN photos p ON p.id = l.photo_id
     WHERE l.asset_id IN (SELECT value FROM json_each(?1)) AND l.status != 'rejected' ORDER BY l.asset_id, l.status = 'confirmed' DESC, l.rank`
  ).bind(JSON.stringify(results.map(r => r.asset_id))).all()).results;
  const by = new Map();
  for (const l of links) (by.get(l.asset_id) ?? by.set(l.asset_id, []).get(l.asset_id)).push({ ...l, title: l.ptitle });
  return results.map(a => ({ ...a, candidates: by.get(a.asset_id) || [] }));
}

export async function gettyMatchAdmin(request, env, path, url) {
  const m = request.method;
  let r;

  // ---------- admin (browser) ----------
  if (path === '/getty/portfolio/import' && m === 'POST') {
    const b = await readJson(request);
    if (!b.text || typeof b.text !== 'string') throw new HttpError(400, 'No file content');
    if (b.text.length > 20e6) throw new HttpError(413, 'File too large');
    try { return json({ ok: true, file: b.file, ...(await importPortfolio(env, b.text, b.file || '')) }); }
    catch (e) { throw new HttpError(400, `${b.file || 'file'}: ${e.message}`); }
  }
  if (path === '/getty/match/status' && m === 'GET') return json(await status(env));
  if (path === '/getty/match/list' && m === 'GET') {
    return json({ items: await list(env, url.searchParams.get('view'), Math.max(0, +url.searchParams.get('offset') || 0), (url.searchParams.get('q') || '').trim()) });
  }
  if (path === '/getty/match/decide' && m === 'POST') {
    const b = await readJson(request);
    const a = String(b.asset_id || ''), pid = String(b.photo_id || '');
    if (!/^\d+$/.test(a)) throw new HttpError(400, 'asset_id required');
    const t = now();
    if (b.action === 'confirm') {
      if (!await env.DB.prepare(`SELECT 1 FROM photos WHERE id = ?1 AND status != 'deleted'`).bind(pid).first()) throw new HttpError(404, 'No such photo on the site');
      // one Getty asset ↔ one photo (a photo can have several Getty assets: different crops, edits, accounts)
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO getty_links (asset_id, photo_id, rank, status, how, decided_at) VALUES (?1, ?2, 0, 'confirmed', 'you', ?3)
           ON CONFLICT(asset_id, photo_id) DO UPDATE SET status = 'confirmed', how = 'you', decided_at = ?3`).bind(a, pid, t),
        env.DB.prepare(`UPDATE getty_links SET status = 'rejected', decided_at = ?3 WHERE asset_id = ?1 AND photo_id != ?2 AND status != 'rejected'`).bind(a, pid, t),
        env.DB.prepare(`UPDATE getty_assets SET linked_photo_id = NULL WHERE asset_id = ?1 AND linked_photo_id != ?2`).bind(a, pid),
      ]);
    } else if (b.action === 'reject') {
      await env.DB.batch([
        env.DB.prepare(`UPDATE getty_links SET status = 'rejected', decided_at = ?3 WHERE asset_id = ?1 AND photo_id = ?2`).bind(a, pid, t),
        env.DB.prepare(`UPDATE getty_assets SET linked_photo_id = NULL WHERE asset_id = ?1 AND linked_photo_id = ?2`).bind(a, pid),
      ]);
    } else if (b.action === 'none') {
      await env.DB.prepare(`UPDATE getty_links SET status = 'rejected', decided_at = ?2 WHERE asset_id = ?1 AND status != 'rejected'`).bind(a, t).run();
    } else if (b.action === 'reset') {
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM getty_links WHERE asset_id = ?1 AND how IS NOT 'filename'`).bind(a),
        env.DB.prepare(`UPDATE getty_assets SET matched_at = NULL, linked_photo_id = NULL WHERE asset_id = ?1`).bind(a),
      ]);
    } else throw new HttpError(400, 'Unknown action');
    await resolveLinks(env, a);
    return json({ ok: true });
  }

  // ---------- the Mac matcher (upload token) ----------
  if (path === '/media/getty/input' && m === 'GET') {
    const [photos, assets, decided] = await Promise.all([
      env.DB.prepare(`SELECT p.id, p.synced_at v FROM photos p WHERE ${ELIGIBLE} ORDER BY p.id`).all(),
      env.DB.prepare(`SELECT a.asset_id id, a.thumb_url, a.page_url, a.matched_at, a.width w, a.height h, (${LINKED}) linked
        FROM getty_assets a WHERE ${MATCHABLE} ORDER BY a.submitted_at DESC`).all(),
      env.DB.prepare(`SELECT asset_id, photo_id, status FROM getty_links WHERE status IN ('confirmed', 'rejected')
        UNION SELECT asset_id, linked_photo_id, 'confirmed' FROM getty_assets WHERE linked_photo_id IS NOT NULL AND linked_photo_id != ''`).all(),
    ]);
    return json({ photos: photos.results, assets: assets.results, decided: decided.results });
  }
  if (path === '/media/getty/thumbs' && m === 'POST') { // preview links the Mac found (Getty's embed lookup) — the admin pages use them too
    const b = await readJson(request);
    const st = (b.items || []).slice(0, 500).filter(x => /^\d+$/.test(x.id) && /^https:\/\/[a-z0-9.-]*gettyimages\.com\//.test(x.thumb_url || ''))
      .map(x => env.DB.prepare(`UPDATE getty_assets SET thumb_url = ?2, preview_status = 'ok', fetched_at = ?3 WHERE asset_id = ?1 AND thumb_url IS NULL`).bind(x.id, x.thumb_url, now()));
    for (let i = 0; i < st.length; i += 100) await env.DB.batch(st.slice(i, i + 100));
    return json({ ok: true, saved: st.length });
  }
  if (path === '/media/getty/results' && m === 'POST') {
    const b = await readJson(request);
    const t = now();
    let n = 0;
    for (const res of (b.results || []).slice(0, 2000)) {
      const a = String(res.asset_id || res.ext_id || '');
      if (!/^\d+$/.test(a)) continue;
      const stmts = [
        env.DB.prepare(`DELETE FROM getty_links WHERE asset_id = ?1 AND status IN ('auto', 'review')`).bind(a),
        env.DB.prepare('UPDATE getty_assets SET matched_at = ?2 WHERE asset_id = ?1').bind(a, t),
      ];
      (res.candidates || []).slice(0, 5).forEach((c, i) => {
        stmts.push(env.DB.prepare(
          `INSERT INTO getty_links (asset_id, photo_id, rank, score, cos, inliers, status, how)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'matcher'
           WHERE NOT EXISTS (SELECT 1 FROM getty_links WHERE asset_id = ?1 AND status = 'confirmed')
           ON CONFLICT(asset_id, photo_id) DO NOTHING`
        ).bind(a, String(c.photo_id), i, +c.score || 0, +c.cos || 0, Math.round(+c.inliers || 0), c.status === 'auto' ? 'auto' : 'review'));
      });
      await env.DB.batch(stmts);
      n++;
    }
    await resolveLinks(env);
    return json({ ok: true, saved: n });
  }
  return null;
}
