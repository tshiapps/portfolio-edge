// Instagram: token paste + sync (carousels → one row per slide), weekly token refresh, the Mac matcher's
// input/results (via upload token), review decisions that survive re-matching, photo detail link.
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
  BUCKET: { async get(k) { return k === 't/101.webp' ? { body: new Uint8Array([1, 2, 3]), httpMetadata: { contentType: 'image/webp' } } : null; } },
  ASSETS: { fetch: async () => new Response('x') },
};
// fake Instagram Graph API
const TOKEN = 'IGAA' + 'x'.repeat(60);
let posts = [
  { id: '9001', media_url: 'https://scontent.cdninstagram.com/9001.jpg', media_type: 'IMAGE', media_product_type: 'FEED', permalink: 'https://www.instagram.com/p/AAA/', caption: 'Bay Bridge', timestamp: '2024-05-01T10:00:00+0000', like_count: 120, comments_count: 4 },
  { id: '9002', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED', permalink: 'https://www.instagram.com/p/BBB/', caption: 'NYC', timestamp: '2024-06-01T10:00:00+0000', like_count: 300, comments_count: 9,
    children: { data: [{ id: '9101', media_type: 'IMAGE' }, { id: '9102', media_type: 'IMAGE' }] } },
  { id: '9003', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/CCC/', timestamp: '2024-07-01T10:00:00+0000', like_count: 50, comments_count: 1 },
];
let refreshed = 0, fbMedia = null;
const FBUSER = 'EAAuser' + 'u'.repeat(60), FBPAGE = 'EAApage' + 'p'.repeat(60);
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const url = new URL(typeof u === 'object' && u.url ? u.url : String(u));
  if (url.host === 'graph.facebook.com') { // Facebook-login flavour: user token → Page token → IG user id
    const t = url.searchParams.get('access_token');
    if (t !== FBUSER && t !== FBPAGE) return Response.json({ error: { message: 'Invalid OAuth access token', code: 190 } }, { status: 400 });
    if (url.pathname.endsWith('/me/accounts')) return t === FBUSER ? Response.json({ data: [{ name: 'Other Page' }, { name: 'Tony Shi Photo', access_token: FBPAGE, instagram_business_account: { id: '17841999', username: 'tonyshiphoto', media_count: 3 } }] }) : Response.json({ error: { message: 'no', code: 100 } }, { status: 400 });
    if (url.pathname.endsWith('/17841999/media')) { fbMedia = t; return Response.json({ data: posts }); }
    const id = url.pathname.split('/').pop();
    return Response.json({ media_type: 'IMAGE', media_url: `https://scontent.cdninstagram.com/${id}.jpg` });
  }
  if (url.host === 'graph.instagram.com') {
    if (url.searchParams.get('access_token') !== TOKEN && !url.pathname.includes('refresh')) return Response.json({ error: { message: 'Invalid OAuth access token', code: 190 } }, { status: 400 });
    if (url.pathname.endsWith('/me')) return Response.json({ user_id: '17841', username: 'tonyshiphoto', account_type: 'BUSINESS', media_count: 3 });
    if (url.pathname.endsWith('/me/media')) {
      if (!url.searchParams.get('after')) return Response.json({ data: posts.slice(0, 2), paging: { next: `https://graph.instagram.com/v23.0/me/media?access_token=${TOKEN}&after=p2` } });
      return Response.json({ data: posts.slice(2) });
    }
    if (url.pathname.includes('refresh_access_token')) { refreshed++; return Response.json({ access_token: TOKEN, expires_in: 5184000 }); }
    const id = url.pathname.split('/').pop();
    return Response.json({ media_type: 'IMAGE', media_url: `https://scontent.cdninstagram.com/${id}.jpg` });
  }
  if (url.host === 'scontent.cdninstagram.com') return new Response(new Uint8Array([0xff, 0xd8, 9]), { headers: { 'content-type': 'image/jpeg' } });
  return realFetch(u, init);
};
globalThis.caches = { default: { match: async () => null, put: async () => {} } };
const { default: w } = await import(root + '/src/index.js');
const { createToken } = await import(root + '/src/lib/tokens.js');
const ok = (c, m) => { console.log((c ? 'ok  - ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };
const go = (p, init = {}, auth = 'Basic ' + btoa('admin:pw')) => w.fetch(new Request('https://x' + p, { ...init, headers: { authorization: auth, 'content-type': 'application/json', ...(init.headers || {}) } }), env, { waitUntil() {} });
const J = async (p, body, auth) => (await go('/api/admin' + p, { method: body ? 'POST' : 'GET', body: body && JSON.stringify(body) }, auth)).json();

db.prepare("INSERT INTO accounts (nsid, token_enc, token_secret_enc) VALUES ('1@N1','x','y')").run();
for (const id of ['101', '102', '103']) db.prepare("INSERT INTO photos (id, account_id, title, status, is_public, synced_at) VALUES (?, 1, ?, 'ok', 1, 5)").run(id, 'p' + id);
db.prepare("INSERT INTO photos (id, account_id, title, status, is_public) VALUES ('199', 1, 'private', 'ok', 0)").run();

const bad = await go('/api/admin/ig/token', { method: 'POST', body: JSON.stringify({ token: 'IGAA' + 'y'.repeat(60) }) });
ok(bad.status === 401, 'a wrong token is refused with a clear message');
const con = await J('/ig/token', { token: TOKEN });
ok(con.username === 'tonyshiphoto' && con.synced.posts === 3 && con.synced.rows === 4, `connect + first sync: 3 posts → 4 images (carousel slides split) (${JSON.stringify(con.synced)})`);
const st = await J('/ig/status');
ok(st.connected && st.counts.images === 4 && st.counts.posts === 3 && st.counts.unchecked === 4, 'status counts');
ok(db.prepare("SELECT post_id, position FROM ig_media WHERE id = '9102'").get().post_id === '9002', 'carousel slide remembers its post and position');

// the Mac matcher (upload token)
const tok = 'Bearer ' + await createToken(env, 'studio', 'media');
const inp = await J('/media/ig/input', null, tok);
ok(inp.photos.length === 3 && inp.ig.length === 4, 'matcher input: public photos + Instagram images (private photos left out)');
ok(inp.ig.find(x => x.id === '9001').media_url === 'https://scontent.cdninstagram.com/9001.jpg', 'input carries the CDN link from the last sync (no extra API call per image)');
const img = await go('/api/admin/media/ig/img/9101', {}, tok);
ok(img.status === 200 && img.headers.get('content-type') === 'image/jpeg', 'matcher gets a fresh Instagram image through the site');
ok((await go('/api/admin/media/ig/photo/101', {}, tok)).status === 200, 'matcher gets the site photo');
ok((await go('/api/admin/ig/status', {}, tok)).status === 403, 'upload token cannot use the browser-only parts');
const res = await J('/media/ig/results', { results: [
  { ig_id: '9001', candidates: [{ photo_id: '101', score: 0.98, cos: 0.93, inliers: 140, status: 'auto' }] },
  { ig_id: '9101', candidates: [{ photo_id: '102', score: 0.6, cos: 0.82, inliers: 18, status: 'review' }, { photo_id: '103', score: 0.4, cos: 0.8, inliers: 9, status: 'review' }] },
  { ig_id: '9102', candidates: [] }, { ig_id: '9003', candidates: [] },
] }, tok);
ok(res.saved === 4, 'results saved');
let s2 = await J('/ig/status');
ok(s2.counts.auto === 1 && s2.counts.review === 1 && s2.counts.unmatched === 2 && s2.photosLinked === 1, `after matching: 1 auto, 1 to review, 2 unmatched (${JSON.stringify(s2.counts)})`);
const rv = await J('/ig/list?view=review');
ok(rv.items.length === 1 && rv.items[0].candidates.length === 2 && rv.items[0].candidates[0].photo_id === '102', 'review list shows the candidates, best first');

// you decide; a re-run of the matcher doesn't undo it
await J('/ig/decide', { ig_id: '9101', photo_id: '103', action: 'confirm' });
await J('/media/ig/results', { results: [{ ig_id: '9101', candidates: [{ photo_id: '102', score: 0.7, status: 'auto' }] }] }, tok);
ok(db.prepare("SELECT photo_id FROM ig_links WHERE ig_id = '9101' AND status IN ('confirmed','auto')").all().map(r => r.photo_id).join() === '103', 'your confirmation wins over a later automatic guess');
await J('/ig/decide', { ig_id: '9001', photo_id: '101', action: 'reject' });
ok((await J('/ig/status')).photosLinked === 1, 'rejecting an automatic match unlinks it');
const det = await J('/photos/103');
ok(det.instagram?.[0]?.permalink === 'https://www.instagram.com/p/BBB/' && det.instagram[0].like_count === 300, 'photo details show its Instagram post with likes');

// a deleted post drops out; token refresh after a week
posts = posts.slice(0, 2);
await J('/ig/sync', {});
ok(db.prepare("SELECT deleted FROM ig_media WHERE id = '9003'").get().deleted === 1, 'post removed from Instagram → marked deleted');
db.prepare("UPDATE settings SET value = ? WHERE key = 'ig_token_at'").run(String(Math.floor(Date.now() / 1000) - 8 * 86400));
const { igTick } = await import(root + '/src/lib/instagram.js');
const { getSettings } = await import(root + '/src/lib/settings.js');
await igTick(env, await getSettings(env));
ok(refreshed === 1, 'token refreshed automatically after a week');

// manual link from "Not on the site": any site photo, not just a candidate
await J('/ig/decide', { ig_id: '9102', action: 'confirm', photo_id: '101' });
ok(db.prepare("SELECT status FROM ig_links WHERE ig_id = '9102' AND photo_id = '101'").get()?.status === 'confirmed', 'manually linking an unmatched image to any photo');
ok((await go('/api/admin/ig/decide', { method: 'POST', body: JSON.stringify({ ig_id: '9102', action: 'confirm', photo_id: '999' }) })).status === 404, 'linking to a photo that isn’t on the site is refused');

// Facebook-login token (new Meta apps): user token → the linked Page's token, media via graph.facebook.com
posts = posts.concat([{ id: '9004', media_type: 'IMAGE', media_url: 'https://scontent.cdninstagram.com/9004.jpg', permalink: 'https://www.instagram.com/p/DDD/', timestamp: '2024-08-01T10:00:00+0000' }]);
const fb = await J('/ig/token', { token: FBUSER });
ok(fb.username === 'tonyshiphoto' && fbMedia === FBPAGE && fb.synced.posts === 3, `EAA user token: finds the Page’s Instagram account and syncs with the Page token (${JSON.stringify(fb.synced)})`);
ok(db.prepare("SELECT deleted FROM ig_media WHERE id = '9004'").get()?.deleted === 0, 'new post arrives via the Facebook API');
ok((await go('/api/admin/media/ig/img/9004', {}, tok)).status === 200, 'image proxy works on the Facebook API too');
db.prepare("UPDATE settings SET value = ? WHERE key = 'ig_token_at'").run(String(Math.floor(Date.now() / 1000) - 8 * 86400));
await igTick(env, await getSettings(env));
ok(refreshed === 1, 'Facebook-side (Page) token is not put through the Instagram refresh');
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
