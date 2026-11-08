// Admin → Tags: the scheme (create/edit/delete), re-apply rules, and the export/import used for Claude's pass.
import { json, readJson, HttpError, safeJson, chunk } from '../lib/util.js';
import { loadScheme, applyRules, setTags, norm, bumpContent } from '../lib/tagging.js';

const cleanSlug = s => norm(s).slice(0, 60);
const selIds = b => {
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(String).filter(x => /^\d+$/.test(x)))] : [];
  if (!ids.length) throw new HttpError(400, 'No photo ids');
  if (ids.length > 20000) throw new HttpError(400, 'Too many ids');
  return ids;
};

export async function tagsAdmin(request, env, path, url) {
  const m = request.method;
  let r;

  if (path === '/tags' && m === 'GET') {
    const [tags, counts, totals] = await Promise.all([
      env.DB.prepare('SELECT * FROM site_tags ORDER BY kind, position, label COLLATE NOCASE').all(),
      env.DB.prepare(`SELECT tag_id, COUNT(*) n, SUM(source = 'ai') ai, SUM(source = 'manual') manual
        FROM photo_tags WHERE source != 'removed' GROUP BY tag_id`).all(),
      env.DB.prepare(`SELECT COUNT(*) photos,
        SUM(NOT EXISTS (SELECT 1 FROM photo_tags pt JOIN site_tags t ON t.id = pt.tag_id WHERE pt.photo_id = p.id AND t.kind = 'content' AND pt.source != 'removed')) no_content,
        SUM(NOT EXISTS (SELECT 1 FROM photo_tags pt JOIN site_tags t ON t.id = pt.tag_id WHERE pt.photo_id = p.id AND t.kind = 'location' AND pt.source != 'removed')) no_location
        FROM photos p WHERE p.status != 'deleted'`).first(),
    ]);
    const c = Object.fromEntries(counts.results.map(x => [x.tag_id, x]));
    return json({ totals, tags: tags.results.map(t => ({ ...t, aliases: safeJson(t.aliases, []), count: c[t.id]?.n || 0, ai: c[t.id]?.ai || 0, manual: c[t.id]?.manual || 0 })) });
  }

  if (path === '/tags' && m === 'POST') {
    const b = await readJson(request);
    const label = String(b.label || '').trim().slice(0, 80);
    if (!label) throw new HttpError(400, 'Name required');
    const slug = cleanSlug(b.slug || label);
    if (!slug) throw new HttpError(400, 'Name needs letters or digits');
    if (await env.DB.prepare('SELECT 1 FROM site_tags WHERE slug = ?1').bind(slug).first()) throw new HttpError(409, `Tag "${slug}" already exists`);
    const kind = b.kind === 'location' ? 'location' : 'content';
    const aliases = [...new Set((b.aliases || []).map(norm).filter(Boolean))];
    const t = await env.DB.prepare('INSERT INTO site_tags (slug, label, kind, parent_id, aliases) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING *')
      .bind(slug, label, kind, b.parent_id ? +b.parent_id : null, JSON.stringify(aliases)).first();
    return json({ ok: true, tag: t });
  }

  if ((r = path.match(/^\/tags\/(\d+)$/))) {
    const t = await env.DB.prepare('SELECT * FROM site_tags WHERE id = ?1').bind(+r[1]).first();
    if (!t) throw new HttpError(404, 'No such tag');
    if (m === 'PATCH') {
      const b = await readJson(request);
      const slug = b.slug !== undefined ? cleanSlug(b.slug) : t.slug;
      if (!slug) throw new HttpError(400, 'Slug needs letters or digits');
      if (slug !== t.slug && await env.DB.prepare('SELECT 1 FROM site_tags WHERE slug = ?1').bind(slug).first()) throw new HttpError(409, `Tag "${slug}" already exists`);
      let parent = b.parent_id !== undefined ? (b.parent_id ? +b.parent_id : null) : t.parent_id;
      for (let p = parent, n = 0; p && n < 10; n++) { // no cycles
        if (p === t.id) throw new HttpError(400, "A tag can't be inside itself");
        p = (await env.DB.prepare('SELECT parent_id FROM site_tags WHERE id = ?1').bind(p).first())?.parent_id;
      }
      const aliases = b.aliases !== undefined ? [...new Set(b.aliases.map(norm).filter(Boolean))] : safeJson(t.aliases, []);
      await env.DB.prepare('UPDATE site_tags SET slug = ?2, label = ?3, parent_id = ?4, aliases = ?5 WHERE id = ?1')
        .bind(t.id, slug, String(b.label ?? t.label).trim().slice(0, 80) || t.label, parent, JSON.stringify(aliases)).run();
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('UPDATE site_tags SET parent_id = ?2 WHERE parent_id = ?1').bind(t.id, t.parent_id),
        env.DB.prepare('DELETE FROM photo_tags WHERE tag_id = ?1').bind(t.id),
        env.DB.prepare('DELETE FROM site_tags WHERE id = ?1').bind(t.id),
      ]);
      await bumpContent(env);
      return json({ ok: true });
    }
  }

  // Organizer side panel: which site tags the selected photos carry, how many of them, and where each came from
  if (path === '/tags/summary' && m === 'POST') {
    const ids = selIds(await readJson(request));
    const sel = JSON.stringify(ids);
    const [rows, gaps] = await Promise.all([
      env.DB.prepare(`SELECT t.id, t.slug, t.label, t.kind, t.parent_id, COUNT(*) n,
          SUM(pt.source = 'ai') ai, SUM(pt.source = 'geo') geo, SUM(pt.source = 'flickr') flickr, SUM(pt.source = 'manual') manual,
          ${ids.length <= 5000 ? "json_group_array(pt.photo_id)" : "NULL"} photos
        FROM photo_tags pt JOIN site_tags t ON t.id = pt.tag_id
        WHERE pt.photo_id IN (SELECT value FROM json_each(?1)) AND pt.source != 'removed'
        GROUP BY t.id ORDER BY n DESC, t.label`).bind(sel).all(),
      env.DB.prepare(`SELECT
          SUM(NOT EXISTS (SELECT 1 FROM photo_tags pt JOIN site_tags t ON t.id = pt.tag_id WHERE pt.photo_id = s.value AND pt.source != 'removed' AND t.kind = 'content')) no_content,
          SUM(NOT EXISTS (SELECT 1 FROM photo_tags pt JOIN site_tags t ON t.id = pt.tag_id WHERE pt.photo_id = s.value AND pt.source != 'removed' AND t.kind = 'location')) no_location
        FROM json_each(?1) s`).bind(sel).first(),
    ]);
    return json({ total: ids.length, ...gaps, tags: rows.results.map(r => ({ ...r, photos: r.photos ? JSON.parse(r.photos) : null })) });
  }

  // "Looks right": Claude's tags on these photos become yours (✓), so you can tell what you've reviewed
  if (path === '/tags/confirm' && m === 'POST') {
    const b = await readJson(request);
    const ids = selIds(b);
    const slugs = Array.isArray(b.slugs) && b.slugs.length ? b.slugs.map(String) : null;
    let n = 0;
    for (const part of chunk(ids, 500)) {
      const r = await env.DB.prepare(`UPDATE photo_tags SET source = 'manual' WHERE source = 'ai'
          AND photo_id IN (SELECT value FROM json_each(?1))
          ${slugs ? 'AND tag_id IN (SELECT id FROM site_tags WHERE slug IN (SELECT value FROM json_each(?2)))' : ''}`)
        .bind(JSON.stringify(part), ...(slugs ? [JSON.stringify(slugs)] : [])).run();
      n += r.meta?.changes || 0;
    }
    return json({ ok: true, confirmed: n });
  }

  // Re-apply the rules to every photo, in slices (the page calls this until done)
  if (path === '/tags/apply' && m === 'POST') {
    const b = await readJson(request);
    const offset = Math.max(0, +b.offset || 0);
    const { results } = await env.DB.prepare("SELECT id FROM photos WHERE status != 'deleted' ORDER BY id LIMIT 400 OFFSET ?1").bind(offset).all();
    const scheme = await loadScheme(env);
    const n = await applyRules(env, results.map(x => x.id), scheme);
    const total = (await env.DB.prepare("SELECT COUNT(*) n FROM photos WHERE status != 'deleted'").first()).n;
    return json({ ok: true, done: Math.min(total, offset + results.length), total, applied: n, next: results.length ? offset + results.length : null });
  }

  // Everything Claude needs for the one-time pass: the scheme, the Flickr vocabulary, and the photos rules can't place
  if (path === '/tags/export' && m === 'GET') {
    const scheme = await loadScheme(env);
    const photos = (await env.DB.prepare(
      "SELECT id, title, description, tags, raw_tags, location, latitude FROM photos WHERE status != 'deleted'"
    ).all()).results;
    const tagRows = (await env.DB.prepare(
      "SELECT pt.photo_id, t.slug, t.kind, pt.source FROM photo_tags pt JOIN site_tags t ON t.id = pt.tag_id WHERE pt.source != 'removed'"
    ).all()).results;
    const has = {};
    for (const x of tagRows) ((has[x.photo_id] ??= { content: [], location: [] })[x.kind]).push(x.slug);
    const vocab = new Map();
    for (const p of photos) {
      for (const raw of safeJson(p.raw_tags, String(p.tags || '').split(/\s+/))) {
        const w = norm(raw);
        if (!w) continue;
        const v = vocab.get(w) || { word: w, raw, photos: 0, mapped: scheme.byWord.get(w)?.slug || null };
        v.photos++; vocab.set(w, v);
      }
    }
    const short = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    const body = JSON.stringify({
      kind: 'tonyshi.photos tag export', exported: new Date().toISOString(),
      scheme: scheme.list.map(t => ({ slug: t.slug, label: t.label, kind: t.kind, parent: scheme.byId.get(t.parent_id)?.slug || null, aliases: t.aliasList, geo: !!t.geo_key })),
      vocabulary: [...vocab.values()].sort((a, b) => b.photos - a.photos),
      photos: photos.map(p => {
        const l = safeJson(p.location);
        return {
          id: p.id, title: p.title || '', desc: short(p.description), tags: safeJson(p.raw_tags, String(p.tags || '').split(/\s+/).filter(Boolean)),
          place: l ? [l.locality, l.region, l.country].filter(Boolean).join(', ') : null, geotagged: p.latitude != null,
          content: has[p.id]?.content || [], location: has[p.id]?.location || [],
        };
      }),
    });
    return new Response(body, { headers: {
      'content-type': 'application/json', 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="tonyshi-tags-export.json"`,
    } });
  }

  // Claude's results: new tags, aliases (Flickr words → scheme tag) and per-photo tags (marked as AI)
  if (path === '/tags/import' && m === 'POST') {
    const b = await readJson(request);
    let created = 0, aliased = 0, tagged = 0;
    // rebuild the geotag tags from scratch (they come back on the next re-apply, cleaned up)
    if (b.resetGeo) await env.DB.batch([
      env.DB.prepare('DELETE FROM photo_tags WHERE tag_id IN (SELECT id FROM site_tags WHERE geo_key IS NOT NULL)'),
      env.DB.prepare('UPDATE site_tags SET parent_id = NULL WHERE geo_key IS NULL AND parent_id IN (SELECT id FROM site_tags WHERE geo_key IS NOT NULL)'),
      env.DB.prepare('DELETE FROM site_tags WHERE geo_key IS NOT NULL'),
    ]);
    for (const nt of b.newTags || []) {
      const slug = cleanSlug(nt.slug || nt.label);
      if (!slug || await env.DB.prepare('SELECT 1 FROM site_tags WHERE slug = ?1').bind(slug).first()) continue;
      const parent = nt.parent ? (await env.DB.prepare('SELECT id FROM site_tags WHERE slug = ?1').bind(cleanSlug(nt.parent)).first())?.id : null;
      await env.DB.prepare("INSERT INTO site_tags (slug, label, kind, parent_id, aliases) VALUES (?1, ?2, ?3, ?4, '[]')")
        .bind(slug, String(nt.label || slug).slice(0, 80), nt.kind === 'location' ? 'location' : 'content', parent ?? null).run();
      created++;
    }
    for (const [slug, words] of Object.entries(b.aliases || {})) {
      const t = await env.DB.prepare('SELECT id, aliases FROM site_tags WHERE slug = ?1').bind(cleanSlug(slug)).first();
      if (!t) continue;
      const merged = [...new Set([...safeJson(t.aliases, []), ...words.map(norm).filter(Boolean)])];
      await env.DB.prepare('UPDATE site_tags SET aliases = ?2 WHERE id = ?1').bind(t.id, JSON.stringify(merged)).run();
      aliased += words.length;
    }
    // group photos by identical tag sets to keep writes small
    const groups = new Map();
    for (const [pid, slugs] of Object.entries(b.photos || {})) {
      if (!/^\d+$/.test(pid) || !Array.isArray(slugs) || !slugs.length) continue;
      const k = [...new Set(slugs.map(cleanSlug))].sort().join(',');
      (groups.get(k) ?? groups.set(k, []).get(k)).push(pid);
    }
    for (const [k, pids] of groups) for (const part of chunk(pids, 200)) tagged += (await setTags(env, part, k.split(','), { source: 'ai' })) ? part.length : 0;
    return json({ ok: true, created, aliased, tagged });
  }

  return null;
}
