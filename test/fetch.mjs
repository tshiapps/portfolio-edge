// Photo fetcher end-to-end: the Worker hands a 429'd photo to the fetcher; tools/flickr-fetch.mjs (a real
// child process) pulls the queue over HTTP, downloads from a local fake Flickr CDN, uploads; the photo is stored.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const db = new DatabaseSync(':memory:');
for (const f of readdirSync(root + '/migrations').sort()) db.exec(readFileSync(root + '/migrations/' + f, 'utf8'));
const norm = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
class S { constructor(q, a = []) { this.q = q; this.a = a; } bind(...a) { return new S(this.q, a); }
  async run() { const r = /returning/i.test(this.q) ? { changes: db.prepare(this.q).all(...norm(this.a)).length } : db.prepare(this.q).run(...norm(this.a)); return { meta: { changes: Number(r.changes) } }; }
  async all() { return { results: db.prepare(this.q).all(...norm(this.a)).map(r => ({ ...r })) }; }
  async first() { const r = db.prepare(this.q).get(...norm(this.a)); return r ? { ...r } : null; } }
const DB = { prepare: q => new S(q), async batch(st) { for (const x of st) await x.run(); } };
const r2 = new Map();
const IMAGES = {
  input(stream) { const ch = { ops: [], transform(o) { this.ops.push(o); return this; },
    async output(o) { const n = (await new Response(stream).arrayBuffer()).byteLength; return { response: () => new Response(new Uint8Array(o.format === 'image/jpeg' ? (n > 5000 ? 120000 : 60000) : 9000)) }; } }; return ch; },
  async info(stream) { const b = (await new Response(stream).arrayBuffer()).byteLength; return b > 100000 ? { width: 6144, height: 1275 } : { width: 1024, height: 213 }; },
};
const BUCKET = {
  async put(k, v, o) { const b = Buffer.from(await new Response(v).arrayBuffer()); b.type = o?.httpMetadata?.contentType; r2.set(k, b); },
  async get(k) { const b = r2.get(k); return b ? { size: b.length, httpMetadata: { contentType: b.type }, arrayBuffer: async () => b, body: new Response(b).body } : null; },
  async head() { return null; },
  async delete(keys) { [].concat(keys).forEach(k => r2.delete(k)); },
};

// fake Flickr CDN on localhost (the fetcher downloads from here) — real JPEGs so local resizing is exercised
import { spawnSync } from 'node:child_process';
import os from 'node:os';
const tmpd = (await import('node:fs')).mkdtempSync(os.tmpdir() + '/cdn-');
const mk = (w, h, f) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}`, '-frames:v', '1', '-q:v', '3', `${tmpd}/${f}`]);
mk(6144, 1275, '6k.jpg'); mk(1024, 213, 'b.jpg');
const jpg = f => readFileSync(`${tmpd}/${f}`);
let cdnHits = [];
let hugeOriginal = false;
const cdn = http.createServer((req, res) => {
  cdnHits.push(req.url);
  if (req.url.includes('_o.jpg') && hugeOriginal) { res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': '240000000' }); res.flushHeaders(); return setTimeout(() => res.destroy(), 3000); }
  if (req.url.includes('_o.jpg')) { res.writeHead(404); return res.end(); }     // original not available
  res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(jpg(req.url.includes('_6k') ? '6k.jpg' : 'b.jpg'));
});
await new Promise(r => cdn.listen(0, '127.0.0.1', r));
const cdnBase = `http://127.0.0.1:${cdn.address().port}`;

// Worker's outbound calls: Flickr API mocked; the Worker's own CDN downloads get 429 (as in real life)
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'api.flickr.com') {
    const m = url.searchParams.get('method');
    const ok = o => Response.json({ stat: 'ok', ...o });
    if (m === 'flickr.photos.getInfo') return ok({ photo: { id: '555', rotation: 0, title: { _content: 'Acropolis pano' }, description: { _content: '' }, tags: { tag: [] }, urls: { url: [] } } });
    if (m === 'flickr.photos.getExif') return ok({ photo: { exif: [] } });
    if (m === 'flickr.photos.getSizes') return ok({ sizes: { size: [
      { label: 'Large', width: 1024, height: 213, source: `${cdnBase}/555_b.jpg`, media: 'photo' },
      { label: 'X-Large 6K', width: 6144, height: 1275, source: `${cdnBase}/555_6k.jpg`, media: 'photo' },
      { label: 'Original', width: 12000, height: 2490, source: `${cdnBase}/555_o.jpg`, media: 'photo' }] } });
  }
  if (url.port === String(cdn.address().port) && !init?.fromFetcher) return new Response('slow down', { status: 429 });
  return realFetch(input, init);
};

const { seal } = await import(root + '/src/lib/crypto.js');
const env = { DB, IMAGES, BUCKET, ENCRYPTION_KEY: 'k', ADMIN_PASSWORD: 'pw', SYNC_TICK_MS: 15000, ASSETS: { fetch: async () => new Response('x') } };
db.prepare("INSERT INTO settings (key, value) VALUES ('flickr_api_key', '0123456789abcdef0123456789abcdef'), ('flickr_api_secret', ?), ('cdn_rate', '100'), ('cdn_rate_at', ?)")
  .run(await seal(env, '0123456789abcdef'), String(Math.floor(Date.now() / 1000)));
db.prepare("INSERT INTO accounts (nsid, username, token_enc, token_secret_enc, sync_phase, last_full_sync, last_recent_check, last_album_sync) VALUES ('1@N01','tony',?,?, 'idle', ?, ?, ?)")
  .run(await seal(env, 't'), await seal(env, 's'), ...Array(3).fill(Math.floor(Date.now() / 1000)));
db.prepare("INSERT INTO photos (id, account_id, secret, server, title, o_width, o_height, date_upload, status, is_public) VALUES ('555', 1, 'x', '1', 'Acropolis pano', 12000, 2490, 1, 'pending', 1)").run();

const { default: worker } = await import(root + '/src/index.js');
const { runTick } = await import(root + '/src/sync/engine.js');
const ok = (c, m) => { console.log((c ? 'ok  - ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };

await runTick(env);
let row = db.prepare("SELECT status, title, attempts FROM photos WHERE id='555'").get();
ok(row.status === 'fetch' && row.attempts === 0, `Worker blocked by 429 → photo handed to the fetcher (status ${row.status})`);
ok(row.title === 'Acropolis pano', 'metadata saved before the hand-off');

// site over HTTP for the fetcher
const site = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const b = Buffer.concat(chunks);
  const r = await worker.fetch(new Request('http://127.0.0.1' + req.url, { method: req.method, headers: req.headers, body: b.length ? b : undefined }), env, {});
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;
const { token } = await (await realFetch(base + '/api/admin/tokens', { method: 'POST', headers: { authorization: 'Basic ' + btoa('admin:pw'), 'content-type': 'application/json' }, body: '{}' })).json();
const stF = await (await realFetch(base + '/api/admin/fetch/status', { headers: { authorization: `Bearer ${token}` } })).json();
ok(stF.waiting === 1 && stF.photos[0].id === '555' && stF.photos[0].title === 'Acropolis pano' && /_q\.jpg$/.test(stF.photos[0].thumb), 'app can list which photos are waiting (with thumbnails)');
// the fetcher process's downloads should succeed (they come from "your network"): let them through
globalThis.fetch = (orig => async (input, init) => orig(input, init))(globalThis.fetch);

const out = await new Promise(resolve => {
  const ch = spawn('node', [root + '/tools/flickr-fetch.mjs', '--pace', '0'], { env: { ...process.env, AERIAL_TOKEN: token, AERIAL_SERVER: base } });
  let s = ''; ch.stdout.on('data', d => s += d); ch.stderr.on('data', d => s += d); ch.on('close', code => resolve({ code, s }));
});
row = db.prepare("SELECT status, source_size, width FROM photos WHERE id='555'").get();
ok(out.code === 0 && /✓ "Acropolis pano" X-Large 6K/.test(out.s), 'fetcher ran and reported the photo');
ok(/▶ "Acropolis pano" \(555\)/.test(out.s) && /trying Original/.test(out.s) && /Original: HTTP 404/.test(out.s) && /downloaded X-Large 6K/.test(out.s) && /resized → 6144×/.test(out.s),
  'log shows each step: which photo, sizes tried, download, resize');
row = db.prepare("SELECT status, source_size, width, height, thumb_w, thumb_h, bytes FROM photos WHERE id='555'").get();
ok(row.status === 'ok' && row.source_size === 'X-Large 6K' && row.width === 6144 && Math.abs(row.height - 1275) <= 1, `resized on the Mac from the 6K download (${row.source_size}, ${row.width}×${row.height})`);
ok(Math.abs(row.thumb_w - 3084) <= 2 && Math.abs(row.thumb_h - 640) <= 1, `panorama thumb sized by its short edge (${row.thumb_w}×${row.thumb_h})`);
const pr = f => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', '-i', 'pipe:0'], { input: r2.get(f) }).stdout).streams[0];
const pm = pr('m/555.jpg'), pt = pr('t/555.webp');
ok(pm.codec_name === 'mjpeg' && pm.width === 6144 && pt.codec_name === 'webp' && Math.abs(pt.width - 3084) <= 2, 'real JPEG master + WebP thumb in R2');
ok(![...r2.keys()].some(k => k.startsWith('p/')), 'staging files cleaned up');
ok(cdnHits.some(u => u.includes('_o.jpg')) && cdnHits.some(u => u.includes('_6k.jpg')), 'fetcher tried the original, fell back to 6K (original unavailable)');
ok(row.bytes === r2.get('m/555.jpg').length, 'recorded size matches the stored file');
// admin: "Send to Mac fetcher" puts chosen photos straight on the list
const sendTo = await (await realFetch(base + '/api/admin/photos/bulk', { method: 'POST', headers: { authorization: 'Basic ' + btoa('admin:pw'), 'content-type': 'application/json' }, body: '{"ids":["555"],"fetch":true}' })).json();
const st555 = db.prepare("SELECT status, refetch FROM photos WHERE id='555'").get();
ok(sendTo.queued === 1 && st555.status === 'ok' && st555.refetch === 1, 'admin "Send to Mac fetcher" queues the selected photos (a stored photo stays on the site meanwhile)');
const q555 = await (await realFetch(base + '/api/admin/fetch/queue', { headers: { authorization: `Bearer ${token}` } })).json();
ok(q555.photos.some(p => p.id === '555'), 'a stored photo being upgraded is handed to the fetcher');
db.prepare("UPDATE photos SET lease_until=NULL WHERE id='555'").run();
// right after Re-process the photo is 'pending' (site preparing it): the fetcher waits for the hand-off instead of quitting
db.prepare("UPDATE photos SET status='pending', error=NULL, lease_until=NULL WHERE id='555'").run();
setTimeout(() => db.prepare("UPDATE photos SET status='fetch' WHERE id='555'").run(), 1500); // the site's next run hands it over
const outW = await new Promise(resolve => {
  const ch = spawn('node', [root + '/tools/flickr-fetch.mjs', '--pace', '0'], { env: { ...process.env, AERIAL_TOKEN: token, AERIAL_SERVER: base, AERIAL_TEST_FAST: '1' } });
  let s3 = ''; ch.stdout.on('data', d => s3 += d); ch.stderr.on('data', d => s3 += d); ch.on('close', code => resolve({ code, s: s3 }));
});
ok(/still preparing 1 photo/.test(outW.s) && /✓ "Acropolis pano"/.test(outW.s), 'fetcher waits for photos the site is still preparing, then processes them');
// a 240 MB original: skipped in favour of Flickr's 6K copy instead of a slow, fragile download
hugeOriginal = true;
db.prepare("UPDATE photos SET status='fetch', error=NULL, lease_until=NULL WHERE id='555'").run();
const outH = await new Promise(resolve => {
  const ch = spawn('node', [root + '/tools/flickr-fetch.mjs', '--pace', '0'], { env: { ...process.env, AERIAL_TOKEN: token, AERIAL_SERVER: base } });
  let s4 = ''; ch.stdout.on('data', d => s4 += d); ch.stderr.on('data', d => s4 += d); ch.on('close', code => resolve({ code, s: s4 }));
});
ok(/Original is 240\.0 MB — using Flickr's large copy/.test(outH.s) && /✓ "Acropolis pano" X-Large 6K/.test(outH.s), 'huge original skipped → 6K copy used, photo stored');
hugeOriginal = false;
// a failed try puts the photo on a cooldown; pressing Start retries it right away
db.prepare("UPDATE photos SET status='fetch', error='previous try failed', lease_until=? WHERE id='555'").run(Math.floor(Date.now() / 1000) + 600);
const qNo = await (await realFetch(base + '/api/admin/fetch/queue', { headers: { authorization: `Bearer ${token}` } })).json();
ok(qNo.photos.length === 0 && qNo.waiting === 1 && qNo.nextRetryAt > Date.now() / 1000, 'cooling-down photo not handed out by routine polling (and the queue says when)');
db.prepare("UPDATE photos SET status='fetch', error=NULL, lease_until=NULL WHERE id='555'").run();
// a Mac whose ffmpeg can't write WebP (Homebrew's current build): JPEG thumbnail instead, checked before downloading
db.prepare("UPDATE photos SET status='fetch', error='previous try failed', lease_until=? WHERE id='555'").run(Math.floor(Date.now() / 1000) + 600);
const out2 = await new Promise(resolve => {
  const ch = spawn('node', [root + '/tools/flickr-fetch.mjs', '--pace', '0'], { env: { ...process.env, AERIAL_TOKEN: token, AERIAL_SERVER: base, AERIAL_NO_WEBP: '1' } });
  let s2 = ''; ch.stdout.on('data', d => s2 += d); ch.stderr.on('data', d => s2 += d); ch.on('close', code => resolve({ code, s: s2 }));
});
const tj = r2.get('t/555.webp');
ok(/✓ "Acropolis pano"/.test(out2.s), 'pressing Start retries a cooling-down photo immediately');
ok(/Thumbnails: JPEG/.test(out2.s) && /✓ "Acropolis pano"/.test(out2.s), 'no WebP encoder: says so up front and still stores the photo');
ok(tj.type === 'image/jpeg' && tj[0] === 0xff && tj[1] === 0xd8, 'thumbnail stored as JPEG with the right content type');
ok(r2.get('m/555.jpg').type === 'image/jpeg', 'master still JPEG');
const bad = await realFetch(base + '/api/admin/status', { headers: { authorization: `Bearer ${token}` } });
ok(bad.status === 403, 'fetcher token still cannot read the rest of the admin');
// a photo on the Aerial reel: the app also makes an extra-large copy, the reel then plays that one
db.prepare("INSERT INTO media_clips (id, page, kind, photo_id, title, status, position, duration, width, height) VALUES ('reel1', 'aerial', 'photo', '555', 'Acropolis', 'ready', 0, 7, 6144, 1274)").run();
db.prepare("UPDATE photos SET is_public = 1, hidden = 0 WHERE id = '555'").run();
const up1 = await (await realFetch(base + '/api/admin/photos/sizes', { method: 'POST', headers: { authorization: 'Basic ' + btoa('admin:pw'), 'content-type': 'application/json' }, body: '{}' })).json();
db.prepare("UPDATE photos SET refetch = 1 WHERE id='555'").run(); // reel photo without its large copy yet
ok(up1.showcase >= 1 && db.prepare("SELECT showcase, status FROM photos WHERE id='555'").get().showcase === 1, `a reel photo counts as showcase (${up1.showcase})`);
const outR = await new Promise(resolve => {
  const ch = spawn('node', [root + '/tools/flickr-fetch.mjs', '--pace', '0'], { env: { ...process.env, AERIAL_TOKEN: token, AERIAL_SERVER: base } });
  let s5 = ''; ch.stdout.on('data', d => s5 += d); ch.stderr.on('data', d => s5 += d); ch.on('close', code => resolve({ code, s: s5 }));
});
const rr = db.prepare("SELECT reel_w, reel_h, refetch, status FROM photos WHERE id='555'").get();
ok(/Aerial reel copy → 6144×/.test(outR.s) && r2.has('r/555.jpg') && rr.reel_w === 6144 && rr.refetch === 0 && rr.status === 'ok', `reel photo gets its extra-large copy (${rr.reel_w}×${rr.reel_h})`);
const reelApi = await (await realFetch(base + '/api/aerial')).json();
ok(reelApi.clips?.some?.(c => c.kind === 'photo' && /\/img\/555\/r\?/.test(c.src)) || JSON.stringify(reelApi).includes('/img/555/r?'), 'the Aerial page plays the extra-large copy');
const up2 = await (await realFetch(base + '/api/admin/photos/sizes', { headers: { authorization: 'Basic ' + btoa('admin:pw') } })).json();
ok(up2.waiting_mac === 0, 'nothing left waiting for the Mac app afterwards');
console.log(out.s.trim().split('\n').map(l => '   | ' + l).join('\n'));
site.close(); cdn.close();
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
