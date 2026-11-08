// Posting to Instagram from the Flickr magic tag: tag parsing, caption, held vs queued, the two-step publish,
// the instant link to the photo, the temporary public image, errors and the daily cap.
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
const r2 = new Map();
let transforms = [];
const env = {
  DB: { prepare: q => new S(q), async batch(st) { for (const x of st) await x.run(); } }, ADMIN_PASSWORD: 'pw', ENCRYPTION_KEY: 'k'.repeat(44),
  BUCKET: {
    async get(k) { const v = r2.get(k); return v ? { body: new Blob([v]).stream(), arrayBuffer: async () => v, httpMetadata: {} } : null; },
    async put(k, v) { r2.set(k, new Uint8Array(v)); }, async delete(k) { r2.delete(k); },
  },
  IMAGES: {
    async info() { return { width: 6000, height: 2000 }; }, // a 3:1 panorama
    input() { const o = { transform(t) { transforms.push(t); return o; }, async output() { return { response: () => new Response(new Uint8Array([0xff, 0xd8, 1, 2])) }; } }; return o; },
  },
  ASSETS: { fetch: async () => new Response('x') },
};
const FBUSER = 'EAAuser' + 'u'.repeat(60), FBPAGE = 'EAApage' + 'p'.repeat(60), UID = '17841999';
let calls = [], containerState = 'IN_PROGRESS', denyPublish = false, nextId = 500;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init = {}) => {
  const url = new URL(typeof u === 'object' && u.url ? u.url : String(u));
  if (url.host === 'graph.facebook.com') {
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    const t = url.searchParams.get('access_token') || body.access_token;
    if (t !== FBUSER && t !== FBPAGE) return Response.json({ error: { message: 'Invalid OAuth access token', code: 190 } }, { status: 400 });
    calls.push({ method: init.method || 'GET', path: url.pathname, body });
    if (url.pathname.endsWith('/me/accounts')) return Response.json({ data: [{ name: 'Tony Shi Photo', access_token: FBPAGE, instagram_business_account: { id: UID, username: 'tonyshiphoto', media_count: 0 } }] });
    if (url.pathname.endsWith(`/${UID}/media`) && init.method === 'POST') {
      if (denyPublish) return Response.json({ error: { message: '(#10) Application does not have permission for this action', code: 10 } }, { status: 403 });
      return Response.json({ id: 'c' + (++nextId) });
    }
    if (url.pathname.endsWith(`/${UID}/media`)) return Response.json({ data: [] });
    if (url.pathname.endsWith(`/${UID}/media_publish`)) return Response.json({ id: '9' + (++nextId) });
    const id = url.pathname.split('/').pop();
    if (id.startsWith('c')) return Response.json({ status_code: containerState });
    return Response.json({ id, permalink: `https://www.instagram.com/p/${id}/`, timestamp: '2026-11-06T22:00:00+0000', media_type: 'IMAGE', media_product_type: 'FEED', caption: 'x' });
  }
  return realFetch(u, init);
};
globalThis.caches = { default: { match: async () => null, put: async () => {} } };
const { default: w } = await import(root + '/src/index.js');
const { tagPlan, buildCaption, publishTick } = await import(root + '/src/lib/igpublish.js');
const { getSettings, setSetting } = await import(root + '/src/lib/settings.js');
const ok = (c, m) => { console.log((c ? 'ok  - ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };
const go = (p, init = {}) => w.fetch(new Request('https://tonyshi.photos' + p, { ...init, headers: { authorization: 'Basic ' + btoa('admin:pw'), 'content-type': 'application/json' } }), env, { waitUntil() {} });
const J = async (p, body) => (await go('/api/admin' + p, { method: body ? 'POST' : 'GET', body: body && JSON.stringify(body) })).json();
const tick = async () => publishTick(env, await getSettings(env));
const post = id => db.prepare('SELECT * FROM ig_posts WHERE photo_id = ?').get(id);

// tags and caption
const s0 = await getSettings(env);
const pRaw = { raw_tags: JSON.stringify(['tsp-ig', 'tsp-ig-NewYorkCity', 'tsp-ig-night', 'skyline', 'tsp-ig-newyorkcity']), tags: '', title: 'T', description: 'Manhattan at dusk.<br />Shot from <a href="https://x">Weehawken</a> &amp; edited.' };
const plan = tagPlan(pRaw, s0);
ok(plan.trigger && plan.hashtags.join() === 'NewYorkCity,night', `raw Flickr tags: magic tag found, tsp-ig-xxx → hashtags, duplicates dropped (${plan.hashtags})`);
const pNorm = { raw_tags: null, tags: 'tspig tspignewyorkcity skyline', title: 'Just a title', description: '' };
ok(tagPlan(pNorm, s0).trigger && tagPlan(pNorm, s0).hashtags.join() === 'newyorkcity', 'Flickr’s normalized tags (tspig, tspignewyorkcity) work too');
ok(!tagPlan({ raw_tags: JSON.stringify(['tsp-ig-nyc']), tags: '' }, s0).trigger, 'a hashtag tag alone doesn’t trigger a post');
const cap = buildCaption(pRaw, s0);
ok(cap === 'Manhattan at dusk.\nShot from Weehawken & edited.\n\n#NewYorkCity #night', 'caption: Flickr description as plain text, then the hashtags');
ok(buildCaption(pNorm, s0) === 'Just a title\n\n#newyorkcity', 'no description → the title');

// photos
db.prepare("INSERT INTO accounts (nsid, token_enc, token_secret_enc) VALUES ('1@N1','x','y')").run();
const add = (id, raw, pub = 1) => db.prepare("INSERT INTO photos (id, account_id, title, description, status, is_public, tags, raw_tags, synced_at) VALUES (?, 1, ?, ?, 'ok', ?, ?, ?, 5)")
  .run(id, 'Photo ' + id, 'Caption ' + id, pub, raw.map(t => t.replace(/-/g, '').toLowerCase()).join(' '), JSON.stringify(raw));
add('201', ['tsp-ig', 'tsp-ig-old']);   // tagged before posting was switched on
add('202', ['tsp-ig'], 0);               // private: never
add('203', ['landscape']);               // no magic tag
for (const k of ['201', '205', '206', '207', '208']) r2.set(`m/${k}.jpg`, new Uint8Array([0xff, 0xd8, 0]));

const con = await J('/ig/token', { token: FBUSER });
ok(con.username === 'tonyshiphoto', 'connected via Facebook login');
ok((await tick()) === null, 'nothing happens while posting is off');

let st = await J('/ig/publish/settings', { on: true });
ok(st.settings.on, 'posting switched on');
await tick();
ok(post('201')?.status === 'held' && !post('202') && !post('203'), 'already-tagged photo is held for your OK; private and untagged photos are ignored');

// a newly synced tagged photo → queued → container → published, linked at once
add('205', ['tsp-ig', 'tsp-ig-brooklyn']);
await setSetting(env, 'ig_scan_at', '0');
transforms = []; calls = [];
let out = await tick();
ok(post('205')?.status === 'container' && out.started === '205', `new tagged photo is queued and sent to Instagram (${JSON.stringify(out)})`);
const create = calls.find(c => c.method === 'POST' && c.path.endsWith('/media'));
ok(create.body.caption === 'Caption 205\n\n#brooklyn', 'Instagram gets the Flickr caption + hashtags');
const src = create.body.image_url;
ok(src.startsWith('https://tonyshi.photos/ig-src/') && src.endsWith('.jpg'), 'image comes from a temporary public link on the site');
ok(transforms[0].fit === 'pad' && transforms[0].width === 1440 && transforms[0].height === Math.round(1440 / 1.91), `a panorama is fitted whole into 1.91:1 with white bars (${JSON.stringify(transforms[0])})`);
const srcRes = await w.fetch(new Request(src), env, {});
ok(srcRes.status === 200 && srcRes.headers.get('content-type') === 'image/jpeg', 'the temporary image is publicly downloadable while posting');
ok((await w.fetch(new Request('https://tonyshi.photos/ig-src/' + 'a'.repeat(32) + '.jpg'), env, {})).status === 404, 'unknown image names are 404');

await tick();
ok(post('205').status === 'container', 'waits while Instagram is still processing');
containerState = 'FINISHED';
out = await tick();
const p205 = post('205');
ok(p205.status === 'published' && p205.ig_media_id && p205.permalink, `published (${p205.permalink})`);
ok(db.prepare("SELECT status FROM ig_links WHERE ig_id = ? AND photo_id = '205'").get(p205.ig_media_id)?.status === 'confirmed', 'the new post is linked to the photo straight away (no matching needed)');
ok(db.prepare('SELECT matched_at FROM ig_media WHERE id = ?').get(p205.ig_media_id)?.matched_at > 0, 'and the Instagram image is recorded, marked as checked');
ok((await w.fetch(new Request(src), env, {})).status === 404 && ![...r2.keys()].some(k => k.startsWith('igp/')), 'temporary image removed after posting');
ok((await J('/photos/205')).instagram?.[0]?.permalink === p205.permalink, 'photo details show its Instagram post');

// already on Instagram → skipped; held → you OK it
add('206', ['tsp-ig']);
db.prepare("INSERT INTO ig_media (id, post_id, permalink, seen_at, deleted) VALUES ('777', '777', 'https://www.instagram.com/p/OLD/', 1, 0)").run();
db.prepare("INSERT INTO ig_links (ig_id, photo_id, status) VALUES ('777', '206', 'confirmed')").run();
await setSetting(env, 'ig_scan_at', '0');
await tick();
ok(post('206')?.status === 'skipped' && post('206').permalink === 'https://www.instagram.com/p/OLD/', 'a photo already on Instagram is skipped, not posted twice');
st = await J('/ig/publish/201', { action: 'publish' });
ok(post('201').status === 'queued', '“Post it” queues a held photo');

// permission missing → a clear error, temp image cleaned up
denyPublish = true;
await tick();
ok(post('201').status === 'error' && /instagram_content_publish/.test(post('201').note), `missing publish permission is explained (${post('201').note})`);
ok(![...r2.keys()].some(k => k.startsWith('igp/')), 'no temporary image left behind on failure');
denyPublish = false;

// daily cap
await J('/ig/publish/settings', { daily: 1 });
await J('/ig/publish/201', { action: 'publish' });
out = await tick();
ok(post('201').status === 'queued' && out?.capped, 'daily cap holds the next post back');
await J('/ig/publish/201', { action: 'cancel' });
ok(post('201').status === 'cancelled', '“Don’t post” cancels it');

// tsp-ig-manual: waits for your hand crop, then posts the crop
const pm = tagPlan({ raw_tags: JSON.stringify(['tsp-ig-manual', 'tsp-ig-pano']) }, await getSettings(env));
ok(pm.trigger && pm.manual && pm.hashtags.join() === 'pano', 'tsp-ig-manual triggers a post, waits for a crop, and is not a hashtag');
await J('/ig/publish/settings', { daily: 10 });
add('207', ['tsp-ig-manual', 'tsp-ig-pano']);
await setSetting(env, 'ig_scan_at', '0');
calls = [];
await tick();
ok(post('207')?.status === 'crop' && !calls.some(c => c.method === 'POST'), 'manual photo waits in the crop queue — nothing sent to Instagram');
ok((await go('/api/admin/ig/publish/207', { method: 'POST', body: JSON.stringify({ action: 'crop', crop: { x: 0.9, y: 0, w: 0.5, h: 1 } }) })).status === 400, 'a crop outside the photo is refused');
await J('/ig/publish/207', { action: 'crop', crop: { x: 0.25, y: 0, w: 1 / 3, h: 1 } }); // a square out of the 3:1 panorama
ok(post('207').status === 'queued' && JSON.parse(post('207').crop).w > 0.33, 'saving the crop queues it');
transforms = []; containerState = 'IN_PROGRESS';
await tick();
const tf = transforms[0];
ok(tf.trim && tf.trim.left === 1500 && tf.trim.top === 0 && tf.trim.right === 2500 && tf.trim.bottom === 0 && tf.width === 1440 && tf.height === 1440, `the posted image is your crop, 1440×1440 (${JSON.stringify(tf)})`);
containerState = 'FINISHED';
await tick();
ok(post('207').status === 'published', 'cropped post published');
await J('/ig/publish/settings', { manual: 'handcrop' });
const ph = tagPlan({ raw_tags: JSON.stringify(['tsp-ig-handcrop']) }, await getSettings(env));
ok(ph.trigger && ph.manual && !ph.hashtags.length && !tagPlan({ raw_tags: JSON.stringify(['tsp-ig-manual']) }, await getSettings(env)).manual, 'the manual-crop word is configurable');
ok((await go('/api/admin/ig/publish/settings', { method: 'POST', body: JSON.stringify({ manual: 'two words' }) })).status === 400, 'manual-crop word is validated');

const list = await J('/ig/publish');
ok(list.posts.length === 4 && list.counts.published === 2 && list.posts.find(x => x.photo_id === '201').preview.includes('#old'), 'admin list with caption previews');
const bad = await go('/api/admin/ig/publish/settings', { method: 'POST', body: JSON.stringify({ tag: 'bad tag!' }) });
ok(bad.status === 400, 'magic tag is validated');
await J('/ig/publish/settings', { tag: 'post-to-ig', prefix: 'ig-' });
const s2 = await getSettings(env);
ok(tagPlan({ raw_tags: JSON.stringify(['post-to-ig', 'ig-sunset']) }, s2).hashtags.join() === 'sunset' && tagPlan({ raw_tags: JSON.stringify(['post-to-ig']) }, s2).trigger, 'custom magic tag and prefix');
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
