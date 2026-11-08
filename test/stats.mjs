// Stats: daily snapshots (only changed photos), account totals, Flickr stats API (Pro) vs free accounts,
// overview gains, rising photos, leaders (with Instagram + Getty), "what works" breakdowns.
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
  BUCKET: { async get() { return null; } }, ASSETS: { fetch: async () => new Response('x') } };
globalThis.caches = { default: { match: async () => null, put: async () => {} } };
const { seal } = await import(root + '/src/lib/crypto.js');
const { snapshot, statsTick } = await import(root + '/src/lib/stats.js');
const { getSettings } = await import(root + '/src/lib/settings.js');
const { default: w } = await import(root + '/src/index.js');
const ok = (c, m) => { console.log((c ? 'ok  - ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };
const J = async p => (await w.fetch(new Request('https://x/api/admin' + p, { headers: { authorization: 'Basic ' + btoa('admin:pw') } }), env, { waitUntil() {} })).json();
const day = n => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);

db.prepare("INSERT INTO settings (key, value) VALUES ('flickr_api_key', 'KEY')").run();
db.prepare("INSERT INTO settings (key, value) VALUES ('flickr_api_secret', ?)").run(await seal(env, 'SECRET'));
db.prepare("INSERT INTO accounts (id, nsid, username, token_enc, token_secret_enc) VALUES (1, '1@N1', 'Tony Shi Photos', ?, ?), (2, '2@N1', 'TSP Tactical', ?, ?)")
  .run(await seal(env, 't1'), await seal(env, 's1'), await seal(env, 't2'), await seal(env, 's2'));
const add = (id, acc, views, faves, o = {}) => db.prepare(`INSERT INTO photos (id, account_id, title, status, is_public, hidden, media, views, faves, comments, year, camera, country, thumb_w, thumb_h, date_upload, synced_at)
  VALUES (?, ?, ?, 'ok', 1, 0, 'photo', ?, ?, ?, ?, ?, ?, 1024, 683, ?, 1)`).run(id, acc, 'P' + id, views, faves, o.c || 0, o.year || 2019, o.cam || 'NIKON D850', o.country || 'United States', o.up || 1500000000);
add('1', 1, 10000, 100, { c: 5 }); add('2', 1, 2000, 80, { year: 2015, country: 'Greece' }); add('3', 1, 500, 2); add('4', 2, 800, 10, { cam: 'DJI FC3170' }); add('5', 1, 300, 30, { year: 2015 });

// day -2 / -1 snapshots, counts moving in between
ok(await snapshot(env, day(-2)) === 5, 'first snapshot records every photo');
db.prepare("UPDATE photos SET views = views + 500, faves = faves + 5 WHERE id = '2'").run();
db.prepare("UPDATE photos SET views = views + 100 WHERE id = '4'").run();
ok(await snapshot(env, day(-1)) === 2, 'next day: only the 2 photos whose counts changed are written');
db.prepare("UPDATE photos SET views = views + 50 WHERE id = '1'").run();
await snapshot(env, day(0));
ok(db.prepare('SELECT COUNT(*) n FROM account_daily').get().n === 6, 'account totals per day');

// Flickr stats API: Pro account works, the free one is marked "not available"
let calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const url = new URL(typeof u === 'object' && u.url ? u.url : String(u));
  if (url.host === 'api.flickr.com') {
    const m = url.searchParams.get('method'), tok = url.searchParams.get('oauth_token'); calls.push(m);
    if (tok === 't2') return Response.json({ stat: 'fail', code: 1, message: 'User does not have stats' });
    if (m === 'flickr.stats.getTotalViews') return Response.json({ stat: 'ok', stats: { total: { views: 120 }, photos: { views: 90 }, photostream: { views: 20 }, sets: { views: 10 }, galleries: { views: 0 }, collections: { views: 0 } } });
    if (m === 'flickr.stats.getPhotostreamDomains') return Response.json({ stat: 'ok', domains: { domain: [{ name: 'flickr.com', views: 70 }, { name: 'google.com', views: 30 }] } });
  }
  return realFetch(u, init);
};
let r = await statsTick(env, await getSettings(env));
const a1 = db.prepare('SELECT stats_ok FROM accounts WHERE id = 1').get().stats_ok, a2 = db.prepare('SELECT stats_ok FROM accounts WHERE id = 2').get().stats_ok;
ok(a1 === 1 && a2 === 0 && r.flickr_1 === 4, `Pro account: Flickr stats collected (4 days per run); free account: marked not available (${JSON.stringify(r)})`);
for (let i = 0; i < 8; i++) await statsTick(env, await getSettings(env));
ok(db.prepare('SELECT COUNT(*) n FROM flickr_daily WHERE account_id = 1').get().n === 28, 'backfills Flickr’s 28 days, then stops');
calls = [];
await statsTick(env, await getSettings(env));
ok(!calls.length, 'nothing more to fetch today; the free account isn’t asked again for a week');

const o = await J('/stats/overview?period=30');
ok(o.totals.views === 10000 + 50 + 2500 + 500 + 900 + 300 && o.totals.faves === 100 + 85 + 2 + 10 + 30, `totals (${o.totals.views} views)`);
ok(o.dailySource === 'flickr' && o.daily.length >= 28 && o.inPeriod.views === 120 * 29 - 120 || o.inPeriod.views > 0, `daily views from Flickr stats (${o.inPeriod.views} in period)`);
ok(o.domains[0].domain === 'flickr.com' && o.domains[1].domain === 'google.com', 'where views come from');
ok(o.inPeriod.faves === 5, `faves gained in the period from our own snapshots (${o.inPeriod.faves})`);
const o2 = await J('/stats/overview?period=30&account=2');
ok(o2.totals.photos === 1 && o2.dailySource === 'snapshots' && o2.daily.at(-1).views === 0 && o2.daily[0].views === 100, `free account: daily gains from our own snapshots (${JSON.stringify(o2.daily)})`);

const mv = await J('/stats/movers?period=30&by=views');
ok(mv.photos.map(p => p.id + ':' + p.gain).join() === '2:500,4:100,1:50', `rising: gained views (${mv.photos.map(p => p.id + ':' + p.gain)})`);
db.prepare("INSERT INTO ig_media (id, post_id, like_count, seen_at, deleted, position) VALUES ('77', '77', 321, 1, 0, 0)").run();
db.prepare("INSERT INTO ig_links (ig_id, photo_id, status) VALUES ('77', '2', 'confirmed')").run();
db.prepare("INSERT INTO getty_assets (asset_id, photo_id) VALUES ('900', '2')").run();
db.prepare("INSERT INTO getty_sales (royalty_month, asset_id, royalty) VALUES ('2025-01', '900', 10), ('2025-02', '900', 12)").run();
const ld = await J('/stats/leaders?sort=rate');
const p2 = ld.photos.find(p => p.id === '2');
ok(ld.photos[0].id === '5' && p2.ig === 321 && p2.getty === 2 && ld.photos.every(p => p.views >= 300), `leaders by fave rate (300+ views only), with Instagram likes and Getty sales (${ld.photos.map(p => p.id)})`);
const bd = await J('/stats/breakdown?by=year');
ok(bd.rows.map(x => x.k).join() === '2019,2015' && bd.rows[1].n === 2, 'what works: by year taken');
ok((await J('/stats/breakdown?by=camera')).rows.length === 0 && (await J('/stats/breakdown?by=shape')).rows[0].k === 'Horizontal', 'groups under 5 photos are hidden; by shape');
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
