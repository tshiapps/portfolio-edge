// Site tag scheme + the rules that apply it, used for every newly synced photo and for "re-apply to all".
//  • location: from the Flickr geotag (country → state/region → city), creating location tags as needed
//  • content (and location without geotag): Flickr tags that are the scheme tag itself ("tag-city") or one of
//    its aliases ("cityscape", "urban" → City)
//  • a tag brings its parents (City → Landscape; New York City → New York State → USA)
//  • tags you removed by hand stay removed; your manual tags are never touched by rules
import { chunk, safeJson } from './util.js';

export const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
const COUNTRY_SLUG = { unitedstates: 'usa', unitedstatesofamerica: 'usa', us: 'usa', unitedkingdom: 'uk', greatbritain: 'uk' };

export async function loadScheme(env) {
  const { results } = await env.DB.prepare('SELECT * FROM site_tags').all();
  const byId = new Map(), bySlug = new Map(), byWord = new Map(), byGeo = new Map();
  for (const t of results) {
    t.aliasList = safeJson(t.aliases, []);
    byId.set(t.id, t); bySlug.set(t.slug, t);
    if (t.geo_key) byGeo.set(t.geo_key, t);
  }
  for (const t of results) {
    // the scheme tag on Flickr ("tag-city" → Flickr stores "tagcity") and plain aliases
    byWord.set('tag' + t.slug, t); byWord.set(t.slug, t);
    for (const a of t.aliasList) if (!byWord.has(norm(a))) byWord.set(norm(a), t);
  }
  return { list: results, byId, bySlug, byWord, byGeo };
}

const withAncestors = (scheme, tag) => {
  const out = [];
  for (let t = tag, n = 0; t && n < 8; t = scheme.byId.get(t.parent_id), n++) out.push(t);
  return out;
};

async function uniqueSlug(env, scheme, base) {
  let slug = base || 'place', i = 2;
  while (scheme.bySlug.has(slug)) slug = `${base}${i++}`;
  return slug;
}

// ---- Geotag clean-up: Flickr's place names are messy (Chinese/Japanese names, districts, airports, neighbourhoods).
const NAME_MAP = {
  '中國': 'China', '中国': 'China', '日本': 'Japan', '香港': 'Hong Kong',
  '上海直辖市': 'Shanghai', '上海市': 'Shanghai', '上海': 'Shanghai',
  '北京直辖市': 'Beijing', '北京市': 'Beijing', '北京': 'Beijing',
  '吉林省': 'Jilin', '长春': 'Changchun', '长春市': 'Changchun',
  '广东省': 'Guangdong', '广州': 'Guangzhou', '广州市': 'Guangzhou',
  '浙江省': 'Zhejiang', '彭埠镇': 'Hangzhou', '朱家角镇': 'Zhujiajiao',
  '東京都': 'Tokyo', '東京': 'Tokyo', '东京': 'Tokyo',
};
// [region, city, neighbourhoods/districts/airports that are really that city]
const CITY_OF = [
  ['shanghai', 'Shanghai', 'hongkou huangpu nanshi pudong puxi xuhui zhangqiao changning hongqiaoairport'],
  ['beijing', 'Beijing', 'changqiao chongwen fengsheng liulangzhuang qinglongqiao'],
  ['fujian', 'Xiamen', 'amoy siming'],
  ['jiangsu', 'Nanjing', 'xiaguan'],
  ['zhejiang', 'Hangzhou', 'jianggan'],
  ['yunnan', 'Lijiang', 'lijiangoldtown'],
  ['taiwan', 'Taipei', 'daan neihu shilin wanhua xinyi zhongshan zhongzheng sanzhong shulin'],
  ['taipei', 'Taipei', 'sanzhong shulin'],
  ['tokyo', 'Tokyo', 'roppongi'],
  ['seoul', 'Seoul', 'jamsildong'],
  ['newsouthwales', 'Sydney', 'kirribilli milsonspoint syd woolloomooloo'],
  ['budapest', 'Budapest', 'lowerpannoniaromanprovince'],
  ['newyork', 'New York', 'midtownmanhattan midtowneast dumbo koreatown timessquare congressionaldistrict10 johnfkennedyinternationalairport jfkairport'],
  ['california', 'San Francisco', 'alamosquare bernalheights chinabasin chinatown clarendonheights embarcadero fortwinfieldscott russianhill southbeach sydneytownhistorical telegraphhill alcatraz'],
  ['california', 'Yosemite', 'yosemitevillage curryvillage elportal'],
  ['california', 'Death Valley', 'badwater furnacecreek'],
  ['california', 'Los Angeles', 'picogardens ramonagardens sentous'],
  ['nevada', 'Las Vegas', 'lasvegastownship'],
  ['newjersey', 'Newark', 'newarkinternationalairport'],
  ['arizona', 'Phoenix', 'mountaingatemobilehomepark southmountaintrailerpark laveen'],
  ['wyoming', 'Yellowstone', 'canyonvillage'],
  ['utah', 'Salt Lake City', 'saltlake'],
];
const CITY_MAP = new Map();
for (const [region, city, list] of CITY_OF) for (const w of list.split(' ')) CITY_MAP.set(`${region}|${w}`, city);
const COUNTRY_ONLY = new Set(['hongkong', 'malta']);  // small places: just the country
const US = /^(unitedstates|unitedstatesofamerica|usa|us)$/;
const NEEDS_STATE = new Set(['newyork', 'washington']); // states that share a name with a city
const JUNK_LOCALITY = /(condominium|mobile ?home|trailer ?park|apartments)/i;
const hash = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) >>> 0; return h.toString(36).slice(0, 5); };

// → [{ level, name, slug, label }] country first; empty when there's no country
export function geoParts(loc) {
  const fix = s => {
    let v = String(s || '').trim();
    if (!v) return '';
    v = NAME_MAP[v] ?? v;
    if (/[一-鿿]区$|[一-鿿]區$/.test(v)) return ''; // un-mapped Chinese district names
    return v.replace(/\s+Qu$/i, '');
  };
  let country = fix(loc?.country), region = fix(loc?.region), locality = fix(loc?.locality);
  if (!country) return [];
  const nc = norm(country), isUS = US.test(nc);
  if (locality) locality = CITY_MAP.get(`${norm(region)}|${norm(locality)}`) ?? locality;
  if (JUNK_LOCALITY.test(locality)) locality = '';
  if (norm(region) === nc) region = '';                     // "Daan, Taiwan, Taiwan"
  if (COUNTRY_ONLY.has(nc)) region = locality = '';
  let dc = false;
  if (isUS && norm(region) === 'districtofcolumbia') { region = ''; locality = 'Washington, D.C.'; dc = true; }
  if (!isUS && region && norm(region) === norm(locality)) locality = ''; // Shanghai, Shanghai → Shanghai
  const out = [{ level: 'country', name: country, slug: COUNTRY_SLUG[nc] || nc, label: country }];
  if (region) {
    const st = isUS && NEEDS_STATE.has(norm(region));
    out.push({ level: 'region', name: region, slug: norm(region) + (st ? 'state' : ''), label: st && !/state/i.test(region) ? `${region} State` : region });
  }
  if (locality) {
    const clash = norm(locality) === norm(region);
    out.push({ level: 'locality', name: locality, slug: dc ? 'washingtondc' : norm(locality) + (clash ? 'city' : ''), label: clash && !/city/i.test(locality) ? `${locality} City` : locality });
  }
  for (const p of out) if (!p.slug) p.slug = 'place' + hash(p.name);
  return out;
}

// Create (once) the country / region / locality tags for a geotag; returns the most specific tag.
// A location tag you (or Claude) already made with the same slug is adopted instead of duplicated.
export async function geoTag(env, scheme, loc) {
  const parts = geoParts(loc);
  let parent = null, key = '';
  for (const p of parts) {
    key += (key ? '|' : '') + p.name;
    let t = scheme.byGeo.get(key);
    if (!t) {
      const mine = scheme.bySlug.get(p.slug);
      if (mine && mine.kind === 'location' && !mine.geo_key) {
        await env.DB.prepare('UPDATE site_tags SET geo_key = ?2, parent_id = ?3 WHERE id = ?1').bind(mine.id, key, parent?.id ?? null).run();
        mine.geo_key = key; mine.parent_id = parent?.id ?? null; t = mine;
      } else {
        const slug = await uniqueSlug(env, scheme, p.slug);
        const r = await env.DB.prepare(
          `INSERT INTO site_tags (slug, label, kind, parent_id, geo_key, aliases) VALUES (?1, ?2, 'location', ?3, ?4, '[]') RETURNING *`
        ).bind(slug, p.label, parent?.id ?? null, key).first();
        t = { ...r, aliasList: [] };
        scheme.byId.set(t.id, t); scheme.bySlug.set(t.slug, t); scheme.list.push(t);
        scheme.byWord.set(t.slug, t); scheme.byWord.set('tag' + t.slug, t);
      }
      scheme.byGeo.set(key, t);
    }
    parent = t;
  }
  return parent;
}

// Anything that changes which photos carry which tags bumps this, so the public folder pages are rebuilt at once
export const bumpContent = env => env.DB.prepare(
  `INSERT INTO settings (key, value, updated_at) VALUES ('content_ver', ?1, unixepoch())
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(String(Date.now())).run();

// Rule-based tags for a set of photos. Keeps manual tags and removals; replaces previous rule tags.
export async function applyRules(env, photoIds, scheme) {
  if (!photoIds.length) return 0;
  scheme ||= await loadScheme(env);
  let changed = 0;
  for (const part of chunk(photoIds, 80)) {
    const ph = (await env.DB.prepare(
      `SELECT id, tags, raw_tags, location FROM photos WHERE id IN (${part.map((_, i) => `?${i + 1}`).join(',')})`
    ).bind(...part).all()).results;
    const keep = (await env.DB.prepare(
      `SELECT photo_id, tag_id, source FROM photo_tags WHERE photo_id IN (${part.map((_, i) => `?${i + 1}`).join(',')}) AND source IN ('manual','removed','ai')`
    ).bind(...part).all()).results;
    const locked = new Map(); // photo → Map(tag → source) for manual/removed/ai
    for (const k of keep) (locked.get(k.photo_id) ?? locked.set(k.photo_id, new Map()).get(k.photo_id)).set(k.tag_id, k.source);
    const stmts = [];
    for (const p of ph) {
      const want = new Map(); // tag id → source
      const loc = safeJson(p.location);
      const g = await geoTag(env, scheme, loc);
      if (g) for (const t of withAncestors(scheme, g)) want.set(t.id, 'geo');
      const words = new Set([...String(p.tags || '').split(/\s+/), ...safeJson(p.raw_tags, [])].map(norm).filter(Boolean));
      for (const w of words) {
        const t = scheme.byWord.get(w);
        if (!t) continue;
        if (t.kind === 'location' && g) continue; // the geotag wins for location
        for (const a of withAncestors(scheme, t)) if (!want.has(a.id)) want.set(a.id, 'flickr');
      }
      const lk = locked.get(p.id) || new Map();
      stmts.push(env.DB.prepare("DELETE FROM photo_tags WHERE photo_id = ?1 AND source IN ('geo','flickr')").bind(p.id));
      for (const [tid, src] of want) {
        if (lk.has(tid)) continue; // manual/ai already there, or you removed it
        stmts.push(env.DB.prepare('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id, source) VALUES (?1, ?2, ?3)').bind(p.id, tid, src));
        changed++;
      }
    }
    for (const s of chunk(stmts, 100)) await env.DB.batch(s);
  }
  await bumpContent(env);
  return changed;
}

// Set tags on photos by hand / from Claude's pass: adds the tag + its parents (source given), or removes it.
export async function setTags(env, photoIds, slugs, { remove = false, source = 'manual' } = {}) {
  const scheme = await loadScheme(env);
  const tags = slugs.map(s => scheme.bySlug.get(String(s))).filter(Boolean);
  if (!tags.length) return 0;
  const stmts = [];
  for (const pid of photoIds) for (const t of tags) {
    if (remove) {
      // tombstone so the rules don't put it back
      stmts.push(env.DB.prepare(
        `INSERT INTO photo_tags (photo_id, tag_id, source) VALUES (?1, ?2, 'removed')
         ON CONFLICT(photo_id, tag_id) DO UPDATE SET source = 'removed'`).bind(pid, t.id));
    } else {
      for (const a of withAncestors(scheme, t)) {
        stmts.push(env.DB.prepare(
          `INSERT INTO photo_tags (photo_id, tag_id, source) VALUES (?1, ?2, ?3)
           ON CONFLICT(photo_id, tag_id) DO UPDATE SET source = CASE
             WHEN photo_tags.source = 'manual' THEN 'manual'
             WHEN photo_tags.source = 'removed' AND ?3 != 'manual' THEN 'removed'
             ELSE ?3 END`).bind(pid, a.id, source));
      }
    }
  }
  for (const s of chunk(stmts, 100)) await env.DB.batch(s);
  await bumpContent(env);
  return stmts.length;
}
