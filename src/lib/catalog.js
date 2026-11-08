// Catalog: every public photo — browsed through your Flickr collections and albums (both accounts merged into one
// tree, no account names), searched by words / camera / year / place / Getty, and placed on a map.
import { safeJson, now } from './util.js';
import { decorate } from './photoinfo.js';

export const PUBLIC = "p.status = 'ok' AND p.is_public = 1 AND p.hidden = 0 AND COALESCE(p.media, 'photo') = 'photo'";
const COLS = 'p.id, p.thumb_w w, p.thumb_h h, p.title, p.synced_at v';

// ---------- facets (camera, year, place) pulled out of the EXIF / location JSON ----------
const MAKES = [[/nikon/i, 'Nikon'], [/canon/i, 'Canon'], [/sony/i, 'Sony'], [/fuji/i, 'Fujifilm'], [/^dji|hasselblad.*l\d|fc\d{3,4}/i, 'DJI'],
  [/apple|iphone/i, 'Apple'], [/olympus|om digital/i, 'OM System'], [/panasonic|lumix/i, 'Panasonic'], [/leica/i, 'Leica'], [/hasselblad/i, 'Hasselblad'],
  [/ricoh|pentax/i, 'Ricoh / Pentax'], [/samsung/i, 'Samsung'], [/google|pixel/i, 'Google'], [/gopro/i, 'GoPro'], [/insta360/i, 'Insta360'], [/sigma/i, 'Sigma']];
const exifVal = (ex, ...tags) => {
  for (const t of tags) { const i = ex?.items?.find(x => x.tag === t); if (i?.clean || i?.raw) return String(i.clean || i.raw).trim(); }
  return null;
};
export function facetsOf(p) {
  const ex = safeJson(p.exif), info = safeJson(p.info), loc = safeJson(p.location);
  const rawMake = exifVal(ex, 'Make') || '', model = exifVal(ex, 'Model') || ex?.camera || '';
  const make = (MAKES.find(([re]) => re.test(rawMake) || re.test(model)) || [])[1]
    || (rawMake ? rawMake.replace(/ (CORPORATION|Corporation|Co\.,? ?Ltd\.?|, Inc\.?|Inc\.?)$/g, '').trim().replace(/\b\w+/g, w => w[0] + w.slice(1).toLowerCase()) : null);
  const camera = model ? model.replace(/\s+/g, ' ').trim() : null;
  const lens = exifVal(ex, 'LensModel', 'Lens');
  const year = /^\d{4}/.test(p.date_taken || '') ? +String(p.date_taken).slice(0, 4) : null;
  const geoOk = !info?.geoperms || +info.geoperms.ispublic === 1;
  const l = geoOk ? loc : null;
  return {
    make: make || null, camera, lens: lens && !/^\d+(\.\d+)?$/.test(lens) ? lens : null, year: year && year > 1900 ? year : null,
    city: l ? (l.locality || l.neighbourhood || l.county || null) : null, region: l?.region || null, country: l?.country || null,
    lat: l?.latitude ?? null, lon: l?.longitude ?? null, geo_acc: l?.accuracy ?? null,
  };
}

// cron: a few hundred photos per run whose facets are missing or older than their last sync
const searchBody = (p, f) => [p.title, p.description, p.tags, p.raw_tags, f.city, f.region, f.country, f.make, f.camera, f.lens, f.year]
  .filter(x => x != null && x !== '').join(' ').toLowerCase();

export async function refreshFacets(env, limit = 400) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, description, tags, raw_tags, exif, info, location, date_taken FROM photos WHERE status = 'ok' AND (facets_at IS NULL OR facets_at < COALESCE(synced_at, 0)) LIMIT ?1`
  ).bind(limit).all();
  if (!results.length) return 0;
  const t = now(), st = results.flatMap(p => {
    const f = facetsOf(p);
    return [
      env.DB.prepare(`UPDATE photos SET make = ?2, camera = ?3, lens = ?4, year = ?5, city = ?6, region = ?7, country = ?8, lat = ?9, lon = ?10, geo_acc = ?11, facets_at = ?12 WHERE id = ?1`)
        .bind(p.id, f.make, f.camera, f.lens, f.year, f.city, f.region, f.country, f.lat, f.lon, f.geo_acc, Math.max(t, 1)),
      env.DB.prepare('DELETE FROM photo_search WHERE rowid = ?1').bind(+p.id),
      env.DB.prepare('INSERT INTO photo_search (rowid, body) VALUES (?1, ?2)').bind(+p.id, searchBody(p, f)),
    ];
  });
  for (let i = 0; i < st.length; i += 99) await env.DB.batch(st.slice(i, i + 99));
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('catalog_ver', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(String(t)).run();
  return results.length;
}

// ---------- browse: the collection / album tree ----------
const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled';
const keyOf = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

export async function catalogTree(env) {
  const [accs, cols, links, albums] = await Promise.all([
    env.DB.prepare('SELECT id, username, realname FROM accounts ORDER BY id').all(),
    env.DB.prepare('SELECT id, account_id, parent_id, title, position FROM collections ORDER BY account_id, position').all(),
    env.DB.prepare('SELECT collection_id, album_id, position FROM collection_albums WHERE direct = 1 ORDER BY position').all(),
    env.DB.prepare(
      `WITH ap AS (SELECT ap.album_id, ap.photo_id, p.synced_at v, ROW_NUMBER() OVER (PARTITION BY ap.album_id ORDER BY ap.position, ap.photo_id) rn,
                          COUNT(*) OVER (PARTITION BY ap.album_id) n
                   FROM album_photos ap JOIN photos p ON p.id = ap.photo_id WHERE ${PUBLIC} AND ap.album_id LIKE 'f:%')
       SELECT a.id, a.title, a.account_id, a.cover_photo_id, x.n,
         COALESCE((SELECT y.photo_id FROM ap y WHERE y.album_id = a.id AND y.photo_id = a.cover_photo_id), x.photo_id) cover,
         x.v FROM albums a JOIN ap x ON x.album_id = a.id AND x.rn = 1 ORDER BY a.account_id, COALESCE(a.position, 1e9), a.title COLLATE NOCASE`
    ).all(),
  ]);
  const alb = new Map(albums.results.map(a => [a.id, { id: a.id, title: a.title, n: a.n, cover: a.cover, v: a.v, acc: a.account_id }]));
  const colById = new Map(cols.results.map(c => [c.id, { ...c, kids: [], albums: [] }]));
  const placed = new Set();
  for (const l of links.results) { const c = colById.get(l.collection_id), a = alb.get(l.album_id); if (c && a) { c.albums.push(a); placed.add(a.id); } }
  const rootsByAcc = new Map();
  for (const c of colById.values()) {
    if (c.parent_id && colById.get(c.parent_id)) colById.get(c.parent_id).kids.push(c);
    else (rootsByAcc.get(c.account_id) || rootsByAcc.set(c.account_id, []).get(c.account_id)).push(c);
  }
  const finish = (nodes, base, reserved = []) => {
    const used = new Set(reserved);
    return nodes.map(n => {
      const node = { title: n.title, kids: [], albums: [] };
      let s = slug(n.title), i = 2; while (used.has(s)) s = `${slug(n.title)}-${i++}`; used.add(s);
      node.path = base ? `${base}/${s}` : s;
      node.kids = finish(n.kids, node.path);
      const aUsed = new Set(node.kids.map(k => k.path.split('/').pop()));
      node.albums = n.albums.map(a => { let x = slug(a.title), j = 2; while (aUsed.has(x)) x = `${slug(a.title)}-${j++}`; aUsed.add(x); const { acc, ...rest } = a; return { ...rest, path: `${node.path}/${x}` }; });
      node.n = node.albums.reduce((t, a) => t + a.n, 0) + node.kids.reduce((t, k) => t + k.n, 0);
      // up to four covers from inside — a collection card shows them as a little mosaic
      node.covers = [...node.albums.map(a => [a.cover, a.v]), ...node.kids.flatMap(k => k.covers || [])].filter(c => c[0]).slice(0, 4);
      return node;
    }).filter(n => n.n > 0);
  };
  // one top-level entry per Flickr account: its collections, then its albums that aren't in any collection
  const accounts = accs.results.map(a => ({
    title: (a.username || a.realname || `Account ${a.id}`).trim(),
    kids: rootsByAcc.get(a.id) || [], albums: [...alb.values()].filter(x => x.acc === a.id && !placed.has(x.id)),
  }));
  const tree = finish(accounts, '', ['search', 'map', 'roll']).map(acc => ({ ...acc, account: true }));
  const total = (await env.DB.prepare(`SELECT COUNT(*) n FROM photos p WHERE ${PUBLIC}`).first()).n;
  return { total, tree };
}

export async function albumPhotos(env, id) {
  if (!/^f:\d+$/.test(id)) return null;
  const a = await env.DB.prepare('SELECT id, title, description FROM albums WHERE id = ?1').bind(id).first();
  if (!a) return null;
  const { results } = await env.DB.prepare(
    `SELECT ${COLS} FROM album_photos ap JOIN photos p ON p.id = ap.photo_id WHERE ap.album_id = ?1 AND ${PUBLIC} ORDER BY ap.position, p.id LIMIT 2000`
  ).bind(id).all();
  return { id: a.id, title: a.title, photos: await decorate(env, results) };
}

// ---------- search ----------
const SORTS = {
  popular: 'COALESCE(p.pop_score, 0) DESC', views: 'COALESCE(p.views, 0) DESC', faves: 'COALESCE(p.faves, 0) DESC, COALESCE(p.views, 0) DESC',
  comments: 'COALESCE(p.comments, 0) DESC', here: 'COALESCE(p.tsp_views, 0) DESC, COALESCE(p.pop_score, 0) DESC',
  newest: 'p.date_taken DESC', oldest: 'p.date_taken ASC', uploaded: 'p.date_upload DESC',
};
export async function searchPhotos(env, q) {
  const where = [PUBLIC], args = [];
  const add = (sql, ...v) => { let s = sql; for (const x of v) { args.push(x); s = s.replace('?', `?${args.length}`); } where.push(s); };
  // keywords: each word (prefix match) must be in the full-text index — or be one of your site tags
  const words = String(q.get('q') || '').toLowerCase().split(/\s+/).map(w => w.replace(/["*^:()%_]/g, '')).filter(w => w.length > 1).slice(0, 6);
  for (const w of words) {
    args.push(`"${w}"*`, `%${w}%`);
    const n = args.length;
    where.push(`p.id IN (SELECT CAST(rowid AS TEXT) FROM photo_search WHERE photo_search MATCH ?${n - 1}
      UNION SELECT pt.photo_id FROM site_tags t JOIN photo_tags pt ON pt.tag_id = t.id AND pt.source != 'removed' WHERE LOWER(t.label) LIKE ?${n} OR t.slug LIKE ?${n})`);
  }
  if (q.get('make')) add('p.make = ?', q.get('make'));
  if (q.get('camera')) add('p.camera = ?', q.get('camera'));
  const y1 = parseInt(q.get('from')), y2 = parseInt(q.get('to'));
  if (y1) add('p.year >= ?', y1);
  if (y2) add('p.year <= ?', y2);
  if (q.get('country')) add('p.country = ?', q.get('country'));
  if (q.get('place')) { const v = `%${q.get('place').toLowerCase().replace(/[%_]/g, '')}%`; add('(LOWER(p.city) LIKE ? OR LOWER(p.region) LIKE ? OR LOWER(p.country) LIKE ?)', v, v, v); }
  // worked out once per search (not once per photo)
  const getty = `p.id IN (SELECT COALESCE(NULLIF(a.linked_photo_id, ''), a.photo_id) FROM getty_assets a WHERE COALESCE(a.in_portfolio, 1) = 1 AND a.is_video = 0 AND COALESCE(NULLIF(a.linked_photo_id, ''), a.photo_id) IS NOT NULL)`;
  if (q.get('getty') === '1') where.push(getty);
  if (q.get('getty') === '0') where.push(`NOT ${getty}`);
  if (q.get('ig') === '1') where.push("p.id IN (SELECT l.photo_id FROM ig_links l WHERE l.status IN ('confirmed', 'auto'))");
  if (q.get('shape') === 'pano') where.push('MAX(COALESCE(p.o_width, p.width, 0), COALESCE(p.o_height, p.height, 0)) * 1.0 / MAX(1, MIN(COALESCE(p.o_width, p.width, 0), COALESCE(p.o_height, p.height, 0))) >= 2.2');
  if (q.get('shape') === 'vertical') where.push('COALESCE(p.thumb_h, 0) > COALESCE(p.thumb_w, 0) * 1.05');
  if (q.get('shape') === 'horizontal') where.push('COALESCE(p.thumb_w, 0) > COALESCE(p.thumb_h, 0) * 1.05');
  const order = SORTS[q.get('sort')] || SORTS.popular;
  const offset = Math.max(0, parseInt(q.get('offset')) || 0), limit = 120;
  const W = where.join(' AND ');
  // one pass: the page and the total together
  const rows = (await env.DB.prepare(`SELECT ${COLS}, COUNT(*) OVER () total FROM photos p WHERE ${W} ORDER BY ${order}, p.id LIMIT ${limit} OFFSET ${offset}`).bind(...args).all()).results;
  const total = rows[0]?.total ?? (offset ? (await env.DB.prepare(`SELECT COUNT(*) n FROM photos p WHERE ${W}`).bind(...args).first()).n : 0);
  return { total, offset, photos: await decorate(env, rows.map(({ total, ...r }) => r)) };
}

export async function catalogFacets(env) {
  const [makes, cams, years, countries, getty] = await Promise.all([
    env.DB.prepare(`SELECT p.make k, COUNT(*) n FROM photos p WHERE ${PUBLIC} AND p.make IS NOT NULL GROUP BY p.make ORDER BY n DESC`).all(),
    env.DB.prepare(`SELECT p.make m, p.camera k, COUNT(*) n FROM photos p WHERE ${PUBLIC} AND p.camera IS NOT NULL GROUP BY p.make, p.camera HAVING n >= 3 ORDER BY n DESC LIMIT 80`).all(),
    env.DB.prepare(`SELECT p.year k, COUNT(*) n FROM photos p WHERE ${PUBLIC} AND p.year IS NOT NULL GROUP BY p.year ORDER BY p.year`).all(),
    env.DB.prepare(`SELECT p.country k, COUNT(*) n FROM photos p WHERE ${PUBLIC} AND p.country IS NOT NULL GROUP BY p.country ORDER BY n DESC`).all(),
    env.DB.prepare(`SELECT COUNT(DISTINCT COALESCE(NULLIF(a.linked_photo_id, ''), a.photo_id)) n FROM getty_assets a JOIN photos p ON p.id = COALESCE(NULLIF(a.linked_photo_id, ''), a.photo_id)
      WHERE ${PUBLIC} AND COALESCE(a.in_portfolio, 1) = 1 AND a.is_video = 0`).first().catch(() => ({ n: 0 })),
  ]);
  return { makes: makes.results, cameras: cams.results, years: years.results, countries: countries.results, getty: getty?.n || 0 };
}

// every public, located photo as [id, lat, lon, version, w, h] — the map clusters them in the browser
export async function catalogGeo(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.lat, p.lon, p.synced_at v, p.thumb_w w, p.thumb_h h, p.title FROM photos p WHERE ${PUBLIC} AND p.lat IS NOT NULL AND p.lon IS NOT NULL
       AND NOT (p.lat = 0 AND p.lon = 0) ORDER BY COALESCE(p.pop_score, 0) DESC`
  ).all();
  return { points: results.map(r => [r.id, Math.round(r.lat * 1e5) / 1e5, Math.round(r.lon * 1e5) / 1e5, r.v || 0, r.w || 1, r.h || 1, r.title || '']) };
}

// ---------- camera roll: by month taken ----------
// the index is one grouped pass over the photos (cached at the edge); each month is one indexed range read, fetched as it scrolls in
export async function rollIndex(env) {
  const { results } = await env.DB.prepare(
    `SELECT CASE WHEN p.date_taken GLOB '[12][0-9][0-9][0-9]-[01][0-9]*' THEN substr(p.date_taken, 1, 7) ELSE 'undated' END m, COUNT(*) n
     FROM photos p WHERE ${PUBLIC} GROUP BY m ORDER BY m = 'undated', m DESC`
  ).all();
  return { months: results.map(r => [r.m, r.n]) };
}
export async function rollMonth(env, m) {
  let where, args = [];
  if (m === 'undated') where = "NOT COALESCE(p.date_taken, '') GLOB '[12][0-9][0-9][0-9]-[01][0-9]*'";
  else if (/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) { const [y, mo] = m.split('-').map(Number); where = 'p.date_taken >= ?1 AND p.date_taken < ?2'; args = [m, mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`]; }
  else return null;
  const { results } = await env.DB.prepare(
    `SELECT ${COLS}, p.date_taken t FROM photos p WHERE ${where} AND ${PUBLIC} ORDER BY p.date_taken, p.id LIMIT 4000`
  ).bind(...args).all();
  return { m, photos: results };
}
