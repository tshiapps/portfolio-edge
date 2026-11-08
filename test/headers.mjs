// Security headers + hotlink protection: every page's inline scripts are allowed by hash (and nothing else
// inline), no inline event handlers anywhere, headers on pages / API / images, images refused to other sites.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const ok = (c, m) => { console.log((c ? 'ok  - ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };
const { INLINE_SCRIPT_HASHES } = await import(root + '/src/lib/headers.js');

// static checks
const pages = fs.readdirSync(root + '/public').filter(f => f.endsWith('.html')).map(f => ['public/' + f, fs.readFileSync(root + '/public/' + f, 'utf8')])
  .concat([['public/admin/index.html', fs.readFileSync(root + '/public/admin/index.html', 'utf8')]]);
const missing = [];
for (const [f, h] of pages) for (const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  const hash = 'sha256-' + crypto.createHash('sha256').update(m[1]).digest('base64');
  if (!INLINE_SCRIPT_HASHES.includes(hash)) missing.push(`${f}: ${hash}`);
}
ok(!missing.length, `every inline <script> is allowed by hash ${missing.length ? '— add: ' + missing.join(', ') : ''}`);
const js = ['public/assets', 'public/admin'].flatMap(d => fs.readdirSync(root + '/' + d).filter(f => /\.(js|html)$/.test(f)).map(f => d + '/' + f));
const handlers = [...pages.map(([f, h]) => [f, h]), ...js.map(f => [f, fs.readFileSync(root + '/' + f, 'utf8')])]
  .flatMap(([f, t]) => [...t.matchAll(/\son(error|load|click|change|input|submit|mouse\w+|key\w+)="/g)].map(m => `${f}: on${m[1]}`));
ok(!handlers.length, `no inline event handlers (the CSP blocks them) ${handlers.join(', ')}`);

// live checks through the Worker
const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(root + '/migrations').sort()) db.exec(fs.readFileSync(root + '/migrations/' + f, 'utf8'));
const norm = a => a.map(v => (v === undefined ? null : v));
class S { constructor(q, a = []) { this.q = q; this.a = a; } bind(...a) { return new S(this.q, a); }
  async run() { const r = db.prepare(this.q).run(...norm(this.a)); return { meta: { changes: Number(r.changes) } }; }
  async all() { return { results: db.prepare(this.q).all(...norm(this.a)).map(r => ({ ...r })) }; }
  async first() { const r = db.prepare(this.q).get(...norm(this.a)); return r ? { ...r } : null; } }
const env = {
  DB: { prepare: q => new S(q), async batch(st) { for (const x of st) await x.run(); } }, ADMIN_PASSWORD: 'pw', ENCRYPTION_KEY: 'k'.repeat(44),
  BUCKET: { async get(k) { return k === 'm/101.jpg' ? { body: new Uint8Array([0xff, 0xd8, 1]), httpMetadata: { contentType: 'image/jpeg' } } : null; } },
  ASSETS: { fetch: async req => new Response('<!doctype html><title>x</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
};
globalThis.caches = { default: { match: async () => null, put: async () => {} } };
db.prepare("INSERT INTO accounts (nsid, token_enc, token_secret_enc) VALUES ('1@N1','x','y')").run();
db.prepare("INSERT INTO photos (id, account_id, title, status, is_public, hidden) VALUES ('101', 1, 't', 'ok', 1, 0)").run();
const { default: w } = await import(root + '/src/index.js');
const go = (p, headers = {}) => w.fetch(new Request('https://tonyshi.photos' + p, { headers }), env, { waitUntil() {} });

const page = await go('/featured');
const csp = page.headers.get('content-security-policy') || '';
ok(/frame-ancestors 'none'/.test(csp) && /script-src 'self' 'sha256-/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), 'pages: CSP with hashed inline scripts, no unsafe-inline scripts, no framing');
ok(page.headers.get('strict-transport-security') === 'max-age=31536000' && page.headers.get('x-content-type-options') === 'nosniff'
  && page.headers.get('referrer-policy') && page.headers.get('permissions-policy') && page.headers.get('x-frame-options') === 'DENY', 'pages: HSTS, nosniff, referrer, permissions, frame headers');
const api = await go('/api/config');
ok(api.headers.get('x-content-type-options') === 'nosniff' && !api.headers.get('access-control-allow-origin'), 'API: security headers, no CORS opened');
const adm = await go('/admin/');
ok(adm.status === 401 && adm.headers.get('strict-transport-security'), 'admin (even the login prompt) gets the headers');

ok((await go('/img/101/m')).status === 200, 'image: direct (no referrer) works');
ok((await go('/img/101/m', { referer: 'https://tonyshi.photos/photos' })).status === 200, 'image: on this site works');
ok((await go('/img/101/m', { referer: 'https://www.google.com/' })).status === 200, 'image: search engines allowed');
const hot = await go('/img/101/m', { referer: 'https://someblog.example/post' });
ok(hot.status === 403 && /can’t be embedded/.test(await hot.text()), 'image: another site embedding it gets a 403');
db.prepare("INSERT INTO settings (key, value) VALUES ('hotlink_allow', 'someblog.example') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
ok((await go('/img/101/m', { referer: 'https://someblog.example/post' })).status === 200, 'image: a site you allow works');
db.prepare("INSERT INTO settings (key, value) VALUES ('hotlink_protect', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
ok((await go('/img/101/m', { referer: 'https://other.example/' })).status === 200, 'image: protection off → anyone');
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
