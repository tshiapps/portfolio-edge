// Album builder: nested folders, top-N rules (Flickr / Getty), and/or/not tags, common tag of sub-folders,
// automatic place sub-folders, public tree + folder pages.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const db = new DatabaseSync(':memory:');
for (const f of readdirSync(root + '/migrations').sort()) db.exec(readFileSync(root + '/migrations/' + f, 'utf8'));
const norm = a => a.map(v => (v === undefined ? null : v));
class S { constructor(q, a = []) { this.q = q; this.a = a; } bind(...a) { return new S(this.q, a); }
  async run() { const r = /returning/i.test(this.q) ? { changes: db.prepare(this.q).all(...norm(this.a)).length } : db.prepare(this.q).run(...norm(this.a)); return { meta: { changes: Number(r.changes) } }; }
  async all() { return { results: db.prepare(this.q).all(...norm(this.a)).map(r => ({ ...r })) }; }
  async first() { const r = db.prepare(this.q).get(...norm(this.a)); return r ? { ...r } : null; } }
const env = { DB: { prepare: q => new S(q), async batch(st) { for (const x of st) await x.run(); } }, ADMIN_PASSWORD: 'pw', ENCRYPTION_KEY: 'k', ASSETS: { fetch: async () => new Response('page') } };
globalThis.caches = { default: { match: async () => null, put: async () => {} } };
const { default: w } = await import(root + '/src/index.js');
const call = async (p, body, method) => { const r = await w.fetch(new Request('https://x/api/admin' + p, { method: method || (body ? 'POST' : 'GET'), headers: { authorization: 'Basic ' + btoa('admin:pw'), 'content-type': 'application/json' }, body: body && JSON.stringify(body) }), env, {}); return { status: r.status, ...(await r.json()) }; };
const pub = async p => (await w.fetch(new Request('https://x' + p), env, { waitUntil() {} })).json();
const ok = (c, m) => { console.log((c ? 'ok  - ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };

db.prepare("INSERT INTO accounts (nsid, token_enc, token_secret_enc) VALUES ('1@N1','x','y')").run();
const tag = (slug, label, kind, parent) => db.prepare('INSERT INTO site_tags (slug, label, kind, parent_id) VALUES (?, ?, ?, (SELECT id FROM site_tags WHERE slug = ?)) ON CONFLICT(slug) DO NOTHING').run(slug, label, kind, parent ?? null);
tag('usa', 'United States', 'location'); tag('newyorkstate', 'New York State', 'location', 'usa'); tag('newyorkcity', 'New York City', 'location', 'newyorkstate');
tag('california', 'California', 'location', 'usa'); tag('sanfrancisco', 'San Francisco', 'location', 'california'); tag('night', 'Night', 'content');
const photo = (id, score, tags) => {
  db.prepare("INSERT INTO photos (id, account_id, title, status, is_public, hidden, media, thumb_w, thumb_h, pop_score, date_upload) VALUES (?, 1, ?, 'ok', 1, 0, 'photo', 600, 400, ?, ?)").run(id, 'p' + id, score, +id);
  const all = new Set();
  for (const s of tags) for (let t = db.prepare('SELECT id, parent_id FROM site_tags WHERE slug = ?').get(s); t; t = t.parent_id ? db.prepare('SELECT id, parent_id FROM site_tags WHERE id = ?').get(t.parent_id) : null) all.add(t.id);
  for (const t of all) db.prepare("INSERT INTO photo_tags (photo_id, tag_id, source) VALUES (?, ?, 'ai')").run(id, t);
};
photo('101', 9, ['city', 'newyorkcity']); photo('102', 8, ['city', 'newyorkcity', 'night']); photo('103', 7, ['city', 'newyorkcity']);
photo('104', 6, ['city', 'sanfrancisco']); photo('105', 5, ['city', 'sanfrancisco']); photo('106', 4, ['nature', 'california']);
photo('107', 3, ['nature']); photo('108', 2, ['underwater']); photo('109', 1, ['city', 'sanfrancisco', 'night']); photo('52759839641', 0, ['underwater']); photo('110', 0.5, ['nature']); photo('111', 0.2, []);
db.prepare('UPDATE photos SET thumb_w = 1600, thumb_h = 400 WHERE id IN (?, ?)').run('110', '111'); db.prepare('UPDATE photos SET thumb_w = 400, thumb_h = 600 WHERE id = ?').run('107');
// Getty: 105 sold most (file name carries the Flickr ID), 103 linked by hand
const sale = (asset, alt, n) => { for (let i = 0; i < n; i++) db.prepare("INSERT INTO getty_sales (royalty_month, asset_id, alt_name, royalty) VALUES ('2025-01', ?, ?, 1)").run(asset, alt); };
sale('g1', '52759839641_abcdef1234_o.jpg', 5); sale('g2', 'DSC_1.jpg', 2); sale('g3', 'whatever.tif', 1);
db.prepare("INSERT INTO getty_assets (asset_id, linked_photo_id) VALUES ('g2', '103')").run();

const L = (await call('/folders', { title: 'Landscape' })).folder;
const C = (await call('/folders', { title: 'City', parent_id: L.id, rules: [{ tags: ['city'], top: 2 }] })).folder;
const N = (await call('/folders', { title: 'Nature', parent_id: L.id, rules: [{ tags: ['nature'], top: 10 }] })).folder;
ok(C.slug === 'city' && C.parent_id === L.id, 'nested folder created with URL name');

const list = await call('/folders');
ok(JSON.stringify(list.folders.find(f => f.id === L.id).common.tags) === '["landscape"]', 'parent without rules uses the tag its sub-folders share (Landscape)');
let pv = await call('/folders/preview', { id: L.id, parent_id: null, rules: [] });
ok(pv.photos.map(p => p.id).join() === '101,102,103,104,105,106,107,109,110', `Landscape shows top of “landscape”, Flickr order: ${pv.photos.map(p => p.id)}`);

pv = await call('/folders/preview', { id: C.id, parent_id: L.id, rules: [{ tags: ['city'], top: 2 }] });
ok(pv.photos.map(p => p.id).join() === '101,102' && pv.fits === 6, `top 2 by Flickr: ${pv.photos.map(p => p.id)} (of ${pv.fits})`);
pv = await call('/folders/preview', { id: C.id, parent_id: null, within_parent: false, rules: [{ tags: [], top: 2, rank: 'getty' }] });
ok(pv.photos.map(p => p.id).join() === '52759839641,103' && pv.photos[0].getty === 5, `top 2 by Getty sales (file name + manual link): ${pv.photos.map(p => p.id)}`);
pv = await call('/folders/preview', { id: C.id, parent_id: L.id, rules: [{ tags: ['newyorkcity', 'night'], match: 'all', top: 10 }] });
ok(pv.photos.map(p => p.id).join() === '102', 'AND: New York City + Night');
pv = await call('/folders/preview', { id: C.id, parent_id: L.id, rules: [{ tags: ['sanfrancisco', 'night'], match: 'any', exclude: ['newyorkcity'], top: 10 }] });
ok(pv.photos.map(p => p.id).join() === '104,105,109', `OR + NOT: SF or Night, not NYC: ${pv.photos.map(p => p.id)}`);
pv = await call('/folders/preview', { id: C.id, parent_id: L.id, rules: [{ tags: ['newyorkcity'], top: 1 }, { tags: ['night'], top: 5 }] });
ok(pv.photos.map(p => p.id).join() === '101,102,109', `rules add up, no repeats: ${pv.photos.map(p => p.id)}`);
pv = await call('/folders/preview', { id: N.id, parent_id: C.id, rules: [{ tags: [], top: 50 }] });
ok(pv.photos.length === 6 && pv.photos.every(p => +p.id >= 101 && +p.id <= 109 && !['106', '107', '108'].includes(p.id)), 'within parent: “every photo” inside City = only city photos');
pv = await call('/folders/preview', { id: N.id, parent_id: C.id, within_parent: false, rules: [{ tags: [], top: 50 }] });
ok(pv.photos.length === 12, 'without “within parent” it takes everything');
pv = await call('/folders/preview', { id: N.id, parent_id: null, within_parent: false, rules: [{ tags: [], shape: 'pano', top: 20 }] });
ok(pv.photos.map(p => p.id).join() === '110,111', `shape only: top panoramas, no tags needed (${pv.photos.map(p => p.id)})`);
pv = await call('/folders/preview', { id: N.id, parent_id: null, within_parent: false, rules: [{ tags: ['nature'], shape: 'pano', top: 20 }] });
ok(pv.photos.map(p => p.id).join() === '110', 'shape + tag: Nature panoramas');
pv = await call('/folders/preview', { id: N.id, parent_id: null, within_parent: false, rules: [{ tags: ['nature'], shape: 'vertical', top: 20 }] });
ok(pv.photos.map(p => p.id).join() === '107', 'vertical photos');

await call('/folders/' + C.id, { auto: { by: 'city', top: 5, min: 2 } }, 'PATCH');
pv = await call('/folders/preview', { id: C.id, parent_id: L.id, rules: [{ tags: ['city'], top: 2 }], auto: { by: 'city', top: 5, min: 2 } });
ok(pv.places.map(p => `${p.slug}:${p.n}`).join() === 'newyorkcity:3,sanfrancisco:3', `automatic sub-folder per city: ${pv.places.map(p => p.slug + ':' + p.n)}`);

const tree = await pub('/api/folders');
const lt = tree.folders[0];
ok(lt.path === 'landscape' && lt.children.map(c => c.path).join() === 'landscape/city,landscape/nature', 'public tree nests folders');
ok(lt.children[0].children.map(c => c.path).join() === 'landscape/city/newyorkcity,landscape/city/sanfrancisco', 'cities appear under City');
const page = await pub('/api/folder?path=landscape/city/sanfrancisco');
ok(page.title === 'San Francisco' && page.photos.map(p => p.id).join() === '104,105,109' && page.crumbs.map(c => c.title).join(' › ') === 'Landscape › City › San Francisco', `city page: ${page.photos?.map(p => p.id)}`);
ok(!('getty' in page.photos[0]) && !('score' in page.photos[0]) && !JSON.stringify(page).includes('"sales"'), 'public page carries no Getty / score numbers');
const tree2 = await pub('/api/folder?path=landscape/city/newyorkcity');
ok(tree2.photos.find(p => p.id === '103')?.gid === 'g2' && !tree2.photos.find(p => p.id === '101').gid, 'photos licensed on Getty carry their Getty asset id (for the link)');
const cityPage = await pub('/api/folder?path=landscape/city');
ok(cityPage.children.map(c => c.title).join() === 'New York City,San Francisco' && cityPage.photos.length === 2, 'folder page lists its sub-folders');
ok(cityPage.display === 'popular', 'folders are ranked by popularity unless set to shuffle');
await call('/folders/' + C.id, { display: 'random' }, 'PATCH');
ok((await pub('/api/folder?path=landscape/city')).display === 'random' && (await pub('/api/folder?path=landscape/city/sanfrancisco')).display === 'random', 'shuffle setting reaches the site (and its city sub-folders)');
ok((await pub('/api/folder?path=landscape/nope')).error, 'unknown folder → not found');
// a tag change moves the cache key, so folder pages never show a photo you just untagged
const { treeVersion } = await import(root + '/src/lib/folders.js');
const v1 = await treeVersion(env);
await call('/photos/bulk', { ids: ['104'], removeTags: ['sanfrancisco'] });
const v2 = await treeVersion(env);
ok(v1 !== v2 && !(await pub('/api/folder?path=landscape/city/sanfrancisco')).photos.some(p => p.id === '104'), 'removing a tag changes the cache key and drops the photo');
const hdr = (await w.fetch(new Request('https://x/api/folders'), env, { waitUntil() {} })).headers.get('cache-control');
ok(hdr === 'no-cache', `browsers re-check folder data every time (${hdr})`);
const html = await w.fetch(new Request('https://x/photos/landscape/city'), env, {});
ok(await html.text() === 'page', '/photos/<folder> serves the photos page');

ok((await call('/folders/' + L.id, { parent_id: C.id }, 'PATCH')).status === 400, 'can’t put a folder inside its own sub-folder');
await call(`/folders/${N.id}/move`, { dir: -1 });
ok((await pub('/api/folders')).folders[0].children[0].slug === 'nature', 'reorder sub-folders');
await call('/folders/' + C.id, { hidden: true }, 'PATCH');
ok((await pub('/api/folders')).folders[0].children.length === 1, 'hidden folders stay off the site');
await call('/folders/' + L.id, null, 'DELETE');
const after = (await call('/folders')).folders;
ok(after.length === 2 && after.every(f => f.parent_id === null), 'deleting a folder moves its sub-folders up');

// two stored sizes: photos in folders (showcase) keep the big size, the rest are shrunk to the base size
const { refreshShowcase, shrinkLoop, sizeStatus } = await import(root + '/src/lib/showcase.js');
const N2 = (await call('/folders', { title: 'NYC', rules: [{ tags: ['newyorkcity'], top: 2 }] })).folder;
db.prepare("UPDATE photos SET status = 'ok', width = 2048, height = 1365, o_width = 6000, o_height = 4000").run();
db.prepare("UPDATE photos SET width = 3840, height = 2560 WHERE id = '111'").run(); // was upgraded earlier, isn't in any folder
db.prepare("UPDATE photos SET refetch = 1 WHERE id = '108'").run();               // left over from "upgrade everything"
const S0 = { long_edge: '3840', base_edge: '2048', pano_ratio: '2.2', front_mode: 'weekly', quality: '75' };
await refreshShowcase(env, S0, { force: true });
const shows = db.prepare('SELECT id FROM photos WHERE showcase = 1 ORDER BY id').all().map(r => r.id);
ok(shows.includes('101') && shows.includes('102') && !shows.includes('111'), `folder photos are showcase (${shows.length})`);
ok(db.prepare("SELECT refetch FROM photos WHERE id = '101'").get().refetch === 1, 'a showcase photo stored small is queued for the Mac app (big size)');
ok(db.prepare("SELECT refetch FROM photos WHERE id = '108'").get().refetch === 0, 'the old "upgrade everything" queue is cancelled for non-showcase photos');
// a free (non-Pro) account / photo whose biggest Flickr size is what we already have: not queued again and again
db.prepare("UPDATE photos SET refetch = 0, width = 1024, height = 683, best_edge = 1024, best_at = ? WHERE id = '102'").run(Math.floor(Date.now() / 1000));
await refreshShowcase(env, S0, { force: true });
ok(db.prepare("SELECT refetch FROM photos WHERE id = '102'").get().refetch === 0, 'showcase photo already at the biggest size Flickr gives us is NOT re-queued (no endless loop)');
db.prepare("UPDATE photos SET best_at = ? WHERE id = '102'").run(Math.floor(Date.now() / 1000) - 31 * 86400);
await refreshShowcase(env, S0, { force: true });
ok(db.prepare("SELECT refetch FROM photos WHERE id = '102'").get().refetch === 1, '…but tried again after 30 days (e.g. the account went Pro)');
db.prepare("UPDATE photos SET refetch = 0, width = 2048, height = 1365, best_edge = NULL, best_at = NULL WHERE id = '102'").run();
const r2s = new Map([['m/111.jpg', { body: 'x'.repeat(10) }]]);
env.BUCKET = { get: async k => r2s.get(k) ? { body: new Blob(['x']).stream(), customMetadata: {} } : null, put: async (k, b) => { r2s.set(k, { body: b }); } };
env.IMAGES = { input: () => ({ transform: o => ({ output: async () => ({ response: () => new Response(new Uint8Array(500)) }) }) }), info: async () => ({ width: 2048, height: 1365 }) };
const sum = {};
await shrinkLoop(env, S0, Date.now() + 60000, sum);
ok(sum.shrunk === 1 && db.prepare("SELECT width FROM photos WHERE id = '111'").get().width === 2048, 'a non-showcase photo stored big is shrunk from R2 (no Flickr download)');
const stz = await sizeStatus(env, S0);
ok(stz.showcase >= 2 && stz.waiting_mac >= 1 && stz.to_shrink === 0, `size status (${JSON.stringify(stz)})`);
await call('/folders/' + N2.id, null, 'DELETE');

// per-account sizes: e.g. fine-art account at 4K for everything, quality 75
db.prepare("UPDATE photos SET refetch = 0, lease_until = NULL, width = 2048, height = 1365, bytes = 600000, thumb_bytes = 90000").run();
db.prepare("INSERT INTO settings (key, value) VALUES ('base_edge', '2048') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
const est = await call('/accounts/1/sizes?long=3840&base=3840&q=75');
ok(est.estimate.photos > 5 && est.estimate.bytes > est.estimate.now, `storage estimate at 4K is bigger than today (${(est.estimate.bytes / 1e6).toFixed(1)} vs ${(est.estimate.now / 1e6).toFixed(1)} MB)`);
const est2 = await call('/accounts/1/sizes?long=3000&base=3000&q=65');
ok(est2.estimate.bytes < est.estimate.bytes, 'and 3K at quality 65 estimates smaller');
const sv = await call('/accounts/1/sizes', { long_edge: 3840, base_edge: 3840, quality: 75 });
ok(sv.ok && sv.queued > 5 && db.prepare("SELECT COUNT(*) n FROM photos WHERE refetch = 1").get().n === sv.queued, `saving 4K for the whole account queues its smaller photos for the Mac app (${sv.queued})`);
const { forAccount } = await import(root + '/src/lib/showcase.js');
const { sizeBoxes } = await import(root + '/src/sync/ingest.js');
const acc1 = db.prepare('SELECT * FROM accounts WHERE id = 1').get();
ok(sizeBoxes(forAccount({ long_edge: '3840', base_edge: '2048', pano_ratio: '2.2' }, acc1), 6000, 4000, false).master[0] === 3840, 'new photos of that account are stored at its size');
await call('/accounts/1/sizes', { long_edge: null, base_edge: null, quality: null });
ok(db.prepare("SELECT COUNT(*) n FROM photos WHERE refetch = 1 AND showcase = 0").get().n === 0, 'back to defaults cancels the upgrades (only showcase photos still want the big size)');

// Flickr account filter + your star rating
db.prepare("INSERT INTO accounts (id, nsid, username, token_enc, token_secret_enc) VALUES (2, '2@N1', 'Tony Shi Life', 'x','y')").run();
db.prepare("UPDATE photos SET account_id = 2 WHERE id IN ('102', '104')").run();
pv = await call('/folders/preview', { id: C.id, parent_id: null, within_parent: false, rules: [{ tags: ['city'], top: 10, accounts: [1] }] });
ok(pv.photos.map(p => p.id).join() === '101,103,105,109', `only the chosen Flickr account: ${pv.photos.map(p => p.id)}`);
await call('/photos/bulk', { ids: ['101'], rating: 1 });
await call('/photos/bulk', { ids: ['103'], rating: 2 });
await call('/photos/bulk', { ids: ['105'], rating: 5 });
ok(db.prepare("SELECT rating FROM photos WHERE id = '105'").get().rating === 5, 'rating saved (bulk)');
pv = await call('/folders/preview', { id: C.id, parent_id: null, within_parent: false, rules: [{ tags: ['city'], top: 10, accounts: [1], reject: 1 }] });
ok(pv.photos.map(p => p.id).join() === '103,105,109', `1★ photos left out, unrated kept: ${pv.photos.map(p => p.id)}`);
pv = await call('/folders/preview', { id: C.id, parent_id: null, within_parent: false, rules: [{ tags: ['city'], top: 10, reject: 2 }] });
ok(pv.photos.map(p => p.id).join() === '102,104,105,109', `≤2★ left out, both accounts: ${pv.photos.map(p => p.id)}`);
const saved = await call('/folders', { title: 'Rated', rules: [{ tags: ['city'], top: 5, accounts: [1, 'x', 1], reject: 9 }] });
const sr = (typeof saved.folder.rules === 'string' ? JSON.parse(saved.folder.rules) : saved.folder.rules)[0];
ok(JSON.stringify(sr.accounts) === '[1]' && sr.reject === 4, 'rule values cleaned (accounts deduped, reject capped at 4★)');
const r3 = await call('/photos?rating=2%2B&sort=rating');
ok(r3.photos.map(p => p.id).join() === '105,103', `organizer: “★★ and up”, sorted by rating: ${r3.photos.map(p => p.id)}`);
ok((await call('/photos?rating=unrated')).photos.every(p => !p.rating), 'organizer: not rated');
ok((await call('/folders')).accounts.length === 2, 'album builder gets the account list');

// random pick
const rnd = async () => (await call('/folders/preview', { id: C.id, parent_id: null, within_parent: false, rules: [{ tags: ['city'], top: 3, rank: 'random' }] })).photos.map(p => p.id);
const r1 = await rnd(), r2 = await rnd();
const cityIds = ['101', '102', '103', '104', '105', '109'];
ok(r1.length === 3 && new Set(r1).size === 3 && r1.every(id => cityIds.includes(id)), `random: 3 different photos from the matching ones (${r1})`);
ok(r1.join() === r2.join(), 'random: the same pick all day (cache-friendly), a new one tomorrow');
const svr = await call('/folders', { title: 'Random city', rules: [{ tags: ['city'], top: 4, rank: 'random' }] });
ok((typeof svr.folder.rules === 'string' ? JSON.parse(svr.folder.rules) : svr.folder.rules)[0].rank === 'random', 'random is a valid rule');
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
