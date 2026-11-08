// Getty tab: imports every real statement in "Getty data/" through the Worker (SQLite as D1), then checks the report.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const db = new DatabaseSync(':memory:');
for (const f of readdirSync(root + '/migrations').sort()) db.exec(readFileSync(root + '/migrations/' + f, 'utf8'));
const norm = a => a.map(v => (v === undefined ? null : v));
class S { constructor(q, a = []) { this.q = q; this.a = a; } bind(...a) { return new S(this.q, a); }
  async run() { const r = db.prepare(this.q).run(...norm(this.a)); return { meta: { changes: Number(r.changes) } }; }
  async all() { return { results: db.prepare(this.q).all(...norm(this.a)).map(r => ({ ...r })) }; }
  async first() { const r = db.prepare(this.q).get(...norm(this.a)); return r ? { ...r } : null; } }
const env = { DB: { prepare: q => new S(q), async batch(st) { db.exec('BEGIN'); for (const x of st) await x.run(); db.exec('COMMIT'); } }, ADMIN_PASSWORD: 'pw', ENCRYPTION_KEY: 'k', ASSETS: { fetch: async () => new Response('x') } };
const { default: w } = await import(root + '/src/index.js');
const admin = (p, body) => w.fetch(new Request('https://x/api/admin' + p, { method: body ? 'POST' : 'GET', headers: { authorization: 'Basic ' + btoa('admin:pw'), 'content-type': 'application/json' }, body: body && JSON.stringify(body) }), env, {});
const ok = (c, m) => { console.log((c ? 'ok  - ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };

const dir = root + '/Getty data';
if (!existsSync(dir)) { console.log('skip: no Getty data folder'); process.exit(0); }
const files = readdirSync(dir).filter(d => statSync(path.join(dir, d)).isDirectory())
  .flatMap(d => readdirSync(path.join(dir, d)).filter(f => f.endsWith('.txt')).map(f => path.join(dir, d, f)));
let sales = 0;
for (const f of files) { const r = await (await admin('/getty/import', { file: path.basename(f), text: readFileSync(f, 'utf8') })).json(); sales += r.months.reduce((a, m) => a + m.rows, 0); }
ok(files.length === 181 && sales === 7116, `imported ${files.length} statements, ${sales} sales`);
const before = db.prepare('SELECT COUNT(*) n, SUM(royalty) r FROM getty_sales').get();
for (const f of files.slice(0, 20)) await admin('/getty/import', { file: path.basename(f), text: readFileSync(f, 'utf8') });
const after = db.prepare('SELECT COUNT(*) n, SUM(royalty) r FROM getty_sales').get();
ok(before.n === after.n && Math.abs(before.r - after.r) < 1e-6, 're-importing the same months does not double count');
ok((await admin('/getty/import', { file: 'notes.txt', text: 'hello\tworld\n1\t2' })).status === 400, 'non-statement file rejected with a reason');

const sum = await (await admin('/getty/summary')).json();
ok(sum.totals.licenses === 7116 && sum.totals.assets === 926 && sum.totals.first === '2011-07' && sum.years.length >= 15, `summary: ${sum.totals.assets} assets, ${sum.years.length} years`);
const top = await (await admin('/getty/assets?limit=10')).json();
ok(top.assets.length === 10 && top.assets.every((a, i) => i === 0 || top.assets[i - 1].royalty >= a.royalty), 'top assets ranked by royalties');
ok(top.assets.every(a => a.getty_url.endsWith(a.asset_id) && a.title && !a.title.startsWith(a.asset_id + '-')), 'titles cleaned (no "id-" prefix) + Getty links');
const byLic = await (await admin('/getty/assets?limit=10&sort=licenses')).json();
ok(byLic.assets.every((a, i) => i === 0 || byLic.assets[i - 1].licenses >= a.licenses), 'sort by number of licenses');
const recent = await (await admin('/getty/assets?limit=500&period=12m')).json();
ok(recent.assets.length > 0 && recent.assets.length < 926, `last-12-months view narrows the list (${recent.assets.length} assets)`);

// previews: Getty oEmbed (mocked), best sellers first; Flickr link only on an exact file-name title
let oembedCalls = 0;
globalThis.fetch = async url => {
  const u = new URL(String(url));
  if (u.hostname === 'embed.gettyimages.com' && u.pathname === '/oembed') {
    oembedCalls++;
    const id = u.searchParams.get('url').split('/').pop();
    if (id === top.assets[1].asset_id) return new Response('not found', { status: 404 });
    return Response.json({ title: 'T' + id, caption: 'Caption ' + id, thumbnail_url: `https://media.gettyimages.com/id/${id}/photo/x.jpg?s=170x170&c=sig` });
  }
  throw new Error('unexpected ' + url);
};
const pv = await (await admin('/getty/previews?limit=40', {})).json();
ok(pv.fetched === 39 && pv.missing === 1 && pv.remaining === 926 - 40 && !pv.blocked, `first preview batch: ${pv.fetched} thumbnails, ${pv.missing} unavailable, ${pv.remaining} to go`);
const withThumbs = await (await admin('/getty/assets?limit=3')).json();
ok(withThumbs.assets[0].thumb?.startsWith('https://media.gettyimages.com/id/' + withThumbs.assets[0].asset_id) && withThumbs.assets[0].caption, 'top asset shows Getty\'s own thumbnail + caption');
ok(withThumbs.assets[1].thumb === null, 'an asset Getty has no preview for shows none (no guessing)');
const calls = oembedCalls; await admin('/getty/previews?limit=40', {});
ok(oembedCalls - calls === 40, 'next batch fetches only assets not done yet');
globalThis.fetch = async () => new Response('<html>challenge</html>', { status: 403, headers: { 'content-type': 'text/html' } });
const blk = await (await admin('/getty/previews?limit=10', {})).json();
ok(blk.blocked === true, 'detects Getty refusing the site (so the page can say so)');
// Flickr: only an exact file-name title links; a same-title photo does not
db.prepare("INSERT INTO accounts (nsid, token_enc, token_secret_enc) VALUES ('1@N1','x','y')").run();
const a0 = top.assets[0];
db.prepare("INSERT INTO photos (id, account_id, title, status, is_public) VALUES ('41', 1, ?, 'ok', 1), ('42', 1, ?, 'ok', 1)").run(a0.title, (a0.alt_name || 'zzzz').replace(/\.[a-z]+$/i, ''));
const fl = (await (await admin('/getty/assets?limit=1')).json()).assets[0];
ok(!fl.flickr_id || fl.flickr_id !== '41', 'never linked by title alone');
const fid = /^(\d{8,12})/.exec(a0.alt_name)?.[1];
if (fid) {
  ok(fl.flickr_match === 'id' && fl.flickr_url.endsWith(fid) && fl.flickr_id === null, `Flickr ID read from Getty's file name (${a0.alt_name}); not in catalog yet → link to Flickr`);
  db.prepare("INSERT INTO photos (id, account_id, title, status, is_public) VALUES (?, 1, 'x', 'ok', 1)").run(fid);
  const fl2 = (await (await admin('/getty/assets?limit=1')).json()).assets[0];
  ok(fl2.flickr_id === fid, 'and when that photo is in the catalog → exact link to it');
  // Getty withdrew the asset (no oEmbed preview) but the Flickr link is exact → Flickr image as the preview
  db.prepare("UPDATE getty_assets SET thumb_url = NULL, preview_status = 'missing' WHERE asset_id = ?").run(a0.asset_id);
  db.prepare("UPDATE photos SET synced_at = 9, server = '65535', secret = 'abc' WHERE id = ?").run(fid);
  const fl3 = (await (await admin('/getty/assets?limit=1')).json()).assets[0];
  ok(fl3.thumb_source === 'flickr' && fl3.thumb === `/api/admin/img/${fid}/t?v=9` && fl3.thumb_fallback.includes(`${fid}_abc_q.jpg`), 'withdrawn from Getty + exact Flickr link → Flickr thumbnail');
  const t2 = (await (await admin('/getty/assets?limit=3')).json()).assets;
  ok(t2.filter(x => x.thumb_source === 'flickr').every(x => x.flickr_match === 'id'), 'Flickr thumbnails only for exact (ID) links');
}
const { FLICKR_ID_FILE } = await import(root + '/src/routes/getty.js');
ok(['5871998996.jpg', '3276112098_b552eff442_o.jpg', '3298738343_a93cfd4652_o__1_.jpg'].every(n => FLICKR_ID_FILE.test(n)) && !FLICKR_ID_FILE.test('DSC_4339.jpg') && !FLICKR_ID_FILE.test('20081001-DSC_3405.jpg'),
  'Flickr-ID file-name patterns recognised (and camera names not)');
// manual linking for unmatched assets
const unmatched = (await (await admin('/getty/assets?limit=200')).json()).assets.find(a => !a.flickr_match && !a.thumb);
db.prepare("INSERT INTO photos (id, account_id, title, status, is_public, synced_at, server, secret) VALUES ('5555', 1, 'Flatiron at dusk', 'ok', 1, 3, '1', 's')").run();
ok((await admin('/getty/link', { asset_id: unmatched.asset_id, photo_id: 'nope' })).status === 404, 'link rejects a photo that does not exist');
await admin('/getty/link', { asset_id: unmatched.asset_id, photo_id: '5555' });
let lk = (await (await admin('/getty/assets?limit=500')).json()).assets.find(a => a.asset_id === unmatched.asset_id);
ok(lk.flickr_match === 'manual' && lk.flickr_id === '5555' && lk.thumb_source === 'flickr' && lk.thumb === '/api/admin/img/5555/t?v=3', 'manual link → confirmed, shows that Flickr photo when Getty has none');
const remBefore = (await (await admin('/getty/previews?limit=1', {})).json());
ok(remBefore.remaining >= 0, 'preview fetcher still handles assets that have a manual link but no preview yet');
await admin('/getty/link', { asset_id: unmatched.asset_id, photo_id: null });
lk = (await (await admin('/getty/assets?limit=500')).json()).assets.find(a => a.asset_id === unmatched.asset_id);
ok(!lk.flickr_match && !lk.flickr_id, 'unlink');
console.log('   top 5:', top.assets.slice(0, 5).map(a => `${a.title} (${a.licenses})`).join(' · '));
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
