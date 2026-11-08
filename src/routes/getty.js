// Admin → Getty Images: statement import + "what sells" report. Isolated from the Flickr catalog except for
// an optional title match used only to show a preview thumbnail.
import { json, readJson, HttpError, now, chunk } from '../lib/util.js';
import { importStatement } from '../lib/getty.js';
import { setSetting, getSettings } from '../lib/settings.js';
import { seal, unseal } from '../lib/crypto.js';

// Getty's Flickr-partnership era recorded the Flickr photo ID as the file name: "5871998996.jpg" or
// Flickr's original-download name "3276112098_b552eff442_o.jpg" → an exact link to the Flickr photo.
export const FLICKR_ID_FILE = /^(\d{8,12})(?:_[0-9a-f]{6,12}(?:_[a-z0-9]+)?)?(?:__\d+_)?\.(?:jpe?g|tiff?|png)$/i;
const norm = s => String(s || '').toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/[^a-z0-9]+/g, ' ').trim();

function since(period) {
  const d = new Date();
  const back = { '12m': 1, '2y': 2, '5y': 5 }[period];
  if (!back) return '0000-00';
  d.setUTCFullYear(d.getUTCFullYear() - back);
  return d.toISOString().slice(0, 7);
}

export async function gettyAdmin(request, env, path, url) {
  const m = request.method;

  if (path === '/getty/import' && m === 'POST') {
    const b = await readJson(request);
    if (!b.text || typeof b.text !== 'string') throw new HttpError(400, 'No file content');
    if (b.text.length > 5e6) throw new HttpError(413, 'File too large');
    try { return json({ ok: true, file: b.file, ...(await importStatement(env, b.text, String(b.file || '').slice(0, 200))) }); }
    catch (e) { throw new HttpError(400, `${b.file}: ${e.message}`); }
  }

  if (path === '/getty/summary' && m === 'GET') {
    const [tot, years, months, coll, prod, terr, site, imp] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) licenses, COALESCE(SUM(royalty),0) royalty, COALESCE(SUM(license_fee),0) fees,
        COUNT(DISTINCT asset_id) assets, MIN(royalty_month) first, MAX(royalty_month) last FROM getty_sales`).first(),
      env.DB.prepare(`SELECT substr(royalty_month,1,4) y, COUNT(*) licenses, SUM(royalty) royalty, COUNT(DISTINCT asset_id) assets
        FROM getty_sales GROUP BY y ORDER BY y`).all(),
      env.DB.prepare(`SELECT royalty_month mo, SUM(royalty) royalty, COUNT(*) licenses FROM getty_sales
        WHERE royalty_month >= ?1 GROUP BY mo ORDER BY mo`).bind(since('2y')).all(),
      env.DB.prepare(`SELECT collection k, COUNT(*) n, SUM(royalty) royalty FROM getty_sales GROUP BY k ORDER BY royalty DESC LIMIT 8`).all(),
      env.DB.prepare(`SELECT product_type k, COUNT(*) n, SUM(royalty) royalty FROM getty_sales GROUP BY k ORDER BY royalty DESC LIMIT 8`).all(),
      env.DB.prepare(`SELECT territory k, COUNT(*) n, SUM(royalty) royalty FROM getty_sales GROUP BY k ORDER BY royalty DESC LIMIT 8`).all(),
      env.DB.prepare(`SELECT site k, COUNT(*) n, SUM(royalty) royalty FROM getty_sales GROUP BY k ORDER BY royalty DESC LIMIT 6`).all(),
      env.DB.prepare(`SELECT COUNT(*) files, MIN(royalty_month) first, MAX(royalty_month) last, MAX(imported_at) at FROM getty_imports`).first(),
    ]);
    const st = await getSettings(env);
    return json({ totals: tot, years: years.results, recentMonths: months.results,
      breakdown: { collection: coll.results, product: prod.results, territory: terr.results, site: site.results },
      imports: imp, apiKey: !!st.getty_api_key });
  }

  if (path === '/getty/assets' && m === 'GET') {
    const q = url.searchParams;
    const from = since(q.get('period'));
    const limit = Math.min(+q.get('limit') || 100, 500);
    const order = { licenses: 'licenses DESC, royalty DESC', recent: 'last_sale DESC, royalty DESC', fees: 'fees DESC' }[q.get('sort')] || 'royalty DESC, licenses DESC';
    const { results } = await env.DB.prepare(
      `SELECT asset_id, MAX(title) title, MAX(alt_name) alt_name, MAX(collection) collection,
         COUNT(*) licenses, SUM(royalty) royalty, SUM(license_fee) fees,
         MIN(COALESCE(sales_date, royalty_month)) first_sale, MAX(COALESCE(sales_date, royalty_month)) last_sale
       FROM getty_sales WHERE royalty_month >= ?1 GROUP BY asset_id ORDER BY ${order} LIMIT ?2`
    ).bind(from, limit).all();
    const ids = results.map(r => r.asset_id);
    // per-year royalties for a small trend line
    const trend = {};
    for (const part of chunk(ids, 90)) {
      const t = await env.DB.prepare(
        `SELECT asset_id, substr(royalty_month,1,4) y, SUM(royalty) r FROM getty_sales
         WHERE asset_id IN (${part.map((_, i) => `?${i + 1}`).join(',')}) GROUP BY asset_id, y`
      ).bind(...part).all();
      for (const r of t.results) (trend[r.asset_id] ??= {})[r.y] = r.r;
    }
    // previews: Getty's own thumbnail (oEmbed, fetched in the background); Flickr only as a link, and only
    // when the Flickr title is exactly the original file name (Flickr keeps no file names, only default titles)
    const thumbs = {};
    for (const part of chunk(ids, 90)) {
      const t = await env.DB.prepare(`SELECT asset_id, thumb_url, caption, COALESCE(NULLIF(linked_photo_id, ''), photo_id) linked_photo_id, linked_photo_id manual_id FROM getty_assets WHERE asset_id IN (${part.map((_, i) => `?${i + 1}`).join(',')})`).bind(...part).all();
      for (const r of t.results) thumbs[r.asset_id] = r;
    }
    const files = new Set(results.map(r => norm(r.alt_name)).filter(k => k.length > 3));
    const byFile = {};
    if (files.size) {
      const all = await env.DB.prepare("SELECT id, title FROM photos WHERE status = 'ok' AND title != ''").all();
      for (const p of all.results) { const k = norm(p.title); if (files.has(k) && !byFile[k]) byFile[k] = p.id; }
    }
    // exact: Flickr ID inside the file name, if that photo is in the catalog
    const idCands = [...new Set([
      ...results.map(r => FLICKR_ID_FILE.exec(r.alt_name || '')?.[1]),
      ...Object.values(thumbs).map(t => t.linked_photo_id),
    ].filter(Boolean))];
    const inCatalog = new Set(), catalogRow = {};
    for (const part of chunk(idCands, 90)) {
      const t = await env.DB.prepare(`SELECT id, status, synced_at, server, secret FROM photos WHERE id IN (${part.map((_, i) => `?${i + 1}`).join(',')})`).bind(...part).all();
      for (const p of t.results) { inCatalog.add(p.id); catalogRow[p.id] = p; }
    }
    return json({ period: q.get('period') || 'all', assets: results.map(r => {
      const th = thumbs[r.asset_id];
      return {
        ...r, trend: trend[r.asset_id] || {},
        getty_url: `https://www.gettyimages.com/detail/${r.asset_id}`,
        thumb: th?.thumb_url || null, thumb_source: th?.thumb_url ? 'getty' : null, caption: th?.caption || null,
        ...(() => {
          // manual link wins; then the Flickr ID Getty recorded in the file name
          const manual = th?.linked_photo_id; // your link, or the matcher's / file name's resolved one
          const fid = manual || FLICKR_ID_FILE.exec(r.alt_name || '')?.[1];
          if (fid) {
            const row = catalogRow[fid];
            // Getty no longer shows it (e.g. Moment collections withdrawn) but the Flickr link is exact → use the Flickr image
            const flickrThumb = !th?.thumb_url && row ? {
              thumb: row.status === 'ok' ? `/api/admin/img/${fid}/t?v=${row.synced_at || 0}` : null,
              thumb_fallback: row.server && row.secret ? `https://live.staticflickr.com/${row.server}/${fid}_${row.secret}_q.jpg` : null,
              thumb_source: 'flickr',
            } : {};
            if (flickrThumb.thumb_source && !flickrThumb.thumb) { flickrThumb.thumb = flickrThumb.thumb_fallback; flickrThumb.thumb_fallback = null; }
            return { flickr_id: row ? fid : null, flickr_url: `https://www.flickr.com/photo.gne?id=${fid}`, flickr_match: th?.manual_id ? 'manual' : manual ? 'matched' : 'id', ...flickrThumb };
          }
          const byName = byFile[norm(r.alt_name)];
          return byName ? { flickr_id: byName, flickr_url: null, flickr_match: 'filename' } : { flickr_id: null, flickr_url: null, flickr_match: null };
        })(),
      };
    }) });
  }

  // Fetch Getty's own preview thumbnails (oEmbed — the official embed endpoint, no key), best sellers first.
  if (path === '/getty/previews' && m === 'POST') {
    const limit = Math.min(+url.searchParams.get('limit') || 40, 80);
    const { results } = await env.DB.prepare(
      `SELECT s.asset_id FROM getty_sales s LEFT JOIN getty_assets a ON a.asset_id = s.asset_id
       WHERE a.asset_id IS NULL OR a.preview_status IS NULL OR (a.preview_status = 'error' AND a.fetched_at < ?1)
       GROUP BY s.asset_id ORDER BY SUM(s.royalty) DESC LIMIT ?2`
    ).bind(now() - 86400, limit).all();
    const fetchOne = async id => {
      try {
        const res = await fetch(`https://embed.gettyimages.com/oembed?url=${encodeURIComponent('http://gty.im/' + id)}`, {
          headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' },
        });
        if (res.status === 404) return { id, status: 'missing' };
        if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return { id, status: 'error', why: `HTTP ${res.status}` };
        const d = await res.json();
        return d.thumbnail_url ? { id, status: 'ok', thumb: d.thumbnail_url, title: d.title || null, caption: d.caption || null } : { id, status: 'missing' };
      } catch (e) { return { id, status: 'error', why: e.message }; }
    };
    const out = [];
    for (const part of chunk(results.map(r => r.asset_id), 8)) out.push(...await Promise.all(part.map(fetchOne)));
    const stmts = out.map(o => env.DB.prepare(
      `INSERT INTO getty_assets (asset_id, thumb_url, getty_title, caption, preview_status, fetched_at) VALUES (?1,?2,?3,?4,?5,?6)
       ON CONFLICT(asset_id) DO UPDATE SET thumb_url = COALESCE(excluded.thumb_url, getty_assets.thumb_url), getty_title = COALESCE(excluded.getty_title, getty_assets.getty_title),
         caption = COALESCE(excluded.caption, getty_assets.caption), preview_status = excluded.preview_status, fetched_at = excluded.fetched_at`
    ).bind(o.id, o.thumb || null, o.title || null, o.caption || null, o.status, now()));
    for (const part of chunk(stmts, 100)) if (part.length) await env.DB.batch(part);
    const remaining = (await env.DB.prepare(
      `SELECT COUNT(DISTINCT s.asset_id) n FROM getty_sales s LEFT JOIN getty_assets a ON a.asset_id = s.asset_id WHERE a.asset_id IS NULL OR a.preview_status IS NULL`
    ).first()).n;
    const errors = out.filter(o => o.status === 'error');
    return json({ fetched: out.filter(o => o.status === 'ok').length, missing: out.filter(o => o.status === 'missing').length,
      errors: errors.length, errorSample: errors[0]?.why || null, remaining,
      // every request in a batch failing = Getty refusing the Worker (not individual images)
      blocked: out.length > 0 && errors.length === out.length });
  }

  // Manual link: you picked the Flickr photo that this Getty asset is (or null to unlink)
  if (path === '/getty/link' && m === 'POST') {
    const b = await readJson(request);
    const asset = String(b.asset_id || '');
    if (!/^\d+$/.test(asset)) throw new HttpError(400, 'asset_id required');
    const photo = b.photo_id ? String(b.photo_id) : null;
    if (photo && !(await env.DB.prepare('SELECT 1 FROM photos WHERE id = ?1').bind(photo).first())) throw new HttpError(404, 'No such photo');
    await env.DB.prepare(
      `INSERT INTO getty_assets (asset_id, linked_photo_id) VALUES (?1, ?2)
       ON CONFLICT(asset_id) DO UPDATE SET linked_photo_id = excluded.linked_photo_id`
    ).bind(asset, photo).run();
    return json({ ok: true });
  }

  if (path === '/getty/settings' && m === 'POST') {
    const b = await readJson(request);
    if (b.api_key !== undefined) await setSetting(env, 'getty_api_key', b.api_key ? await seal(env, String(b.api_key).trim()) : '');
    return json({ ok: true });
  }

  // Optional: Getty API key → their own thumbnails for the top assets (keys need Getty's approval)
  if (path === '/getty/thumbs' && m === 'POST') {
    const st = await getSettings(env);
    if (!st.getty_api_key) throw new HttpError(400, 'No Getty API key saved');
    const key = await unseal(env, st.getty_api_key);
    const { results } = await env.DB.prepare(
      `SELECT s.asset_id FROM getty_sales s LEFT JOIN getty_assets a ON a.asset_id = s.asset_id
       WHERE a.asset_id IS NULL GROUP BY s.asset_id ORDER BY SUM(s.royalty) DESC LIMIT 300`
    ).all();
    let got = 0;
    for (const part of chunk(results.map(r => r.asset_id), 100)) {
      const res = await fetch(`https://api.gettyimages.com/v3/images?ids=${part.join(',')}&fields=id,title,thumb,preview`,
        { headers: { 'Api-Key': key, accept: 'application/json' } });
      if (!res.ok) throw new HttpError(400, `Getty API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const stmts = [];
      for (const img of data.images || []) {
        const sizes = Object.fromEntries((img.display_sizes || []).map(d => [d.name, d.uri]));
        stmts.push(env.DB.prepare(
          `INSERT INTO getty_assets (asset_id, thumb_url, getty_title, fetched_at) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(asset_id) DO UPDATE SET thumb_url = excluded.thumb_url, getty_title = excluded.getty_title, fetched_at = excluded.fetched_at`
        ).bind(String(img.id), sizes.preview || sizes.thumb || null, img.title || null, now()));
        got++;
      }
      for (const s2 of chunk(stmts, 100)) if (s2.length) await env.DB.batch(s2);
    }
    return json({ ok: true, fetched: got });
  }

  if (path === '/getty/reset' && m === 'POST') {
    await env.DB.batch([env.DB.prepare('DELETE FROM getty_sales'), env.DB.prepare('DELETE FROM getty_imports')]);
    return json({ ok: true });
  }
  return null;
}
