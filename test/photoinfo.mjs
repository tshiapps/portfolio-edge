// Public photo details: tile stats on the featured list, the lightbox detail (Flickr stats + galleries, place
// only when public, Getty page, Instagram, camera/year, size & print, license, views here), comments, view counts.
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
const env = {
  DB: { prepare: q => new S(q), async batch(st) { for (const x of st) await x.run(); } }, ADMIN_PASSWORD: 'pw', ENCRYPTION_KEY: 'k'.repeat(44),
  BUCKET: { async get() { return null; } }, ASSETS: { fetch: async () => new Response('x') },
};
const store = new Map();
globalThis.caches = { default: { match: async r => store.get(typeof r === 'string' ? r : r.url)?.clone() || null, put: async (r, res) => { store.set(typeof r === 'string' ? r : r.url, res); } } };
let flickrCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const url = new URL(typeof u === 'object' && u.url ? u.url : String(u));
  if (url.host === 'graph.facebook.com') {
    if (url.pathname.endsWith('/me/accounts')) return Response.json({ data: [{ name: 'Page', access_token: 'EAApage' + 'p'.repeat(50), instagram_business_account: { id: '178', username: 'tonyshiphoto' } }] });
    if (url.pathname.endsWith('/7/comments')) {
      if (!url.searchParams.get('after')) return Response.json({ data: [{ id: 'c1', username: 'amy', text: 'Wow', timestamp: '2025-01-02T00:00:00+0000', like_count: 3,
        replies: { data: [{ username: 'tonyshiphoto', text: 'Thanks!', timestamp: '2025-01-03T00:00:00+0000' }] } }], paging: { next: url.href + '&after=x' } });
      return Response.json({ data: [{ id: 'c0', username: 'ben', text: 'First', timestamp: '2025-01-01T00:00:00+0000' }] });
    }
    return Response.json({ data: [] });
  }
  if (url.host === 'api.flickr.com') {
    const m = url.searchParams.get('method'); flickrCalls.push(m);
    if (m === 'flickr.galleries.getListForPhoto') return Response.json({ stat: 'ok', galleries: { total: '7', gallery: [] } });
    if (m === 'flickr.photos.comments.getList') return Response.json({ stat: 'ok', comments: { comment: [
      { authorname: 'jdoe', realname: 'Jane Doe', author: '12@N01', iconserver: '65', iconfarm: '1', datecreate: '1700000000', _content: 'Stunning <b>light</b>!<br />Fave.<br /><a href="x"><img src="award.gif" /></a>', permalink: 'https://flickr.com/c/1' },
      { authorname: 'bob', author: '13@N01', iconserver: '0', iconfarm: '0', datecreate: '1700000100', _content: 'Caf&#233; &amp; skyline' }] } });
    return Response.json({ stat: 'fail', code: 1, message: 'unknown' });
  }
  return realFetch(u, init);
};
const { seal } = await import(root + '/src/lib/crypto.js');
const { default: w } = await import(root + '/src/index.js');
const ok = (c, m) => { console.log((c ? 'ok  - ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };
const go = (p, init = {}) => w.fetch(new Request('https://tonyshi.photos' + p, { ...init, headers: { 'cf-connecting-ip': '1.2.3.4', ...(init.headers || {}) } }), env, { waitUntil() {} });

db.prepare("INSERT INTO settings (key, value) VALUES ('flickr_api_key', 'KEY')").run();
db.prepare("INSERT INTO settings (key, value) VALUES ('flickr_api_secret', ?)").run(await seal(env, 'SECRET'));
db.prepare("INSERT INTO accounts (nsid, token_enc, token_secret_enc) VALUES ('1@N1', ?, ?)").run(await seal(env, 't'), await seal(env, 's'));
const loc = JSON.stringify({ latitude: 40.7128, longitude: -74.006, accuracy: 16, locality: 'New York', region: 'New York', country: 'United States' });
const exif = JSON.stringify({ camera: 'Nikon D850', items: [{ tag: 'Make', raw: 'NIKON CORPORATION', clean: null }, { tag: 'Model', raw: 'NIKON D850' }, { tag: 'LensModel', raw: '24.0-70.0 mm f/2.8' }] });
const add = (id, extra) => db.prepare(`INSERT INTO photos (id, account_id, title, status, is_public, hidden, thumb_w, thumb_h, synced_at, views, faves, comments, license,
  o_width, o_height, date_taken, location, exif, info, page_url, pop_score, media) VALUES (?, 1, ?, 'ok', 1, 0, 1024, 683, 5, 1234, 56, 3, ?, 8256, 5504, '2019-07-04 21:10:00', ?, ?, ?, ?, ?, 'photo')`)
  .run(id, 'Photo ' + id, extra.license ?? 0, extra.loc ?? null, exif, JSON.stringify({ geoperms: { ispublic: extra.geo ?? 1 } }), `https://www.flickr.com/photos/tonyshi/${id}/`, 100 - +id % 10);
add('101', { loc }); add('102', { loc, geo: 0, license: 4 }); add('103', {});
db.prepare("INSERT INTO getty_assets (asset_id, photo_id, page_url, in_portfolio, is_video) VALUES ('900', '101', 'https://www.gettyimages.com/detail/photo/x/900', 1, 0)").run();
db.prepare("INSERT INTO getty_sales (royalty_month, asset_id, royalty) VALUES ('2025-01', '900', 99.5)").run();
db.prepare("INSERT INTO ig_media (id, post_id, permalink, like_count, comments_count, seen_at, deleted) VALUES ('7', '7', 'https://www.instagram.com/p/A/', 321, 4, 1, 0)").run();
db.prepare("INSERT INTO ig_links (ig_id, photo_id, status) VALUES ('7', '101', 'confirmed')").run();

const f = await (await go('/api/featured')).json();
const t = f.photos.find(p => p.id === '101'), t2 = f.photos.find(p => p.id === '102');
ok(t && t.s?.[0] === 1234 && t.s[1] === 56 && t.s[2] === 3 && t.loc === 'New York, United States' && t.gid === '900', `tile: Flickr stats, place, Getty (${JSON.stringify(t)})`);
ok(t2 && !t2.loc, 'tile: a photo whose location is private on Flickr shows no place');
ok(!JSON.stringify(f).includes('99.5'), 'no Getty sales numbers in public data');

const d = await (await go('/api/photo/101')).json();
ok(d.flickr.views === 1234 && d.flickr.faves === 56 && d.flickr.galleries === 7 && flickrCalls.includes('flickr.galleries.getListForPhoto'), 'detail: Flickr stats + galleries looked up');
ok(d.place.label === 'New York, United States' && d.place.lat === 40.7128 && d.place.accuracy === 16, 'detail: place with map position');
ok(d.getty.id === '900' && d.getty.url.endsWith('/900'), 'detail: exact Getty page');
ok(d.instagram[0].likes === 321 && d.instagram[0].comments === 4, 'detail: Instagram likes & comments');
ok(d.camera === 'NIKON D850' && d.year === 2019, `detail: camera and year (${d.camera}, ${d.year})`);
ok(d.size.w === 8256 && d.size.mp === 45.4 && Math.round(d.size.print300.cm[0]) === 70 && Math.round(d.size.print300.in[0]) === 28, `detail: 45 MP, prints 70 cm / 28″ wide at 300 ppi (${JSON.stringify(d.size.print300)})`);
ok(d.license.mark === '©' && /All rights/.test(d.license.name), 'detail: license (Flickr’s, here all rights reserved)');
ok(!JSON.stringify(d).includes('99.5') && !('sales' in (d.getty || {})), 'detail: no sales numbers');
const d2 = await (await go('/api/photo/102')).json();
ok(d2.place === null && d2.license.name === 'CC BY 2.0', 'private location hidden; CC license shown');
flickrCalls = [];
store.clear();
await go('/api/photo/101');
ok(!flickrCalls.includes('flickr.galleries.getListForPhoto'), 'galleries not looked up again for 3 days');
ok((await go('/api/photo/999')).status === 404, 'unknown / non-public photo: 404');

const cm = await (await go('/api/photo/101/comments?src=flickr')).json();
ok(cm.comments[0].who === 'Jane Doe' && cm.comments[0].text === 'Stunning light!\nFave.' && cm.comments[0].icon === 'https://farm1.staticflickr.com/65/buddyicons/12@N01.jpg', `Flickr comments as plain text with buddy icon (${JSON.stringify(cm.comments[0])})`);
ok(cm.comments[1].text === 'Café & skyline' && cm.comments[1].icon === null && !JSON.stringify(cm).includes('flickr.com/c/'), 'entities decoded, no icon → initial, no outbound links');
const ic = await (await go('/api/photo/101/comments?src=ig')).json();
ok(ic.unavailable === true && !ic.link, 'Instagram comments: not connected → “unavailable”, no link out');

const { saveToken } = await import(root + '/src/lib/instagram.js');
await saveToken(env, 'EAAuser' + 'u'.repeat(60));
store.clear();
const ic2 = await (await go('/api/photo/101/comments?src=ig')).json();
ok(ic2.comments.length === 2 && ic2.comments[0].who === 'ben' && ic2.comments[1].replies[0].text === 'Thanks!' && ic2.comments[1].likes === 3,
  `Instagram comments: all pages, oldest first, with replies (${JSON.stringify(ic2.comments)})`);
await go('/api/photo/101/view', { method: 'POST' });
await go('/api/photo/101/view', { method: 'POST' });
await go('/api/photo/101/view', { method: 'POST', headers: { 'cf-connecting-ip': '5.6.7.8' } });
ok(db.prepare("SELECT tsp_views FROM photos WHERE id = '101'").get().tsp_views === 2, 'views here: counted once per visitor per 30 min');
await go('/api/photo/103/view', { method: 'POST' });
db.prepare("UPDATE photos SET is_public = 0 WHERE id = '103'").run();
await go('/api/photo/103/view', { method: 'POST', headers: { 'cf-connecting-ip': '9.9.9.9' } });
ok(db.prepare("SELECT tsp_views FROM photos WHERE id = '103'").get().tsp_views === 1, 'non-public photos aren’t counted');
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
