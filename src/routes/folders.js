// Album builder: admin CRUD + preview, and the public folder tree / folder pages behind the Photos menu.
import { json, readJson, HttpError } from '../lib/util.js';
import { decorate } from '../lib/photoinfo.js';
import { loadCtx, childrenOf, cleanRule, cleanAuto, cleanSlug, commonRule, effectiveRules, folderPhotos, autoChildren,
  gettyRanks, publicTree, resolvePath, treeVersion, scopeSql, ELIGIBLE } from '../lib/folders.js';

// gid = the Getty Images asset this photo is licensed as (for a "View on Getty Images" link); no sales numbers
const publicPhoto = ({ id, w, h, title, v }, g) => ({ id, w, h, title, v, ...(g?.get(id) ? { gid: g.get(id).asset } : {}) });

async function uniqueSlug(env, parentId, base, selfId = 0) {
  let slug = base || 'folder', i = 2;
  while (await env.DB.prepare('SELECT 1 FROM folders WHERE COALESCE(parent_id, 0) = ?1 AND slug = ?2 AND id != ?3').bind(parentId || 0, slug, selfId).first()) slug = `${base}-${i++}`;
  return slug;
}

export async function foldersAdmin(request, env, path, url) {
  const m = request.method;
  let r;

  if (path === '/folders' && m === 'GET') {
    const ctx = await loadCtx(env);
    const g = await gettyRanks(env);
    const counts = new Map((await env.DB.prepare("SELECT tag_id, COUNT(*) n FROM photo_tags WHERE source != 'removed' GROUP BY tag_id").all()).results.map(r => [r.tag_id, r.n]));
    return json({
      folders: ctx.folders.map(f => ({ ...f, common: f.rules.length ? null : commonRule(ctx, f) })),
      tags: ctx.tags.map(t => ({ ...t, n: counts.get(t.id) || 0 })), gettyLinked: g.size,
      accounts: (await env.DB.prepare('SELECT id, username FROM accounts ORDER BY id').all()).results,
    });
  }

  if (path === '/folders' && m === 'POST') {
    const b = await readJson(request);
    const title = String(b.title || '').trim().slice(0, 80);
    if (!title) throw new HttpError(400, 'Name required');
    const parent = b.parent_id ? +b.parent_id : null;
    if (parent && !(await env.DB.prepare('SELECT 1 FROM folders WHERE id = ?1').bind(parent).first())) throw new HttpError(400, 'No such parent folder');
    const slug = await uniqueSlug(env, parent, cleanSlug(b.slug || title));
    const pos = (await env.DB.prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM folders WHERE COALESCE(parent_id, 0) = ?1').bind(parent || 0).first()).p;
    const rules = (Array.isArray(b.rules) ? b.rules : []).slice(0, 12).map(cleanRule);
    const f = await env.DB.prepare('INSERT INTO folders (parent_id, title, slug, position, rules) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING *')
      .bind(parent, title, slug, pos, JSON.stringify(rules)).first();
    return json({ ok: true, folder: f });
  }

  if (path === '/folders/preview' && m === 'POST') {
    // draft folder (unsaved edits) → its photos, the place sub-folders, and how many photos fit before "top N"
    const b = await readJson(request);
    const ctx = await loadCtx(env);
    const base = b.id ? ctx.byId.get(+b.id) : null;
    const draft = {
      ...(base || { id: -1, position: 0, hidden: 0 }),
      parent_id: b.parent_id ? +b.parent_id : null,
      title: String(b.title || base?.title || ''),
      rules: (Array.isArray(b.rules) ? b.rules : []).slice(0, 12).map(cleanRule),
      within_parent: b.within_parent === false ? 0 : 1,
      auto: cleanAuto(b.auto),
    };
    ctx.byId.set(draft.id, draft);
    if (base) Object.assign(base, draft); // so sub-folders' "common tag" sees the draft too
    const g = await gettyRanks(env);
    const [photos, places, fits] = await Promise.all([
      folderPhotos(ctx, draft), autoChildren(ctx, draft),
      env.DB.prepare(`SELECT COUNT(*) n FROM photos p WHERE ${ELIGIBLE} AND ${scopeSql(ctx, draft)}`).first(),
    ]);
    return json({
      rules: effectiveRules(ctx, draft), fits: fits.n, places,
      photos: photos.map(p => ({ ...publicPhoto(p, g), score: p.score, getty: g.get(p.id)?.sales || 0, earned: Math.round(g.get(p.id)?.royalty || 0) })),
    });
  }

  if ((r = path.match(/^\/folders\/(\d+)(\/move)?$/))) {
    const id = +r[1];
    const f = await env.DB.prepare('SELECT * FROM folders WHERE id = ?1').bind(id).first();
    if (!f) throw new HttpError(404, 'No such folder');

    if (r[2] && m === 'POST') {
      const dir = (await readJson(request)).dir < 0 ? -1 : 1;
      const sibs = (await env.DB.prepare('SELECT id, position FROM folders WHERE COALESCE(parent_id, 0) = ?1 ORDER BY position, id').bind(f.parent_id || 0).all()).results;
      const i = sibs.findIndex(s => s.id === id), j = i + dir;
      if (j < 0 || j >= sibs.length) return json({ ok: true });
      [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
      await env.DB.batch(sibs.map((s, k) => env.DB.prepare('UPDATE folders SET position = ?2, updated_at = unixepoch() WHERE id = ?1').bind(s.id, k + 1)));
      return json({ ok: true });
    }

    if (m === 'PATCH') {
      const b = await readJson(request);
      let parent = b.parent_id !== undefined ? (b.parent_id ? +b.parent_id : null) : f.parent_id;
      if (parent) {
        // no folder inside itself or its own sub-folders
        for (let p = parent, n = 0; p && n < 20; n++) {
          if (p === id) throw new HttpError(400, 'A folder can’t go inside itself or one of its sub-folders');
          p = (await env.DB.prepare('SELECT parent_id FROM folders WHERE id = ?1').bind(p).first())?.parent_id;
        }
      }
      const title = b.title !== undefined ? String(b.title).trim().slice(0, 80) : f.title;
      if (!title) throw new HttpError(400, 'Name required');
      const slug = await uniqueSlug(env, parent, cleanSlug(b.slug ?? f.slug) || cleanSlug(title), id);
      const rules = b.rules !== undefined ? JSON.stringify((Array.isArray(b.rules) ? b.rules : []).slice(0, 12).map(cleanRule)) : f.rules;
      const auto = b.auto !== undefined ? JSON.stringify(cleanAuto(b.auto)) : f.auto;
      const pos = parent !== f.parent_id
        ? (await env.DB.prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM folders WHERE COALESCE(parent_id, 0) = ?1').bind(parent || 0).first()).p : f.position;
      const row = await env.DB.prepare(
        `UPDATE folders SET parent_id = ?2, title = ?3, slug = ?4, rules = ?5, auto = ?6, within_parent = ?7, hidden = ?8, position = ?9,
           display = ?10, updated_at = unixepoch() WHERE id = ?1 RETURNING *`
      ).bind(id, parent, title, slug, rules, auto,
        b.within_parent !== undefined ? (b.within_parent ? 1 : 0) : f.within_parent,
        b.hidden !== undefined ? (b.hidden ? 1 : 0) : f.hidden, pos,
        b.display !== undefined ? (b.display === 'random' ? 'random' : 'popular') : f.display).first();
      return json({ ok: true, folder: row });
    }

    if (m === 'DELETE') {
      // its sub-folders move up one level rather than disappearing
      await env.DB.batch([
        env.DB.prepare('UPDATE folders SET parent_id = ?2, updated_at = unixepoch() WHERE parent_id = ?1').bind(id, f.parent_id),
        env.DB.prepare('DELETE FROM folders WHERE id = ?1').bind(id),
      ]);
      return json({ ok: true });
    }
  }
  return null;
}

// ---------- public ----------
async function cached(request, env, ctx, key, build) {
  // + the UTC date: folders with a "random" rule pick again each day
  const k = new Request(`${new URL(request.url).origin}/__folders/${await treeVersion(env)}-${new Date().toISOString().slice(0, 10)}/${key}`);
  const c = caches.default;
  // the edge keeps a copy until something changes (the key moves on); browsers always ask again
  const fresh = r => { const x = new Response(r.body, r); x.headers.set('cache-control', 'no-cache'); return x; };
  const hit = await c.match(k);
  if (hit) return fresh(hit);
  const res = json(await build(), 200, { 'cache-control': 'public, max-age=3600' });
  ctx?.waitUntil?.(c.put(k, res.clone()));
  return fresh(res);
}

export async function foldersPublic(request, env, ctx, url) {
  if (request.method !== 'GET') return null;
  if (url.pathname === '/api/folders') {
    return cached(request, env, ctx, 'tree', async () => ({ folders: await publicTree(await loadCtx(env)) }));
  }
  if (url.pathname === '/api/folder') {
    const path = String(url.searchParams.get('path') || '').replace(/[^a-z0-9/-]/gi, '').toLowerCase();
    return cached(request, env, ctx, 'f/' + encodeURIComponent(path), async () => {
      const c = await loadCtx(env);
      const hit = await resolvePath(c, path);
      if (!hit) return { error: 'not found', photos: [] };
      const { folder, crumbs } = hit;
      const kids = folder.virtual ? [] : [
        ...childrenOf(c, folder.id).filter(f => !f.hidden).map(f => ({ title: f.title, path: `${path}/${f.slug}` })),
        ...(await autoChildren(c, folder)).filter(a => !childrenOf(c, folder.id).some(f => f.slug === a.slug)).map(a => ({ title: a.title, path: `${path}/${a.slug}` })),
      ];
      const g = await gettyRanks(env);
      return { title: folder.title, path, display: folder.display === 'random' ? 'random' : 'popular', crumbs: crumbs.map(({ title, path }) => ({ title, path })), children: kids, photos: await decorate(env, (await folderPhotos(c, folder)).map(p => publicPhoto(p, g))) };
    });
  }
  return null;
}
