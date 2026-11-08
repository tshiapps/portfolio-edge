// "Featured" page: items created + images uploaded (browser admin or the Mac app's token), shown/hidden,
// reordered, public list + image serving, deletion.
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
const env = {
  DB: { prepare: q => new S(q), async batch(st) { for (const x of st) await x.run(); } }, ADMIN_PASSWORD: 'pw', ENCRYPTION_KEY: 'k',
  BUCKET: { async put(k, b, o) { r2.set(k, { buf: Buffer.from(await new Response(b).arrayBuffer()), o }); }, async get(k) { const x = r2.get(k); return x ? { body: x.buf, httpMetadata: x.o.httpMetadata, httpEtag: '"e"' } : null; }, async delete(k) { r2.delete(k); } },
  ASSETS: { fetch: async () => new Response('page') },
};
globalThis.caches = { default: { match: async () => null, put: async () => {} } };
const { default: w } = await import(root + '/src/index.js');
const { createToken } = await import(root + '/src/lib/tokens.js');
const ok = (c, m) => { console.log((c ? 'ok  - ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };
const go = (p, init = {}, auth = 'Basic ' + btoa('admin:pw')) => w.fetch(new Request('https://x' + p, { ...init, headers: { authorization: auth, ...(init.headers || {}) } }), env, { waitUntil() {} });
const J = async (p, body, method, auth) => (await go('/api/admin' + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }, auth)).json();
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

const token = await createToken(env, 'mac', 'media');
const bearer = 'Bearer ' + token;
const a = await J('/media/features', { title: 'Wall Street Journal', caption: 'Business section', url: 'wsj.com/articles/x' }, 'POST', bearer);
ok(/^[0-9a-f]{16}$/.test(a.id), 'the Mac app (upload token) can create an item');
const put = await go(`/api/admin/media/features/${a.id}/image?w=2000&h=1500`, { method: 'PUT', headers: { 'content-type': 'image/jpeg', 'content-length': String(jpeg.length) }, body: jpeg }, bearer);
ok(put.status === 200 && r2.has(`f/${a.id}.jpg`), 'and upload its cropped image');
const b = await J('/media/features', { title: 'Lonely Planet', fit: 'contain' });
await go(`/api/admin/media/features/${b.id}/image?w=900&h=1200`, { method: 'PUT', headers: { 'content-type': 'image/jpeg', 'content-length': String(jpeg.length) }, body: jpeg });
const c = await J('/media/features', { title: 'Never uploaded' });
let pub = await (await go('/api/features')).json();
ok(pub.features.map(f => f.title).join() === 'Lonely Planet,Wall Street Journal', `public list: newest first, only items with an image (${pub.features.map(f => f.title)})`);
ok(pub.features[1].url === 'https://wsj.com/articles/x' && pub.features[0].fit === 'blur', 'link normalised; "whole image" (older name) becomes the blurred backdrop');
const wf = await J('/media/features', { title: 'w', fit: 'white' });
ok((await J('/media/features')).features.find(f => f.id === wf.id).fit === 'white', 'white backdrop option kept');
await J('/media/features/' + wf.id, null, 'DELETE');
const img = await go(pub.features[0].src.split('?')[0]);
ok(img.status === 200 && img.headers.get('content-type') === 'image/jpeg', 'image served publicly');
await J('/media/features/' + b.id, { enabled: false }, 'PATCH');
pub = await (await go('/api/features')).json();
ok(pub.features.map(f => f.title).join() === 'Wall Street Journal', 'hidden item drops off the page');
const adm = await J('/media/features');
ok(adm.features.length === 3 && adm.shown === 1, 'admin sees everything + how many are shown');
await J('/media/features/' + b.id, { enabled: true, title: 'Lonely Planet — cover' }, 'PATCH');
await J('/media/features/order', { ids: [a.id, b.id, c.id] });
pub = await (await go('/api/features')).json();
ok(pub.features.map(f => f.title).join() === 'Wall Street Journal,Lonely Planet — cover', 'reorder + rename');
const bad = await J('/media/features', { title: 'x', url: 'javascript:alert(1)' });
ok((await J('/media/features')).features.find(f => f.id === bad.id).url === null, 'only http(s) links accepted');
ok((await go('/api/admin/status', {}, bearer)).status === 403, 'upload token still cannot touch the rest of the admin');
await J('/media/features/' + a.id, null, 'DELETE');
ok(!r2.has(`f/${a.id}.jpg`) && (await (await go('/api/features')).json()).features.length === 1, 'delete removes the item and its image');
ok((await (await go('/featured')).text()) === 'page', '/featured page served');
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
