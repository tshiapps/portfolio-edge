// Offline end-to-end simulation: real Worker code + real SQLite (node:sqlite as a D1 stand-in)
// against a fake Flickr with multiple accounts. Run: node --experimental-sqlite test/sim.mjs
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

// ---------- D1 shim ----------
const db = new DatabaseSync(':memory:');
const migDir = new URL('../migrations/', import.meta.url);
for (const f of readdirSync(migDir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, migDir), 'utf8'));
const norm = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
const plain = r => (r ? { ...r } : r);
class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.sql, a); }
  async run() { const r = /\breturning\b/i.test(this.sql) ? { changes: db.prepare(this.sql).all(...norm(this.args)).length } : db.prepare(this.sql).run(...norm(this.args)); return { meta: { changes: Number(r.changes) } }; }
  async all() { return { results: db.prepare(this.sql).all(...norm(this.args)).map(plain) }; }
  async first() { return plain(db.prepare(this.sql).get(...norm(this.args))) ?? null; }
}
const DB = {
  prepare: sql => new Stmt(sql),
  async batch(stmts) { db.exec('BEGIN'); try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
};

// ---------- fake Flickr ----------
const DAY = 86400;
function makeAccount(nsid, token, n, start, burst) {
  const photos = [];
  for (let i = 0; i < n; i++) {
    const up = burst && i < burst.n ? burst.at + i * 60 : start + Math.floor(i * 3.7 * DAY) % (11 * 365 * DAY);
    photos.push({ id: String(BigInt(nsid.length) * 10000000n + BigInt(photos.length + (nsid === '111@N01' ? 0 : 500000))), owner: nsid,
      secret: 'abc' + i, server: '65535', originalsecret: 'o' + i, title: `${nsid} photo ${i}`, ispublic: i % 7 ? 1 : 0,
      isfriend: 0, isfamily: 0, description: { _content: 'desc ' + i }, dateupload: String(up), lastupdate: String(up + 10),
      datetaken: '2020-01-01 10:00:00', tags: 'alaska mountain', machine_tags: '', latitude: i % 3 ? 61.2 : 0, longitude: i % 3 ? -149.9 : 0,
      accuracy: i % 3 ? 16 : 0, views: String(i), media: 'photo', pathalias: 'tony', originalformat: 'jpg',
      o_width: i % 97 === 5 ? '12000' : '6000', o_height: i % 97 === 5 ? '2000' : '4000', license: '0', rotation: i === 3 ? 90 : 0 });
  }
  const sets = [0, 1, 2].map(k => ({ id: `${nsid}-set${k}`, title: { _content: `Album ${k}` }, description: { _content: '' },
    primary: photos[k].id, photos: 0, videos: 0, members: photos.filter((_, i) => i % (k + 3) === 0).map(p => p.id) }));
  sets.forEach(s => (s.photos = s.members.length));
  return { nsid, token, photos, sets, calls: 0 };
}
const T0 = 1420070400; // 2015-01-01
const accounts = {
  'tokA': makeAccount('111@N01', 'tokA', 4300, T0, { at: 1590000000, n: 3800 }), // 3800 in one burst → window split
  'tokB': makeAccount('222@N02', 'tokB', 60, T0 + 400 * DAY),
};
let deletedId = null;
let listingCounts = false; // does fake Flickr honour count_faves/count_comments extras?
const withCounts = (arr, q) => listingCounts && /count_faves/.test(q.extras || '')
  ? arr.map(p => ({ ...p, count_faves: String(favesOf(p) + 100), count_comments: String(+p.id % 5) })) : arr;
const favesOf = p => +p.id % 13;
const page = (arr, per, p) => ({ page: p, pages: Math.max(1, Math.ceil(arr.length / per)), perpage: per, total: String(arr.length), slice: arr.slice((p - 1) * per, p * per) });
const ok = o => new Response(JSON.stringify({ stat: 'ok', ...o }), { headers: { 'content-type': 'application/json' } });
let restCalls = 0;
let blockBig = false; // simulate the CDN refusing large sizes outright
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'live.staticflickr.com') {
    const file = url.pathname.split('/').pop();
    const id = file.split('_')[0];
    // some photos: the CDN refuses big sizes unless the request looks like a browser on flickr.com
    if (+id % 11 === 0 && !/_b\.jpg$/.test(file) && !(init?.headers?.referer || '').includes('flickr.com')) return new Response('no', { status: 403 });
    if (+id % 11 === 0 && blockBig && !/_b\.jpg$/.test(file)) return new Response('no', { status: blockBig });
    const body = new Uint8Array(/_b\.jpg$/.test(file) ? 3000 : 6000);
    return new Response(body, { headers: { 'content-length': String(body.length), 'content-type': 'image/jpeg' } });
  }
  if (url.pathname.startsWith('/services/oauth/request_token')) {
    if (!url.searchParams.get('oauth_signature') || !url.searchParams.get('oauth_callback')) return new Response('bad', { status: 401 });
    return new Response('oauth_callback_confirmed=true&oauth_token=reqB&oauth_token_secret=reqsecret');
  }
  if (url.pathname.startsWith('/services/oauth/access_token')) {
    return new Response('fullname=Tony%20B&oauth_token=tokB&oauth_token_secret=secB&user_nsid=222%40N02&username=tonyb');
  }
  if (url.hostname !== 'api.flickr.com') throw new Error('unexpected fetch ' + url);
  restCalls++;
  const q = Object.fromEntries(url.searchParams);
  if (!q.oauth_signature || q.oauth_signature_method !== 'HMAC-SHA1') return ok({ stat: 'fail', code: 96, message: 'Invalid signature' });
  const acc = accounts[q.oauth_token];
  if (!acc) return new Response(JSON.stringify({ stat: 'fail', code: 98, message: 'Invalid auth token' }));
  acc.calls++;
  const live = acc.photos.filter(p => p.id !== deletedId);
  const byId = id => acc.photos.find(p => p.id === id);
  switch (q.method) {
    case 'flickr.people.getInfo': return ok({ person: { username: { _content: acc.nsid.split('@')[0] }, realname: { _content: 'Tony' }, path_alias: 'tony',
      photos: { firstdate: { _content: String(Math.min(...live.map(p => +p.dateupload))) }, count: { _content: live.length } } } });
    case 'flickr.people.getPhotos': {
      const f = live.filter(p => +p.dateupload >= +q.min_upload_date && +p.dateupload <= +q.max_upload_date);
      const pg = page(f, +q.per_page, +q.page || 1);
      return ok({ photos: { page: pg.page, pages: pg.pages, perpage: pg.perpage, total: pg.total, photo: withCounts(pg.slice, q) } });
    }
    case 'flickr.photos.recentlyUpdated': {
      const f = live.filter(p => +p.lastupdate >= +q.min_date);
      const pg = page(f, +q.per_page, +q.page || 1);
      return ok({ photos: { page: pg.page, pages: pg.pages, total: pg.total, photo: withCounts(pg.slice, q) } });
    }
    case 'flickr.photosets.getList': return ok({ photosets: { page: 1, pages: 1, photoset: acc.sets } });
    case 'flickr.photosets.getPhotos': {
      const s = acc.sets.find(x => x.id === q.photoset_id);
      if (!s) return new Response(JSON.stringify({ stat: 'fail', code: 1, message: 'Photoset not found' }));
      const pg = page(s.members, +q.per_page, +q.page || 1);
      return ok({ photoset: { page: pg.page, pages: pg.pages, photo: pg.slice.map(id => ({ id })) } });
    }
    case 'flickr.photos.getInfo': {
      const p = byId(q.photo_id);
      return ok({ photo: { id: p.id, rotation: p.rotation, views: p.views, comments: { _content: String(+p.id % 5) }, title: { _content: p.title }, description: p.description,
        tags: { tag: [{ raw: 'Alaska' }, { raw: 'Mountain' }] }, urls: { url: [{ type: 'photopage', _content: `https://www.flickr.com/photos/tony/${p.id}/` }] },
        location: p.accuracy ? { latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy, locality: { _content: 'Anchorage' }, region: { _content: 'Alaska' }, country: { _content: 'United States' } } : undefined } });
    }
    case 'flickr.photos.getExif': return ok({ photo: { camera: 'Sony A7R IV', exif: [{ tagspace: 'IFD0', tag: 'Make', label: 'Make', raw: { _content: 'Sony' } }, { tagspace: 'ExifIFD', tag: 'FNumber', label: 'Aperture', raw: { _content: '8.0' }, clean: { _content: 'f/8.0' } }] } });
    case 'flickr.photos.getSizes': if (byId(q.photo_id)?.o_width === '12000') return ok({ sizes: { size: [
      { label: 'Large', width: 1024, height: 171, source: 'https://live.staticflickr.com/p_b.jpg', media: 'photo' },
      { label: 'X-Large 6K', width: 6144, height: 1024, source: 'https://live.staticflickr.com/p_6k.jpg', media: 'photo' },
      { label: 'Original', width: 12000, height: 2000, source: 'https://live.staticflickr.com/p_o.jpg', media: 'photo' }] } });
    return ok({ sizes: { size: [
      { label: 'Large', width: 1024, height: 683, source: `https://live.staticflickr.com/${q.photo_id}_b.jpg`, media: 'photo' },
      { label: 'X-Large 3K', width: 3072, height: 2048, source: `https://live.staticflickr.com/${q.photo_id}_3k.jpg`, media: 'photo' },
      { label: 'Original', width: 6000, height: 4000, source: `https://live.staticflickr.com/${q.photo_id}_o.jpg`, media: 'photo' }] } });
    case 'flickr.photos.getFavorites': return ok({ photo: { id: q.photo_id, total: String(favesOf(byId(q.photo_id))), person: [] } });
    case 'flickr.collections.getTree': return ok({ collections: { collection: acc.nsid !== '111@N01' ? [] : [
      { id: '1-c1', title: 'Travel', description: '', set: [{ id: acc.sets[0].id, title: 'Album 0' }],
        collection: [{ id: '1-c2', title: 'Alaska', description: '', set: [{ id: acc.sets[1].id, title: 'Album 1' }] }] }] } });
    default: return ok({ stat: 'fail', code: 112, message: 'Method not found ' + q.method });
  }
};

// ---------- fake Images / R2 / Assets / caches ----------
const transforms = [];
const IMAGES = {
  input(stream) {
    const chain = { ops: [], transform(o) { this.ops.push(o); return this; },
      async output(o) {
        const inLen = (await new Response(stream).arrayBuffer()).byteLength;
        transforms.push({ ops: this.ops, out: o });
        const big = o.format === 'image/jpeg';
        return { response: () => new Response(new Uint8Array(!big ? 9_000 : inLen <= 3000 ? 60_000 : 120_000)) };
      } };
    return chain;
  },
  async info(stream) { const b = await new Response(stream).arrayBuffer(); return b.byteLength > 100_000 ? { width: 2500, height: 1667 } : { width: 1024, height: 683 }; },
};
const r2 = new Map();
const BUCKET = {
  async put(k, v, o) { r2.set(k, { v, o }); },
  async get(k) { const x = r2.get(k); return x ? { body: new Uint8Array(x.v), httpMetadata: x.o.httpMetadata, httpEtag: '"e"' } : null; },
  async delete(keys) { [].concat(keys).forEach(k => r2.delete(k)); },
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const env = { SYNC_TICK_MS: 40000, DB, IMAGES, BUCKET, ENCRYPTION_KEY: 'test-key', ADMIN_PASSWORD: 'pw', SITE_NAME: 'T', TURNSTILE_SITE_KEY: 'x',
  ASSETS: { fetch: async () => new Response('<html>asset</html>', { headers: { 'content-type': 'text/html' } }) } };
const pending = [];
const ctx = { waitUntil: p => pending.push(p) };

const { default: worker } = await import('../src/index.js');
const { runTick } = await import('../src/sync/engine.js');
const { seal } = await import('../src/lib/crypto.js');
const auth = { authorization: 'Basic ' + btoa('admin:pw') };
const call = async (path, opts = {}) => {
  const res = await worker.fetch(new Request('https://beta.tonyshi.photos' + path, { ...opts, headers: { ...auth, ...(opts.headers || {}) } }), env, ctx);
  return res;
};
const j = async (path, opts) => { const r = await call(path, opts); const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, text: t }; } };
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  -', m); };

// ---------- scenario ----------
assert((await call('/api/admin/status', { headers: { authorization: '' } })).status === 401, 'admin requires auth');
assert((await j('/api/admin/settings', { method: 'POST', body: JSON.stringify({ flickr_api_key: 'nothex' }) })).status === 400, 'rejects malformed API key');
assert((await j('/api/admin/settings', { method: 'POST', body: JSON.stringify({ flickr_api_key: '0123456789abcdef0123456789abcdef', flickr_api_secret: '0123456789abcdef', api_budget: 3500, base_edge: 2500 }) })).ok, 'saves API key + secret');
// (base size 2500 here = what the fake image service reports, so nothing needs shrinking in this run)
const secretRow = db.prepare("SELECT value FROM settings WHERE key='flickr_api_secret'").get();
assert(!secretRow.value.includes('0123456789abcdef'), 'API secret encrypted at rest');

// account A inserted directly; account B through the real OAuth connect flow
db.prepare('INSERT INTO accounts (nsid, username, token_enc, token_secret_enc) VALUES (?,?,?,?)').run('111@N01', 'tonya', await seal(env, 'tokA'), await seal(env, 'secA'));
const c1 = await call('/admin/flickr/connect', { redirect: 'manual' });
assert(c1.status === 302 && c1.headers.get('location').includes('oauth_token=reqB'), 'connect redirects to Flickr authorize');
const c2 = await call('/admin/flickr/callback?oauth_token=reqB&oauth_verifier=ver', { redirect: 'manual' });
assert(c2.status === 302 && c2.headers.get('location').includes('connected=tonyb'), 'callback stores account and redirects');

// run ticks until everything settles (budget raised for the simulation)
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('api_budget','3500')").run();
// the sim compresses hours into seconds: lift the per-minute image-download pacing (tested separately below)
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('cdn_rate','1000000')").run();
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('cdn_rate_at', ?)").run(String(Math.floor(Date.now() / 1000)));
let ticks = 0;
const settle = async (max = 400) => {
  for (; ticks < max; ticks++) {
    db.prepare('DELETE FROM api_usage').run(); // pretend each tick is a fresh hour so the sim runs fast
    const s = await runTick(env);
    const left = db.prepare("SELECT COUNT(*) n FROM photos WHERE status IN ('pending','meta')").get().n;
    const busy = db.prepare("SELECT COUNT(*) n FROM accounts WHERE sync_phase != 'idle'").get().n;
    if (s.errors || ticks < 3 || s.skipped) console.log('tick', ticks, JSON.stringify(s));
    if (!left && !busy) break;
  }
};
await settle();
const counts = Object.fromEntries(db.prepare('SELECT account_id, COUNT(*) n FROM photos GROUP BY account_id').all().map(r => [r.account_id, r.n]));
// every 7th test photo is private on Flickr: those are skipped entirely (4300 → 3685, 60 → 51)
assert(counts[1] === 3685, `account A fully cataloged — public photos only (${counts[1]}/3685) incl. 3800-photo burst window`);
assert(counts[2] === 51, `account B fully cataloged — public photos only (${counts[2]}/51)`);
assert(db.prepare("SELECT COUNT(*) n FROM photos WHERE is_public = 0").get().n === 0, 'private photos never stored');
assert(db.prepare("SELECT COUNT(*) n FROM photos WHERE status='ok'").get().n === 3736, 'all public photos stored');
assert(r2.size === 3736 * 2, `R2 has master + thumb for each (${r2.size})`);
const p3 = db.prepare("SELECT * FROM photos WHERE title='111@N01 photo 3'").get();
assert(p3.source_size === 'X-Large 3K', `not a showcase photo → base size: picked the smallest source ≥ the base size (${p3.source_size})`);
assert(JSON.parse(p3.exif).items.length === 2 && JSON.parse(p3.location || 'null') === null, 'EXIF stored; no location when no geo');
const p1 = db.prepare("SELECT * FROM photos WHERE title='111@N01 photo 1'").get();
assert(JSON.parse(p1.location).locality === 'Anchorage' && p1.latitude === 61.2, 'location + GPS stored');
const t = transforms[0];
assert(t.out.quality === 75 && t.ops.some(o => o.width === 2500 && o.fit === 'scale-down'), 'master transform: base size scale-down, q75 JPEG');
assert(db.prepare("SELECT COUNT(*) n FROM albums WHERE source='flickr'").get().n === 6, 'Flickr albums mirrored for both accounts');
const a0 = db.prepare("SELECT COUNT(*) n FROM album_photos WHERE album_id='f:111@N01-set0'").get().n;
assert(a0 === accounts.tokA.sets[0].members.length, `album membership complete (${a0})`);
console.log(`   … ${ticks} ticks, ${restCalls} Flickr REST calls`);
// metrics fallback (listing gave no counts) runs after ingest
for (let i = 0; i < 20 && db.prepare("SELECT COUNT(*) n FROM photos WHERE status='ok' AND metrics_at IS NULL").get().n; i++) {
  db.prepare('DELETE FROM api_usage').run(); await runTick(env);
}
const pf = db.prepare("SELECT id, faves, comments, metrics_at FROM photos WHERE title='111@N01 photo 8'").get();
assert(pf.faves === +pf.id % 13 && pf.comments === +pf.id % 5 && pf.metrics_at, `faves/comments filled by per-photo fallback (${pf.faves}/${pf.comments})`);
assert(db.prepare("SELECT COUNT(*) n FROM photos WHERE status='ok' AND metrics_at IS NULL").get().n === 0, 'every stored photo has metrics');
assert(db.prepare("SELECT COUNT(*) n FROM collections").get().n === 2, 'collections mirrored (incl. nested)');
const inTravel = db.prepare("SELECT COUNT(DISTINCT ap.photo_id) n FROM collection_albums ca JOIN album_photos ap ON ap.album_id=ca.album_id WHERE ca.collection_id='c:1-c1'").get().n;
const expect = new Set([...accounts.tokA.sets[0].members, ...accounts.tokA.sets[1].members]).size;
assert(inTravel === expect, `parent collection includes nested collection's album (${inTravel}/${expect})`);

// panoramas: sized by their short edge, from a big enough source
const pano = db.prepare("SELECT * FROM photos WHERE o_width = 12000 AND status = 'ok' LIMIT 1").get();
assert(pano && pano.source_size === 'Original', `panorama made from a source large enough (${pano?.source_size})`);
const boxesSeen = transforms.filter(x => x.ops.some(o => o.width === 8000 && o.height === 1400));
assert(boxesSeen.length > 0 && transforms.some(x => x.ops.some(o => o.width === 3840 && o.height === 640)), 'panorama master box 8000×1400, thumbnail box 3840×640');
assert(transforms.some(x => x.ops.some(o => o.width === 2500 && o.height === 2500)), 'normal (non-showcase) photos get the base long-edge box');

// tags applied on ingest: geotag (Anchorage, Alaska, United States) + Flickr words ("mountain" → Nature → Landscape)
const tg = db.prepare("SELECT t.slug FROM photo_tags pt JOIN site_tags t ON t.id = pt.tag_id WHERE pt.photo_id = ? ORDER BY t.slug").all(p1.id).map(r => r.slug);
assert(JSON.stringify(tg) === JSON.stringify(['alaska', 'anchorage', 'landscape', 'nature', 'usa']), `new photos tagged during sync: ${tg}`);
assert(db.prepare("SELECT label FROM site_tags WHERE slug='alaska'").get().label === 'Alaska', 'location labels stay plain unless ambiguous');

// change detection: a new upload, a metadata edit, a replaced photo, and a deletion
const A = accounts.tokA, nowS = Math.floor(Date.now() / 1000);
A.photos.push({ ...A.photos[10], id: '99999999', title: 'brand new', dateupload: String(nowS), lastupdate: String(nowS) });
A.photos[20].title = 'edited title'; A.photos[20].lastupdate = String(nowS);
A.photos[30].secret = 'replaced'; A.photos[30].lastupdate = String(nowS);
deletedId = A.photos[40].id;
db.prepare("UPDATE accounts SET last_recent_check = last_recent_check - 90000").run();
ticks = 0; await settle(20);
assert(db.prepare("SELECT status FROM photos WHERE id='99999999'").get()?.status === 'ok', 'new upload picked up and stored');
assert(db.prepare('SELECT title FROM photos WHERE id=?').get(A.photos[20].id).title === 'edited title', 'metadata edit synced');
const before = transforms.length;
db.prepare("UPDATE accounts SET last_full_sync = last_full_sync - 90000, last_recent_check = last_recent_check - 90000").run();
ticks = 0; await settle(60);
assert(db.prepare('SELECT status FROM photos WHERE id=?').get(deletedId).status === 'deleted', 'deletion detected on daily full listing');
assert(transforms.length - before < 10, `full re-list does not re-download unchanged photos (${transforms.length - before} transforms)`);

// listing that does carry counts: values come straight from the daily listing, no per-photo calls
listingCounts = true;
db.prepare("UPDATE accounts SET last_full_sync = last_full_sync - 90000").run();
const callsBefore = restCalls;
ticks = 0; await settle(60);
const pc = db.prepare("SELECT faves FROM photos WHERE id=?").get(pf.id);
assert(pc.faves === (+pf.id % 13) + 100, `faves refreshed from the listing extras (${pc.faves})`);
assert(db.prepare("SELECT value FROM settings WHERE key='listing_has_counts'").get().value === '1', 'detected listing counts');
console.log(`   … counts refresh via listing cost ${restCalls - callsBefore} calls for 4,360 photos`);

// admin API
const st = await j('/api/admin/status');
assert(st.accounts.length === 2 && st.accounts[0].counts.ok === 3685, 'status endpoint reports per-account counts');
const list = await j('/api/admin/photos?limit=50&sort=taken&q=photo');
assert(list.total > 3500 && list.photos.length === 50, 'organizer listing + search');
const ids = (await j('/api/admin/photos/ids?album=f:111@N01-set1')).ids;
const pubIds = new Set(A.photos.filter(p => +p.ispublic).map(p => p.id));
assert(ids.length === A.sets[1].members.filter(id => id !== deletedId && pubIds.has(id)).length, `select-all ids for an album filter (${ids.length})`);
const al = await j('/api/admin/albums', { method: 'POST', body: JSON.stringify({ title: 'Featured' }) });
const add = await j(`/api/admin/albums/${encodeURIComponent(al.id)}/photos`, { method: 'POST', body: JSON.stringify({ ids: ids.slice(0, 250), action: 'add' }) });
assert(add.count === 250, 'mass add 250 photos to a site album');
assert((await j('/api/admin/albums/f:111@N01-set0/photos', { method: 'POST', body: JSON.stringify({ ids: ['1'] }) })).status === 400, 'Flickr albums are read-only');
const p12 = db.prepare("SELECT id FROM photos WHERE title='111@N01 photo 12'").get();
// popularity: scores computed by the cron, re-scored when weights change, used by the organizer + front page
const { score: popScore, weights: popW } = await import('../src/lib/popularity.js');
const nowT = Math.floor(Date.now() / 1000);
const w0 = popW({});
assert(popScore({ faves: 10, views: 1000, comments: 5, date_upload: nowT - 10 * 31557600 }, w0, nowT)
  < popScore({ faves: 10, views: 1000, comments: 5, date_upload: nowT - 31557600 }, w0, nowT), 'time discount: same counts, older upload scores lower');
assert(popScore({ faves: 0, views: 0, comments: 100, date_upload: nowT }, w0, nowT)
  < popScore({ faves: 20, views: 0, comments: 0, date_upload: nowT }, w0, nowT), 'comments weigh less than faves by default');
assert(db.prepare("SELECT COUNT(*) n FROM photos WHERE status='ok' AND pop_score IS NULL").get().n === 0, 'every stored photo has a popularity score');
const rw = await j('/api/admin/settings', { method: 'POST', body: JSON.stringify({ pop_faves: 5, pop_views: 1, pop_comments: 0, pop_decay: 1 }) });
assert(rw.rescored > 3500, `saving weights re-scores everything (${rw.rescored})`);
assert((await j('/api/admin/settings', { method: 'POST', body: JSON.stringify({ pop_decay: 9 }) })).status === 400, 'out-of-range weight rejected');
const pop = await j('/api/admin/photos?sort=popular&limit=20');
assert(pop.photos.every((x, i, a) => i === 0 || (a[i - 1].pop_score ?? 0) >= (x.pop_score ?? 0)) && pop.photos[0].pop_score > 0, 'organizer sorts by popularity score');
const pv = await j('/api/admin/popularity');
assert(pv.weights.F === 5 && pv.weights.D === 1 && pv.photos.length > 3500, 'popularity page data');
await j('/api/admin/settings', { method: 'POST', body: JSON.stringify({ front_mode: 'top', front_top_n: 10, front_order: 'rank' }) });
const topFe = await (await worker.fetch(new Request('https://x/api/featured'), env, ctx)).json();
const expectTop = db.prepare("SELECT id FROM photos WHERE status='ok' AND is_public=1 AND hidden=0 AND media='photo' ORDER BY pop_score DESC, id LIMIT 10").all().map(r => r.id);
assert(topFe.mode === 'top' && topFe.photos.length === 10 && topFe.photos.map(p => p.id).join() === expectTop.join(), 'photo page = top 10 by score, in rank order');
await j('/api/admin/settings', { method: 'POST', body: JSON.stringify({ front_order: 'shuffle' }) });
const topSh = await (await worker.fetch(new Request('https://x/api/featured'), env, ctx)).json();
assert(new Set(topSh.photos.map(p => p.id)).size === 10 && topSh.photos.every(p => expectTop.includes(p.id)), 'shuffled mode: same top 10, weekly order');
await j('/api/admin/settings', { method: 'POST', body: JSON.stringify({ front_mode: 'weekly' }) });
const cf = await j('/api/admin/photos?collection=' + encodeURIComponent('c:1-c1') + '&limit=1');
assert(cf.total > 0, `collection filter (${cf.total})`);
const cl = await j('/api/admin/collections');
assert(cl.collections.length === 2 && cl.albums.length === 2, 'collections endpoint');
const det = await j('/api/admin/photos/' + p12.id);
assert(det.collections.length === 2, `photo detail lists its collections (${det.collections.length})`);
assert(det.exif.items.length === 2 && det.albums.length === 2, `photo detail with EXIF + albums (${det.albums?.length})`);
await j('/api/admin/photos/bulk', { method: 'POST', body: JSON.stringify({ ids: [p1.id], hidden: true }) });

// silent small-size fallback: browser-like headers get the big sizes; if the CDN still refuses, it's logged + filterable
assert(db.prepare("SELECT COUNT(*) n FROM photos WHERE status='ok' AND width < 1500").get().n === 0, 'browser-like headers: no photo fell back to 1024');
blockBig = 403;
const victims = db.prepare("SELECT id FROM photos WHERE status='ok' AND CAST(id AS INTEGER) % 11 = 0 AND o_width = 6000 LIMIT 5").all().map(r => r.id);
await j('/api/admin/photos/bulk', { method: 'POST', body: JSON.stringify({ ids: victims, reprocess: true }) });
ticks = 0; await settle(10);
const low = await j('/api/admin/photos/ids?shape=lowres');
assert(victims.every(id => low.ids.includes(id)), `Low resolution filter finds photos stuck at 1024 (${low.ids.length})`);
assert(db.prepare("SELECT COUNT(*) n FROM sync_log WHERE level='warn' AND msg LIKE '%used Large%HTTP 403%'").get().n >= victims.length, 'fallback is logged with the reason');
assert((await j('/api/admin/status')).lowres >= victims.length, 'dashboard shows the low-res count');
// 429 from Flickr's image servers: no fallback, photos wait (no attempt used), downloads pause and slow down
blockBig = 429;
await j('/api/admin/photos/bulk', { method: 'POST', body: JSON.stringify({ ids: low.ids, reprocess: true }) });
db.prepare('DELETE FROM api_usage').run();
await runTick(env);
const st429 = db.prepare(`SELECT status, attempts, width FROM photos WHERE id IN (${low.ids.map(() => '?').join(',')})`).all(...low.ids);
assert(st429.every(r => r.status === 'fetch' && r.attempts === 0), 'on 429: photos handed to the photo fetcher for the full size (no fallback, no attempt used)');
const cdnSet = Object.fromEntries(db.prepare("SELECT key, value FROM settings WHERE key LIKE 'cdn_%'").all().map(r => [r.key, r.value]));
assert(+cdnSet.cdn_pause_until > Date.now() / 1000 + 500 && +cdnSet.cdn_rate === 500000, `on 429: downloads paused ≥10 min and rate halved (${cdnSet.cdn_rate}/min)`);
assert(db.prepare("SELECT COUNT(*) n FROM sync_log WHERE msg LIKE '%asked us to slow down (429)%'").get().n === 1, '429 logged once, plainly');
const stP = await j('/api/admin/status');
assert(stP.cdn.pausedUntil > stP.now, 'dashboard shows the pause');
db.prepare('DELETE FROM api_usage').run();
const tPaused = await runTick(env);
{ const nf = db.prepare(`SELECT COUNT(*) n FROM photos WHERE status='fetch'`).get().n; assert(nf === low.ids.length, `while paused: they wait for the fetcher, untouched (${nf} vs ${low.ids.length})`); }
blockBig = false;
db.prepare("UPDATE settings SET value = '0' WHERE key = 'cdn_pause_until'").run();
await j('/api/admin/photos/bulk', { method: 'POST', body: JSON.stringify({ ids: low.ids, reprocess: true }) }); // or the fetcher would pick them up
ticks = 0; await settle(10);
assert((await j('/api/admin/photos/ids?shape=lowres')).ids.length === 0, 'after the pause: full sizes downloaded, low-res fixed');

// pacing: allowance per minute is respected
db.prepare("UPDATE settings SET value = '2' WHERE key = 'cdn_rate'").run();
db.prepare("UPDATE settings SET value = ? WHERE key = 'cdn_rate_at'").run(String(Math.floor(Date.now() / 1000)));
const some = db.prepare("SELECT id FROM photos WHERE status='ok' LIMIT 6").all().map(r => r.id);
await j('/api/admin/photos/bulk', { method: 'POST', body: JSON.stringify({ ids: some, reprocess: true }) });
db.prepare('DELETE FROM api_usage').run();
const tPace = await runTick(env);
assert(db.prepare(`SELECT COUNT(*) n FROM photos WHERE status='pending'`).get().n === 4, `pacing: only 2 full-size downloads this minute (${tPace.ingested} ingested)`);
db.prepare("UPDATE settings SET value = '1000000' WHERE key = 'cdn_rate'").run();
ticks = 0; await settle(10);

// organizer: find panoramas, re-process them
const panos = await j('/api/admin/photos/ids?shape=pano&ratio=2.2');
const nPano = db.prepare("SELECT COUNT(*) n FROM photos WHERE o_width = 12000 AND status != 'deleted'").get().n;
assert(panos.ids.length === nPano && nPano > 10, `Panoramas filter finds them (${panos.ids.length})`);
const tBefore = transforms.length;
const rp = await j('/api/admin/photos/bulk', { method: 'POST', body: JSON.stringify({ ids: panos.ids, reprocess: true }) });
assert(rp.queued === nPano, `re-process queues them (${rp.queued})`);
ticks = 0; await settle(20);
assert(db.prepare("SELECT COUNT(*) n FROM photos WHERE o_width = 12000 AND status = 'ok'").get().n === nPano
  && transforms.length - tBefore === nPano * 2, `re-processed panoramas stored again (${transforms.length - tBefore} transforms)`);

// public site
// a photo made private on Flickr later is removed (with its files) at the next check
const priv = db.prepare("SELECT id FROM photos WHERE is_public=1 AND status='ok' LIMIT 1").get().id;
db.prepare('UPDATE photos SET is_public = 0 WHERE id = ?').run(priv);
const { purgePrivate } = await import(new URL('../src/lib/purge.js', import.meta.url));
await purgePrivate(env);
assert(!db.prepare('SELECT 1 FROM photos WHERE id = ?').get(priv) && !r2.has(`m/${priv}.jpg`), 'private photo removed with its files');
assert((await worker.fetch(new Request('https://x/img/' + priv + '/m'), env, ctx)).status === 404, 'private photo never served publicly');
const pub = db.prepare("SELECT id FROM photos WHERE is_public=1 AND hidden=0 AND status='ok' LIMIT 1").get().id;
assert((await worker.fetch(new Request('https://x/img/' + pub + '/t'), env, ctx)).status === 200, 'public photo served');
const fe = await (await worker.fetch(new Request('https://x/api/featured'), env, ctx)).json();
assert(fe.photos.length === 60 && fe.photos.every(p => p.w && p.h), `featured returns 60 with dimensions (${fe.week})`);
const fe2 = await (await worker.fetch(new Request('https://x/api/featured'), env, ctx)).json();
assert(JSON.stringify(fe) === JSON.stringify(fe2), 'featured selection is stable within the week');
assert((await worker.fetch(new Request('https://x/api/admin/status'), env, ctx)).status === 401, 'admin API locked without auth');
await Promise.all(pending);
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
