import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const db = new DatabaseSync(':memory:');
for (const f of readdirSync(root + '/migrations').sort()) db.exec(readFileSync(root + '/migrations/' + f, 'utf8'));
class S { constructor(q, a = []) { this.q = q; this.a = a; } bind(...a) { return new S(this.q, a); }
  async run() { db.prepare(this.q).run(...this.a); return { meta: {} }; } async all() { return { results: db.prepare(this.q).all(...this.a).map(r => ({ ...r })) }; }
  async first() { const r = db.prepare(this.q).get(...this.a); return r ? { ...r } : null; } }
let asked = [];
const env = { DB: { prepare: q => new S(q) }, ADMIN_PASSWORD: 'pw',
  ASSETS: { fetch: async r => { asked.push(new URL(r.url).pathname); return new Response('page:' + new URL(r.url).pathname); } } };
const { default: w } = await import(root + '/src/index.js');
const go = async (p, init) => w.fetch(new Request('https://tonyshi.photos' + p, init), env, {});
const ok = (c, m) => console.log((c ? 'ok  - ' : 'FAIL: ') + m);
ok(await (await go('/')).text() === 'page:/photos', 'home defaults to Photos');
const auth = { authorization: 'Basic ' + btoa('admin:pw'), 'content-type': 'application/json' };
ok((await go('/api/admin/settings', { method: 'POST', headers: auth, body: '{"home_page":"nope"}' })).status === 400, 'invalid home page rejected');
ok((await go('/api/admin/settings', { method: 'POST', headers: auth, body: '{"home_page":"aerial"}' })).ok, 'admin sets home to Aerial');
ok(await (await go('/')).text() === 'page:/aerial', 'home now serves Aerial');
ok(await (await go('/photos')).text() === 'page:/photos', '/photos always the grid');
ok((await go('/about')).status === 302, '/about redirects home (bio retired)');
