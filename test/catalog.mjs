// Catalog: facets from EXIF/location, the merged collection tree (two accounts, same-titled collections merged,
// loose albums, private photos left out), album photos, search filters + sorting, map points (public geo only).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const db = new DatabaseSync(':memory:');
for (const f of readdirSync(root + '/migrations').sort()) db.exec(readFileSync(root + '/migrations/' + f, 'utf8'));
const norm = a => a.map(v => (v === undefined ? null : v));
class S { constructor(q, a = []) { this.q = q; this.a = a; } bind(...a) { return new S(this.q, a); }
  async run() { const r = db.prepare(this.q).run(...norm(this.a)); return { meta: { changes: Number(r.changes) } }; }
  async all() { return { results: db.prepare(this.q).all(...norm(this.a)).map(r => ({ ...r })) }; }
  async first() { const r = db.prepare(this.q).get(...norm(this.a)); return r ? { ...r } : null; } }
const env = { DB: { prepare: q => new S(q), async batch(st) { for (const x of st) await x.run(); } }, ADMIN_PASSWORD: 'pw', ENCRYPTION_KEY: 'k'.repeat(44),
  BUCKET: { async get() { return null; } }, ASSETS: { fetch: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) } };
const store = new Map();
globalThis.caches = { default: { match: async r => store.get(r.url)?.clone() || null, put: async (r, res) => { store.set(r.url, res); } } };
const { default: w } = await import(root + '/src/index.js');
const { refreshFacets } = await import(root + '/src/lib/catalog.js');
const ok = (c, m) => { console.log((c ? 'ok  - ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };
const J = async p => (await w.fetch(new Request('https://tonyshi.photos' + p), env, { waitUntil() {} })).json();

db.prepare("INSERT INTO accounts (id, nsid, username, token_enc, token_secret_enc) VALUES (1, '1@N1', 'Tony Shi', 'x','y'), (2, '2@N1', 'Tony Shi Life', 'x','y'), (3, '3@N1', 'Tony Shi Tactical', 'x', 'y')").run();
const ex = (make, model) => JSON.stringify({ items: [{ tag: 'Make', raw: make }, { tag: 'Model', raw: model }] });
const loc = (city, country, lat, lon) => JSON.stringify({ locality: city, country, latitude: lat, longitude: lon, accuracy: 16 });
const add = (id, acc, title, o = {}) => db.prepare(`INSERT INTO photos (id, account_id, title, tags, status, is_public, hidden, media, thumb_w, thumb_h, synced_at, views, faves, pop_score, date_taken, exif, location, info, o_width, o_height)
  VALUES (?, ?, ?, ?, 'ok', ?, 0, 'photo', ?, ?, 10, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, acc, title, o.tags || '', o.pub ?? 1, o.w || 1024, o.h || 683, o.views || 0, o.faves || 0, o.pop || 0,
  o.date || '2019-05-01 10:00:00', o.exif || null, o.loc || null, JSON.stringify({ geoperms: { ispublic: o.geo ?? 1 } }), o.w || 6000, o.h || 4000);
add('1', 1, 'Brooklyn Bridge', { exif: ex('NIKON CORPORATION', 'NIKON D850'), loc: loc('New York', 'United States', 40.7, -74), views: 900, pop: 9, tags: 'bridge night' });
add('2', 1, 'Golden Gate', { exif: ex('Canon', 'Canon EOS 5D Mark IV'), loc: loc('San Francisco', 'United States', 37.8, -122.4), views: 500, pop: 5, date: '2016-08-01 06:00:00' });
add('3', 2, 'Oia sunset', { exif: ex('DJI', 'FC3170'), loc: loc('Oia', 'Greece', 36.46, 25.37), views: 100, pop: 7, w: 3000, h: 1000 });
add('4', 2, 'Private one', { pub: 0 });
add('5', 2, 'Secret place', { loc: loc('Home', 'United States', 40.1, -75), geo: 0, tags: 'bridge' });
add('6', 1, 'Loose album photo', {});
db.prepare("INSERT INTO collections (id, account_id, flickr_id, parent_id, title, position) VALUES ('c:a1', 1, 'a1', NULL, 'Cities', 0), ('c:b1', 2, 'b1', NULL, 'Cities', 0), ('c:a2', 1, 'a2', 'c:a1', 'USA', 0), ('c:b2', 2, 'b2', NULL, 'Search', 1)").run();
db.prepare("INSERT INTO albums (id, source, account_id, flickr_id, title, cover_photo_id) VALUES ('f:10', 'flickr', 1, '10', 'New York', '1'), ('f:11', 'flickr', 1, '11', 'San Francisco', NULL), ('f:20', 'flickr', 2, '20', 'Santorini', NULL), ('f:21', 'flickr', 2, '21', 'Private only', NULL), ('f:30', 'flickr', 1, '30', 'Odds', NULL), ('f:40', 'flickr', 2, '40', 'Hidden search', NULL)").run();
db.prepare("INSERT INTO collection_albums (collection_id, album_id, direct, position) VALUES ('c:a2', 'f:10', 1, 0), ('c:a2', 'f:11', 1, 1), ('c:b1', 'f:20', 1, 0), ('c:b1', 'f:21', 1, 1), ('c:b2', 'f:40', 1, 0)").run();
db.prepare("INSERT INTO album_photos (album_id, photo_id, position) VALUES ('f:10', '1', 0), ('f:11', '2', 0), ('f:20', '3', 0), ('f:21', '4', 0), ('f:30', '6', 0), ('f:40', '5', 0)").run();
db.prepare("INSERT INTO getty_assets (asset_id, photo_id, in_portfolio, is_video) VALUES ('900', '3', 1, 0)").run();

const nf = await refreshFacets(env);
const r1 = db.prepare("SELECT make, camera, year, city, country, lat FROM photos WHERE id = '1'").get(), r3 = db.prepare("SELECT make FROM photos WHERE id = '3'").get(), r5 = db.prepare("SELECT city, lat FROM photos WHERE id = '5'").get();
ok(nf === 6 && r1.make === 'Nikon' && r1.camera === 'NIKON D850' && r1.year === 2019 && r1.city === 'New York' && r1.lat === 40.7, `facets: make/model/year/place (${JSON.stringify(r1)})`);
ok(r3.make === 'DJI' && r5.city === null && r5.lat === null, 'DJI drone recognised from its model code; private location left out');
ok((await refreshFacets(env)) === 0, 'facets: nothing to redo until a photo re-syncs');

const t = await J('/api/catalog/tree');
const titles = t.tree.map(x => x.title);
ok(t.total === 5 && titles.join() === 'Tony Shi,Tony Shi Life', `root: one entry per Flickr account (accounts without public photos left out) (${titles})`);
const [a1, a2] = t.tree;
ok(a1.kids.map(k => k.title).join() === 'Cities' && a1.albums.map(a => a.title).join() === 'Odds', `account 1: its collection + its loose album (${JSON.stringify(a1.albums.map(a => a.title))})`);
ok(a2.kids.map(k => k.title).join() === 'Cities,Search' && a2.kids[0].albums.map(a => a.title).join() === 'Santorini', 'account 2: its own "Cities" (not merged with account 1), album with only private photos dropped');
ok(a1.kids[0].kids[0].albums[0].path === 'tony-shi/cities/usa/new-york' && a1.kids[0].kids[0].albums[0].cover === '1', 'paths and covers');
ok(a1.kids[0].covers.length === 2 && a1.kids[0].covers[0][0] === '1', `collections carry covers for the mosaic (${JSON.stringify(a1.kids[0].covers)})`);
const al = await J('/api/catalog/album?id=f:10');
ok(al.photos.length === 1 && al.photos[0].id === '1' && al.photos[0].s?.[0] === 900, 'album photos come with tile stats');
ok((await w.fetch(new Request('https://tonyshi.photos/api/catalog/album?id=bad'), env, { waitUntil() {} })).status === 404, 'bad album id → 404');

const s = async q => (await J('/api/catalog/search?' + q));
ok((await s('q=bridge')).photos.map(p => p.id).join() === '1,5', 'keyword in tags/title (private photo excluded)');
ok((await s('q=new+york')).photos.map(p => p.id).join() === '1', 'two words = both must match (city)');
ok((await s('make=Canon')).photos.map(p => p.id).join() === '2', 'camera brand');
ok((await s('q=d850')).total === 1, 'camera model by keyword');
ok((await s('from=2017&to=2020')).photos.map(p => p.id).sort().join() === '1,3,5,6', 'year range');
ok((await s('country=Greece')).photos.map(p => p.id).join() === '3', 'country');
ok((await s('getty=1')).photos.map(p => p.id).join() === '3' && (await s('getty=0')).total === 4, 'on Getty / not on Getty');
ok((await s('shape=pano')).photos.map(p => p.id).join() === '3', 'panoramas');
ok((await s('sort=views')).photos[0].id === '1' && (await s('sort=oldest')).photos[0].id === '2', 'sorting');
const f = await J('/api/catalog/facets');
ok(f.makes.find(m => m.k === 'Nikon')?.n === 1 && f.years.map(y => y.k).join() === '2016,2019' && f.countries[0].k === 'United States' && f.getty === 1, 'facets for the filters');
const g = await J('/api/catalog/geo');
ok(g.points.length === 3 && g.points[0][0] === '1' && !g.points.some(p => p[0] === '5'), 'map: located public photos, most popular first, private locations left out');
const page = await w.fetch(new Request('https://tonyshi.photos/catalog/cities/usa'), env, {});
ok(page.status === 200 && /unpkg\.com\/leaflet@1\.9\.4/.test(page.headers.get('content-security-policy')), 'deep catalog links serve the page; CSP allows the pinned map library');
// camera roll
add('7', 1, 'December night', { date: '2018-12-31 23:00:00' }); add('8', 1, 'No date', {}); db.prepare("UPDATE photos SET date_taken = NULL WHERE id = '8'").run();
db.prepare("UPDATE settings SET value = value || 'x' WHERE key = 'catalog_ver'").run(); db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('catalog_ver', 'r1')").run();
const ri = await J('/api/catalog/roll?_=1');
ok(ri.months.map(m => m.join(':')).join() === '2019-05:4,2018-12:1,2016-08:1,undated:1', `camera roll: months newest first, private left out, undated last (${ri.months.map(m => m.join(':'))})`);
const rm = await J('/api/catalog/roll?m=2018-12');
ok(rm.photos.length === 1 && rm.photos[0].id === '7' && (await J('/api/catalog/roll?m=undated')).photos[0].id === '8', 'camera roll: one month at a time (December doesn’t spill into January)');
ok((await w.fetch(new Request('https://tonyshi.photos/api/catalog/roll?m=2019-13'), env, { waitUntil() {} })).status === 404, 'camera roll: bad month refused');
ok((await J('/api/catalog/tree')).tree.every(a => a.kids.every(k => k.slug !== 'roll')), 'a collection named "Roll" can’t take over /catalog/roll');
// link previews for shared links
const { previewFor } = await import(root + '/src/lib/og.js');
const cx = { waitUntil() {} };
const pv1 = await previewFor(env, cx, new URL('https://tonyshi.photos/catalog?p=1'));
ok(pv1?.title === 'Brooklyn Bridge — Tony Shi' && pv1.image === 'https://tonyshi.photos/img/1/m', `shared photo link: its title and picture (${JSON.stringify(pv1)})`);
ok(await previewFor(env, cx, new URL('https://tonyshi.photos/photos?p=4')) === null, 'a private photo gives no preview');
const tr = await J('/api/catalog/tree'), alb = tr.tree.flatMap(a => [...a.albums, ...a.kids.flatMap(k => [...k.albums, ...k.kids.flatMap(x => x.albums)])]).find(a => a.title === 'New York');
const pv2 = await previewFor(env, cx, new URL('https://tonyshi.photos/catalog/' + alb.path));
ok(pv2?.title === 'New York — Tony Shi' && /album of 1 photograph by/.test(pv2.description) && pv2.image.endsWith('/img/1/m'), `shared album link: name and cover (${JSON.stringify(pv2)})`);
ok(await previewFor(env, cx, new URL('https://tonyshi.photos/catalog/roll')) === null, 'tabs fall back to the page title');
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
