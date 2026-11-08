// Album builder engine: a folder tree whose photos come from rules over your site tags.
//  • a rule = "top N by Flickr popularity / Getty licenses / Getty earnings / newest, from photos tagged ALL (or ANY) of these, NOT tagged those"
//  • a folder's rules are combined (OR); "within parent" also requires the photo to fit the parent folder
//  • a folder with sub-folders but no rules of its own shows the top photos of the tag its sub-folders share
//    (City + Nature → Landscape)
//  • automatic sub-folders: one per city / state / country found among the folder's photos
import { safeJson } from './util.js';
import { FLICKR_ID_FILE } from '../routes/getty.js';

export const ELIGIBLE = "p.status = 'ok' AND p.is_public = 1 AND p.hidden = 0 AND p.media = 'photo'";
// getty = number of Getty licenses sold, getty_earn = Getty royalties earned
export const RANKS = ['flickr', 'getty', 'getty_earn', 'newest', 'random'];
export const AUTO_BY = ['city', 'state', 'country'];
// photo shape filter: pano = at least the panorama ratio (Settings, default 2.2:1, wide or tall)
export const SHAPES = ['pano', 'horizontal', 'vertical', 'square'];
const COMMON_TOP = 30;
const clampTop = n => Math.max(1, Math.min(500, parseInt(n) || 20));

export const cleanSlug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

export function cleanRule(r) {
  const list = v => [...new Set((Array.isArray(v) ? v : []).map(String).filter(Boolean))].slice(0, 20);
  return { tags: list(r?.tags), match: r?.match === 'any' ? 'any' : 'all', exclude: list(r?.exclude),
    top: clampTop(r?.top), rank: RANKS.includes(r?.rank) ? r.rank : 'flickr', shape: SHAPES.includes(r?.shape) ? r.shape : '',
    // only photos from these Flickr accounts (empty = all); leave out photos you rated this many stars or fewer (0 = keep all)
    accounts: [...new Set((Array.isArray(r?.accounts) ? r.accounts : []).map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 10),
    reject: Math.max(0, Math.min(4, parseInt(r?.reject) || 0)) };
}
export function cleanAuto(a) {
  if (!a || !AUTO_BY.includes(a.by)) return null;
  return { by: a.by, top: clampTop(a.top), rank: RANKS.includes(a.rank) ? a.rank : 'flickr', min: Math.max(1, Math.min(1000, parseInt(a.min) || 3)) };
}
const parseFolder = f => ({ ...f, rules: safeJson(f.rules, []).map(cleanRule), auto: cleanAuto(safeJson(f.auto, null)) });

// ---------- context: folders + tag tree ----------
export async function loadCtx(env) {
  const [f, t, pr] = await Promise.all([
    env.DB.prepare('SELECT * FROM folders ORDER BY position, id').all(),
    env.DB.prepare('SELECT id, slug, label, kind, parent_id FROM site_tags').all(),
    env.DB.prepare("SELECT value FROM settings WHERE key = 'pano_ratio'").first(),
  ]);
  const ctx = makeCtx(env, f.results.map(parseFolder), t.results);
  ctx.panoRatio = Math.max(1.2, parseFloat(pr?.value) || 2.2);
  return ctx;
}
function makeCtx(env, folders, tags) {
  const tagBySlug = new Map(tags.map(t => [t.slug, t])), tagById = new Map(tags.map(t => [t.id, t]));
  const kids = new Map();
  for (const f of folders) (kids.get(f.parent_id || 0) ?? kids.set(f.parent_id || 0, []).get(f.parent_id || 0)).push(f);
  return { env, folders, byId: new Map(folders.map(f => [f.id, f])), kids, tags, tagBySlug, tagById };
}
export const childrenOf = (ctx, id) => ctx.kids.get(id || 0) || [];

const ancestors = (ctx, tag) => {
  const out = [];
  for (let t = tag, n = 0; t && n < 10; t = ctx.tagById.get(t.parent_id), n++) out.push(t.id);
  return out;
};
const intersect = (sets) => sets.reduce((a, b) => new Set([...a].filter(x => b.has(x))));

// tags (with parents) every photo of this folder is guaranteed to carry
function impliedTags(ctx, f, depth = 0) {
  const rules = effectiveRules(ctx, f, depth);
  if (!rules.length) return new Set();
  return intersect(rules.map(r => {
    const tags = r.tags.map(s => ctx.tagBySlug.get(s)).filter(Boolean);
    if (!tags.length) return new Set();
    const sets = tags.map(t => new Set(ancestors(ctx, t)));
    return r.match === 'any' ? intersect(sets) : new Set(sets.flatMap(s => [...s]));
  }));
}

// "City + Nature → Landscape": the most specific tags every sub-folder shares
export function commonRule(ctx, f, depth = 0) {
  const kids = childrenOf(ctx, f.id);
  if (!kids.length || depth > 8) return null;
  const common = intersect(kids.map(k => impliedTags(ctx, k, depth + 1)));
  if (!common.size) return null;
  // keep only the deepest ones (drop a tag when one of its descendants is also shared)
  const deepest = [...common].filter(id => ![...common].some(o => o !== id && ancestors(ctx, ctx.tagById.get(o)).includes(id)));
  return { tags: deepest.map(id => ctx.tagById.get(id).slug), match: 'all', exclude: [], top: COMMON_TOP, rank: 'flickr', common: true };
}
export function effectiveRules(ctx, f, depth = 0) {
  if (f.rules.length) return f.rules;
  const c = commonRule(ctx, f, depth);
  return c ? [c] : [];
}

// ---------- SQL ----------
const has = ids => `EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.source != 'removed' AND pt.tag_id IN (${ids.join(',')}))`;
export function ruleSql(ctx, r) {
  const ids = r.tags.map(s => ctx.tagBySlug.get(s)?.id).filter(Boolean);
  let s;
  if (!r.tags.length) s = '1';                                   // no tags = every photo
  else if (!ids.length || (r.match === 'all' && ids.length < r.tags.length)) return '0'; // a tag that no longer exists
  else s = r.match === 'any' ? has(ids) : ids.map(i => has([i])).join(' AND ');
  const ex = r.exclude.map(x => ctx.tagBySlug.get(x)?.id).filter(Boolean);
  if (ex.length) s += ` AND NOT ${has(ex)}`;
  if (r.shape) s += ` AND ${shapeSql(r.shape, ctx.panoRatio || 2.2)}`;
  if (r.accounts?.length) s += ` AND p.account_id IN (${r.accounts.map(Number).join(',')})`;
  if (r.reject) s += ` AND NOT (COALESCE(p.rating, 0) BETWEEN 1 AND ${Number(r.reject)})`;
  return `(${s})`;
}
// original dimensions when known (the stored copy may be resized), else the thumbnail's
const W = 'COALESCE(p.o_width, p.width, p.thumb_w, 0)', H = 'COALESCE(p.o_height, p.height, p.thumb_h, 0)';
function shapeSql(shape, pano) {
  const ratio = `(MAX(${W}, ${H}) * 1.0 / MAX(1, MIN(${W}, ${H})))`;
  const R = Number(pano).toFixed(3);
  if (shape === 'pano') return `${ratio} >= ${R}`;
  if (shape === 'square') return `${ratio} < 1.08`;
  if (shape === 'horizontal') return `${W} > ${H} AND ${ratio} >= 1.08 AND ${ratio} < ${R}`;
  return `${H} > ${W} AND ${ratio} >= 1.08 AND ${ratio} < ${R}`; // vertical
}

// every photo that belongs to the folder (before "top N"): its rules, and its parent's when nested "within parent".
// As a parent (depth > 0) only explicit rules count — the automatic "shared tag" is derived from the children,
// so letting it restrict them would go round in circles.
export function scopeSql(ctx, f, depth = 0) {
  const rules = depth ? f.rules : effectiveRules(ctx, f);
  let s = rules.length ? `(${rules.map(r => ruleSql(ctx, r)).join(' OR ')})` : '1';
  const parent = f.within_parent && f.parent_id ? ctx.byId.get(f.parent_id) : null;
  if (parent && depth < 10) s += ` AND ${scopeSql(ctx, parent, depth + 1)}`;
  return s;
}

// ---------- Getty sales per Flickr photo (admin-only numbers; the public only sees the order) ----------
let gCache = null, gAt = 0;
export const resetGettyCache = () => { gCache = null; };
export async function gettyRanks(env) {
  if (gCache && Date.now() - gAt < 600e3) return gCache;
  const { results } = await env.DB.prepare(
    `SELECT s.asset_id, MAX(s.alt_name) alt, COUNT(*) n, SUM(COALESCE(s.royalty, 0)) r, COALESCE(NULLIF(a.linked_photo_id, ''), a.photo_id) lp
     FROM getty_sales s LEFT JOIN getty_assets a ON a.asset_id = s.asset_id GROUP BY s.asset_id`
  ).all();
  const m = new Map();
  for (const x of results) {
    const pid = x.lp || FLICKR_ID_FILE.exec(x.alt || '')?.[1];
    if (!pid) continue;
    const c = m.get(pid) || { sales: 0, royalty: 0, asset: x.asset_id, best: 0 };
    c.sales += x.n; c.royalty += x.r || 0;
    if (x.n > c.best) { c.best = x.n; c.asset = x.asset_id; } // the Getty page to link to (public — the counts are not)
    m.set(pid, c);
  }
  gCache = m; gAt = Date.now();
  return m;
}

const COLS = 'p.id, p.thumb_w w, p.thumb_h h, p.title, p.synced_at v, p.pop_score score';
function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

async function topFor(ctx, rule, scope, want) {
  const where = `${ELIGIBLE} AND ${ruleSql(ctx, rule)} AND ${scope}`;
  if (rule.rank === 'getty' || rule.rank === 'getty_earn') {
    const g = await gettyRanks(ctx.env);
    if (!g.size) return [];
    const { results } = await ctx.env.DB.prepare(`SELECT ${COLS} FROM photos p WHERE ${where} AND p.id IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify([...g.keys()])).all();
    const lic = (a, b) => g.get(b.id).sales - g.get(a.id).sales, earn = (a, b) => g.get(b.id).royalty - g.get(a.id).royalty;
    const [first, second] = rule.rank === 'getty' ? [lic, earn] : [earn, lic];
    return results.sort((a, b) => first(a, b) || second(a, b) || (b.score || 0) - (a.score || 0)).slice(0, want);
  }
  if (rule.rank === 'random') {
    // a random pick from everything that matches — the same for everyone all day, a new pick each day (UTC)
    const { results } = await ctx.env.DB.prepare(`SELECT ${COLS} FROM photos p WHERE ${where} LIMIT 20000`).all();
    const seed = new Date().toISOString().slice(0, 10) + '/' + JSON.stringify([rule.tags, rule.exclude, rule.shape, rule.accounts]);
    return results.map(p => [hash01(seed + '/' + p.id), p]).sort((a, b) => a[0] - b[0]).slice(0, want).map(x => x[1]);
  }
  const order = rule.rank === 'newest' ? 'p.date_upload DESC' : 'COALESCE(p.pop_score, 0) DESC';
  return (await ctx.env.DB.prepare(`SELECT ${COLS} FROM photos p WHERE ${where} ORDER BY ${order}, p.id LIMIT ?1`).bind(want).all()).results;
}

// the folder's photos: each rule's top N (inside the parent when nested), in rule order, no repeats
export async function folderPhotos(ctx, f) {
  const parent = f.within_parent && f.parent_id ? ctx.byId.get(f.parent_id) : null;
  const scope = parent ? scopeSql(ctx, parent, 1) : '1';
  const out = [], seen = new Set();
  for (const rule of effectiveRules(ctx, f)) {
    const rows = await topFor(ctx, rule, scope, rule.top + out.length);
    let n = 0;
    for (const p of rows) {
      if (n >= rule.top) break;
      if (seen.has(p.id)) continue;
      seen.add(p.id); out.push(p); n++;
    }
  }
  return out;
}

// ---------- automatic sub-folders: one per place ----------
function placeLevel(ctx, by) {
  const loc = ctx.tags.filter(t => t.kind === 'location');
  const hasKids = new Set(loc.map(t => t.parent_id).filter(Boolean));
  const depth = t => ancestors(ctx, t).length - 1;
  if (by === 'country') return loc.filter(t => depth(t) === 0);
  if (by === 'state') return loc.filter(t => depth(t) === 1 && hasKids.has(t.id));
  return loc.filter(t => !hasKids.has(t.id)); // cities (and places too small to split further, e.g. Hong Kong)
}
export async function autoChildren(ctx, f) {
  if (!f.auto) return [];
  const ids = placeLevel(ctx, f.auto.by).map(t => t.id);
  if (!ids.length) return [];
  const { results } = await ctx.env.DB.prepare(
    `SELECT pt.tag_id, COUNT(DISTINCT p.id) n FROM photos p JOIN photo_tags pt ON pt.photo_id = p.id AND pt.source != 'removed'
     WHERE ${ELIGIBLE} AND pt.tag_id IN (${ids.join(',')}) AND ${scopeSql(ctx, f)} GROUP BY pt.tag_id HAVING n >= ?1`
  ).bind(f.auto.min).all();
  return results.map(r => ({ tag: ctx.tagById.get(r.tag_id), n: r.n }))
    .map(({ tag, n }) => ({ slug: tag.slug, title: tag.label, n }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
// a virtual folder for one place under f
export const placeFolder = (f, tag) => ({
  id: `${f.id}:${tag.slug}`, parent_id: f.id, title: tag.label, slug: tag.slug, within_parent: 1, auto: null, virtual: true, display: f.display,
  rules: [{ tags: [tag.slug], match: 'all', exclude: [], top: f.auto.top, rank: f.auto.rank }],
});

// ---------- public tree / lookup ----------
export async function publicTree(ctx) {
  const walk = async (pid, base, depth) => {
    const out = [];
    for (const f of childrenOf(ctx, pid)) {
      if (f.hidden || depth > 8) continue;
      const path = base ? `${base}/${f.slug}` : f.slug;
      const children = await walk(f.id, path, depth + 1);
      const taken = new Set(children.map(c => c.slug));
      for (const a of await autoChildren(ctx, f)) if (!taken.has(a.slug)) children.push({ slug: a.slug, title: a.title, path: `${path}/${a.slug}`, children: [], place: true });
      out.push({ slug: f.slug, title: f.title, path, children });
    }
    return out;
  };
  return walk(0, '', 0);
}

// "landscape/city/newyorkcity" → the folder (real or per-place), with breadcrumbs
export async function resolvePath(ctx, path) {
  const segs = String(path || '').split('/').filter(Boolean).slice(0, 10);
  let cur = null;
  const crumbs = [];
  for (const s of segs) {
    let next = childrenOf(ctx, cur?.id || 0).find(f => f.slug === s && !f.hidden);
    if (!next && cur && !cur.virtual && cur.auto) {
      const tag = ctx.tagBySlug.get(s);
      if (tag && tag.kind === 'location' && (await autoChildren(ctx, cur)).some(a => a.slug === s)) next = placeFolder(cur, tag);
    }
    if (!next) return null;
    if (next.virtual) ctx.byId.set(next.id, next);
    cur = next;
    crumbs.push({ title: cur.title, path: [...crumbs.map(c => c.slug), cur.slug].join('/'), slug: cur.slug });
  }
  return cur ? { folder: cur, crumbs } : null;
}

// cheap cache key: changes whenever a folder is added, edited or removed, or photos are (un)tagged / hidden
export async function treeVersion(env) {
  const r = await env.DB.prepare("SELECT COUNT(*) n, MAX(updated_at) u, (SELECT value FROM settings WHERE key = 'content_ver') c FROM folders").first();
  return `${r?.n || 0}-${r?.u || 0}-${r?.c || 0}`;
}
