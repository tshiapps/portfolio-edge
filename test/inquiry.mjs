// Inquiry form: admin-entered Turnstile/Resend settings (secrets sealed), config endpoint, send + test email.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const db = new DatabaseSync(':memory:');
for (const f of readdirSync(root + '/migrations').sort()) db.exec(readFileSync(root + '/migrations/' + f, 'utf8'));
class S { constructor(q, a = []) { this.q = q; this.a = a; } bind(...a) { return new S(this.q, a); }
  async run() { db.prepare(this.q).run(...this.a); return { meta: {} }; } async all() { return { results: db.prepare(this.q).all(...this.a).map(r => ({ ...r })) }; }
  async first() { const r = db.prepare(this.q).get(...this.a); return r ? { ...r } : null; } }
const sent = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes('turnstile')) { const f = init.body; return Response.json({ success: f.get('secret') === '0xSECRETsecret123' && f.get('response') === 'good-token' }); }
  if (String(url).includes('api.resend.com')) {
    if (init.headers.authorization !== 'Bearer re_TESTkey_123456') return Response.json({ message: 'API key is invalid' }, { status: 401 });
    sent.push(JSON.parse(init.body)); return Response.json({ id: 'em_1' });
  }
  throw new Error('unexpected fetch ' + url);
};
const env = { DB: { prepare: q => new S(q) }, ADMIN_PASSWORD: 'pw', ENCRYPTION_KEY: 'k', INQUIRY_TO: '', TURNSTILE_SITE_KEY: '', ASSETS: { fetch: async () => new Response('x') } };
const { default: w } = await import(root + '/src/index.js');
const go = (p, init = {}) => w.fetch(new Request('https://tonyshi.photos' + p, init), env, {});
const admin = (p, body) => go('/api/admin' + p, { method: body ? 'POST' : 'GET', headers: { authorization: 'Basic ' + btoa('admin:pw'), 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
const ok = (c, m) => { console.log((c ? 'ok  - ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };
const inquire = token => go('/api/inquiry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ana', email: 'ana@example.com', subject: 'Licensing', message: 'Hi!', token }) });

let cfg = await (await go('/api/config')).json();
ok(cfg.inquiryReady === false && !cfg.turnstileSiteKey, 'unconfigured: page told the form is not ready (no broken widget)');
ok((await inquire('good-token')).status === 503, 'unconfigured: submissions refused politely');
ok((await admin('/settings', { turnstile_site_key: 'nope' })).status === 400, 'bad site key rejected');
ok((await admin('/settings', { resend_api_key: 'sk_123' })).status === 400, 'bad Resend key rejected');
ok((await admin('/settings', { inquiry_to: 'not an email' })).status === 400, 'bad send-to rejected');
ok((await admin('/settings', { turnstile_site_key: '0xSITEkey12345', turnstile_secret: '0xSECRETsecret123', resend_api_key: 're_TESTkey_123456', inquiry_to: 'tony@example.com', inquiry_from: 'tonyshi.photos <no-reply@tonyshi.photos>' })).ok, 'admin saves the inquiry settings');
const raw = db.prepare("SELECT key, value FROM settings WHERE key IN ('turnstile_secret','resend_api_key')").all();
ok(raw.length === 2 && raw.every(r => !r.value.includes('SECRET') && !r.value.includes('re_TEST')), 'secrets stored encrypted');
const st = await (await admin('/status')).json();
ok(st.config.inquiry.ready && st.config.inquiry.siteKey === '0xSITEkey12345' && !JSON.stringify(st).includes('re_TEST') && !JSON.stringify(st).includes('0xSECRET'), 'status shows ready + site key, never the secrets');
cfg = await (await go('/api/config')).json();
ok(cfg.inquiryReady && cfg.turnstileSiteKey === '0xSITEkey12345', 'public config hands the widget the site key');
ok((await inquire('bad-token')).status === 403, 'failed anti-bot check rejected');
const r = await inquire('good-token');
ok(sent[0]?.from === '"Ana via tonyshi.photos" <no-reply@tonyshi.photos>', `sender shows the visitor's name (${sent[0]?.from})`);
ok(r.ok && sent.length === 1 && sent[0].to[0] === 'tony@example.com' && sent[0].reply_to === 'ana@example.com' && /Licensing/.test(sent[0].subject), 'valid inquiry emailed to you with Reply-To the visitor');
const ra = await go('/api/inquiry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Bo', email: 'bo@example.com', asset: 'Photo #52759839641 “Bay Bridge”', message: 'Print?', token: 'good-token' }) });
const body = sent[1]?.text || '';
ok(ra.ok && /Photo inquiry/.test(sent[1]?.subject) && body.includes('Photo / asset: Photo #52759839641') && body.includes('/img/52759839641/m'), 'photo inquiry: asset + image link in the email');
sent.splice(1, 1);
const t = await (await admin('/inquiry/test', {})).json();
ok(t.ok && sent.length === 2 && /Test/.test(sent[1].subject), 'Send test email works');
await admin('/settings', { resend_api_key: 're_WRONGkey_000000' });
const bad = await (await admin('/inquiry/test', {})).json();
ok(/Resend 401: API key is invalid/.test(bad.error), `test email surfaces Resend's error (${bad.error})`);
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
