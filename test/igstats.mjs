// Instagram stats: daily follower + per-post snapshots (only changed posts), kinds, hashtags, best time, rising, post-next.
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
const { igSnapshot } = await import(root + '/src/lib/igstats.js');
const { default: w } = await import(root + '/src/index.js');
const ok = (c, m) => { console.log((c ? 'ok  - ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };
const J = async p => (await w.fetch(new Request('https://x/api/admin' + p, { headers: { authorization: 'Basic ' + btoa('admin:pw') } }), env, { waitUntil() {} })).json();
const day = n => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
const set = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v);

let followers = 1000;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const url = new URL(typeof u === 'object' && u.url ? u.url : String(u));
  if (url.host === 'graph.facebook.com' && url.pathname.endsWith('/17841')) return Response.json({ id: '17841', username: 'tonyshiphoto', followers_count: followers, follows_count: 50, media_count: 12 });
  return realFetch(u, init);
};
set('ig_api', 'fb'); set('ig_user_id', '17841'); set('ig_token', await seal(env, 'EAAtoken'));

// 12 posts: 10 singles (Tuesdays 6pm UTC, one per week), a carousel of 3, and a reel; #nyc on 4 of them
const now = Math.floor(Date.now() / 1000), wk = 7 * 86400;
const tue = (() => { const t = new Date(); t.setUTCHours(18, 30, 0, 0); while (t.getUTCDay() !== 2 || t.getTime() / 1000 > now) t.setUTCDate(t.getUTCDate() - 1); return Math.floor(t.getTime() / 1000); })();
const add = (id, post, pos, ts, likes, o = {}) => db.prepare(`INSERT INTO ig_media (id, post_id, position, media_type, product_type, permalink, caption, ts, like_count, comments_count, seen_at, deleted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`).run(id, post, pos, o.type || 'IMAGE', o.product || 'FEED', 'https://instagram.com/p/' + post, o.caption || '', ts, likes, o.c ?? 2);
for (let i = 0; i < 10; i++) add('s' + i, 's' + i, 0, tue - i * wk, 100 + i, { caption: i < 4 ? 'Night #NYC #city' : 'quiet #city' });
for (let j = 0; j < 3; j++) add('c' + j, 'c0', j, now - 2 * 86400, 400, { caption: 'Carousel #nyc #city' });
add('r0', 'r0', 0, now - 3 * 86400, 50, { type: 'VIDEO', product: 'REELS', caption: 'reel #city' });

// site photos: 1 linked to a post, 2 never on Instagram (one rated 1★, one queued for posting, one good)
const photo = (id, views, faves, o = {}) => db.prepare(`INSERT INTO photos (id, account_id, title, status, is_public, hidden, media, views, faves, thumb_w, thumb_h, rating, synced_at)
  VALUES (?, 1, ?, 'ok', 1, 0, 'photo', ?, ?, 1024, 683, ?, 1)`).run(id, 'P' + id, views, faves, o.rating ?? 0);
photo('p1', 5000, 90); photo('p2', 3000, 120); photo('p3', 4000, 200, { rating: 1 }); photo('p4', 2000, 80); photo('p5', 50, 40);
db.prepare("INSERT INTO ig_links (ig_id, photo_id, status) VALUES ('c1', 'p1', 'confirmed')").run();
db.prepare("INSERT INTO ig_posts (photo_id, status, created_at) VALUES ('p4', 'queued', 1)").run();

ok((await igSnapshot(env, day(-2))).posts === 12, 'first snapshot records every post once (carousel slides count as one post)');
db.prepare("UPDATE ig_media SET like_count = like_count + 30 WHERE post_id = 's0'").run();
db.prepare("UPDATE ig_media SET like_count = like_count + 5 WHERE post_id = 'c0'").run();
followers = 1040;
const s2 = await igSnapshot(env, day(-1));
ok(s2.posts === 2 && s2.followers === 1040, `next day: only the 2 posts whose numbers changed are written (${JSON.stringify(s2)})`);
ok(db.prepare('SELECT COUNT(*) n FROM ig_daily').get().n === 2, 'followers recorded per day');

const d = await J('/stats/instagram?period=30&tz=UTC');
ok(d.followers === 1040 && d.followersGain === 40, `followers + gain (${d.followers}, ${d.followersGain})`);
ok(d.totals.posts === 12 && d.totals.linked === 1, `totals: 12 posts, 1 linked (${JSON.stringify(d.totals)})`);
const kinds = Object.fromEntries(d.kinds.map(k => [k.k, k]));
ok(kinds['Carousel']?.n === 1 && kinds['Reel / video']?.n === 1 && kinds['Single photo']?.n === 10 && kinds['Carousel'].avgLikes === 405, `kinds of post (${d.kinds.map(k => k.k + ':' + k.n)})`);
const tags = Object.fromEntries(d.hashtags.map(t => [t.k, t]));
ok(tags['#nyc']?.n === 5 && tags['#city']?.n === 12 && !tags['#night'], `hashtags, case-insensitive, 3+ posts (${d.hashtags.map(t => t.k + ':' + t.n)})`);
ok(d.rising[0]?.id === 's0' && d.rising[0].gain === 30 && d.rising.some(p => p.id === 'c0' && p.gain === 5), `rising: likes gained (${d.rising.map(p => p.id + ':' + p.gain)})`);
ok(d.next.map(p => p.id).join() === 'p2', `post next: skips linked, 1★, queued and barely-seen photos (${d.next.map(p => p.id)})`);
const tue6 = d.heat.find(c => c.d === 1 && c.h === 6);
ok(tue6 && tue6.n >= 9, `best time: Tuesday 6–9pm UTC block holds the weekly posts (${JSON.stringify(tue6)})`);
ok(d.timeline.length === 12 && d.timeline.at(-1).ts >= d.timeline[0].ts, 'timeline oldest → newest');
ok(d.recent.rate > 0 && d.top.find(p => p.id === 'c0').photo_id === 'p1', 'engagement rate; top posts carry the linked site photo');
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
