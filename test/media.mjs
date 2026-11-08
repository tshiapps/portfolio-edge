// End-to-end test of the Aerial pipeline: real ffmpeg encodes via tools/aerial.mjs, uploaded over HTTP
// to the real Worker code (SQLite as D1, in-memory R2). Run: node --experimental-sqlite --no-warnings test/media.mjs
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const db = new DatabaseSync(':memory:');
const migDir = new URL('../migrations/', import.meta.url);
for (const f of readdirSync(migDir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, migDir), 'utf8'));
const norm = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.sql, a); }
  async run() { const r = db.prepare(this.sql).run(...norm(this.args)); return { meta: { changes: Number(r.changes) } }; }
  async all() { return { results: db.prepare(this.sql).all(...norm(this.args)).map(r => ({ ...r })) }; }
  async first() { const r = db.prepare(this.sql).get(...norm(this.args)); return r ? { ...r } : null; }
}
const DB = { prepare: sql => new Stmt(sql), async batch(st) { for (const s of st) await s.run(); } };
const r2 = new Map();
const BUCKET = {
  async put(k, body, o) { r2.set(k, { buf: Buffer.from(await new Response(body).arrayBuffer()), o }); },
  async get(k, opts) {
    const x = r2.get(k); if (!x) return null;
    let body = x.buf, range;
    if (opts?.range && typeof opts.range.offset === 'number') {
      const { offset, length } = opts.range;
      return { body: new Uint8Array(x.buf.subarray(offset, offset + length)), size: x.buf.length, httpMetadata: x.o.httpMetadata, httpEtag: '"e"' };
    }
    const h = opts?.range?.get?.('range');
    const m = h && /bytes=(\d*)-(\d*)/.exec(h);
    if (m) {
      if (m[1] === '') { range = { suffix: +m[2] }; body = x.buf.subarray(x.buf.length - +m[2]); }
      else { const s = +m[1], e = m[2] === '' ? x.buf.length - 1 : +m[2]; range = { offset: s, length: e - s + 1 }; body = x.buf.subarray(s, e + 1); }
    }
    return { body: new Uint8Array(body), size: x.buf.length, range, httpMetadata: x.o.httpMetadata, httpEtag: '"e"' };
  },
  async head(k) { const x = r2.get(k); return x ? { size: x.buf.length, httpMetadata: x.o.httpMetadata, httpEtag: '"e"' } : null; },
  async delete(keys) { [].concat(keys).forEach(k => r2.delete(k)); },
};
const env = { DB, BUCKET, ADMIN_PASSWORD: 'pw', ENCRYPTION_KEY: 'k', ASSETS: { fetch: async () => new Response('asset') } };
const ctx = { waitUntil() {} };
const { default: worker } = await import('../src/index.js');

const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const buf = Buffer.concat(chunks);
  const r = await worker.fetch(new Request('http://127.0.0.1' + req.url, { method: req.method, headers: req.headers, body: buf.length ? buf : undefined }), env, ctx);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const basic = { authorization: 'Basic ' + btoa('admin:pw') };
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  -', m); };

// token from the browser admin
const { token } = await (await fetch(base + '/api/admin/tokens', { method: 'POST', headers: { ...basic, 'content-type': 'application/json' }, body: '{"name":"test mac"}' })).json();
assert(/^tsp_[0-9a-f]{48}$/.test(token), 'admin creates an upload token');
const bearer = { authorization: `Bearer ${token}` };
assert((await fetch(base + '/api/admin/status', { headers: bearer })).status === 403, 'token cannot read the rest of the admin');
assert((await fetch(base + '/api/admin/tokens', { headers: bearer })).status === 403, 'token cannot mint tokens');
assert((await fetch(base + '/api/admin/media', { headers: { authorization: 'Bearer tsp_' + '0'.repeat(48) } })).status === 401, 'unknown token rejected');

// source clips: 4K 60fps SDR, and an HLG-tagged 10-bit clip (exercises the HDR→SDR path)
const tmp = mkdtempSync(path.join(os.tmpdir(), 'aerial-src-'));
const ff = args => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); if (r.status) throw new Error(r.stderr.toString()); };
ff(['-f', 'lavfi', '-i', 'testsrc2=size=2720x1530:rate=60:duration=5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(tmp, 'Glacier Flyover.mov')]);
ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
  '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', path.join(tmp, 'hlg.mov')]);

// async spawn: the HTTP server lives in this process, so a blocking spawnSync would deadlock it
const cli = (...args) => new Promise(resolve => {
  const ch = spawn('node', [fileURLToPath(new URL('../tools/aerial.mjs', import.meta.url)), ...args],
    { env: { ...process.env, AERIAL_SERVER: base, AERIAL_TOKEN: token } });
  let stdout = '', stderr = '';
  ch.stdout.on('data', d => stdout += d); ch.stderr.on('data', d => stderr += d);
  ch.on('close', status => resolve({ status, stdout, stderr }));
});
let r = await cli('add', path.join(tmp, 'Glacier Flyover.mov'), '--start', '1', '--end', '0:04');
assert(r.status === 0 && /is live/.test(r.stdout), 'aerial add: 2.7K60 clip compressed + uploaded' + (r.status ? '\n' + r.stderr : ''));
r = await cli('add', path.join(tmp, 'hlg.mov'), '--title', 'HDR test', '--crop', 'center');
assert(r.status === 0 && /HDR arib-std-b67 → SDR/.test(r.stdout), 'aerial add: HLG clip tone-mapped to SDR' + (r.status ? '\n' + r.stderr : ''));

const clips = (await (await fetch(base + '/api/aerial')).json()).clips;
assert(clips.length === 2 && clips[0].title === 'Glacier Flyover' && clips[1].title === 'HDR test', 'public playlist in upload order');
const c0 = db.prepare('SELECT * FROM media_clips WHERE title = ?').get('Glacier Flyover');
assert(Math.abs(c0.duration - 3) < 0.01 && c0.desktop_bytes > 0 && c0.mobile_bytes < c0.desktop_bytes, `trimmed to 3s; desktop ${(c0.desktop_bytes/1e6).toFixed(2)} MB, mobile ${(c0.mobile_bytes/1e6).toFixed(2)} MB`);

// check the encoded file itself
const desk = r2.get(`v/${c0.id}/desktop.mp4`).buf;
const probeFile = path.join(tmp, 'check.mp4'); (await import('node:fs')).writeFileSync(probeFile, desk);
const pr = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', probeFile], { encoding: 'utf8' }).stdout);
const vs = pr.streams[0];
assert(pr.streams.length === 1 && vs.codec_name === 'h264' && vs.width === 1920 && vs.height === 1080 && vs.pix_fmt === 'yuv420p', `desktop: H.264 keeps original 16:9 shape at 1920 wide (${vs.width}×${vs.height}), no audio`);
assert(c0.width === 1920 && c0.height === 1080 && clips[0].width === 1920 && clips[0].height === 1080, 'real output size recorded and published (player sizes the band from it)');
const c1 = db.prepare('SELECT * FROM media_clips WHERE title = ?').get('HDR test');
assert(c1.width === 1920 && c1.height === 960, `--crop center still makes a 2:1 band (${c1.width}×${c1.height})`);
assert(vs.r_frame_rate === '30/1', `60fps source reduced to 30fps (${vs.r_frame_rate})`);
assert(desk.indexOf('moov') < desk.indexOf('mdat'), 'faststart (moov before mdat) so it starts playing immediately');

// Range requests (Safari needs these for video)
const full = await fetch(base + clips[0].desktop);
assert(full.status === 200 && full.headers.get('accept-ranges') === 'bytes', 'video served with accept-ranges');
const part = await fetch(base + clips[0].desktop, { headers: { range: 'bytes=0-1' } });
assert(part.status === 206 && part.headers.get('content-range') === `bytes 0-1/${desk.length}` && (await part.arrayBuffer()).byteLength === 2, 'byte-range request → 206');
const mid = await fetch(base + clips[0].desktop, { headers: { range: 'bytes=1000-1999' } });
const midBuf = Buffer.from(await mid.arrayBuffer());
assert(mid.headers.get('content-range') === `bytes 1000-1999/${desk.length}` && midBuf.equals(desk.subarray(1000, 2000)), 'mid-file range returns exactly those bytes');
const open = await fetch(base + clips[0].desktop, { headers: { range: 'bytes=500-' } });
assert(open.status === 206 && open.headers.get('content-range') === `bytes 500-${desk.length - 1}/${desk.length}` && (await open.arrayBuffer()).byteLength === desk.length - 500, 'open-ended range');
const tail = await fetch(base + clips[0].desktop, { headers: { range: 'bytes=-100' } });
assert(tail.status === 206 && Buffer.from(await tail.arrayBuffer()).equals(desk.subarray(desk.length - 100)), 'suffix range (last 100 bytes)');
assert((await fetch(base + clips[0].desktop, { headers: { range: `bytes=${desk.length + 5}-` } })).status === 416, 'out-of-range → 416');

// manage
r = await cli('order', clips[1].id); assert(r.status === 0, 'aerial order');
assert((await (await fetch(base + '/api/aerial')).json()).clips[0].title === 'HDR test', 'reorder reflected publicly');
r = await cli('hide', clips[1].id); assert(r.status === 0, 'aerial hide');
assert((await (await fetch(base + '/api/aerial')).json()).clips.length === 1, 'hidden clip off the page');
assert((await fetch(base + clips[1].desktop)).status === 404, 'hidden clip files not served');
r = await cli('list'); assert(/\[hidden\]/.test(r.stdout), 'aerial list shows hidden state');
r = await cli('rm', clips[0].id); assert(r.status === 0 && ![...r2.keys()].some(k => k.includes(clips[0].id)), 'aerial rm deletes files from R2');

// photo slides between the videos
db.prepare("INSERT INTO accounts (nsid, token_enc, token_secret_enc) VALUES ('1@N1','x','y')").run();
db.prepare("INSERT INTO photos (id, account_id, title, status, is_public, hidden, width, height, synced_at) VALUES ('777', 1, 'Golden Gate', 'ok', 1, 0, 2500, 1667, 42), ('888', 1, 'Private one', 'ok', 0, 0, 2500, 1667, 1)").run();
const addP = await (await fetch(base + '/api/admin/media/photos', { method: 'POST', headers: { ...basic, 'content-type': 'application/json' }, body: '{"ids":["777","888","999"]}' })).json();
assert(addP.added === 2, `photos added as slides (missing ones skipped): ${addP.added}`);
let reel = (await (await fetch(base + '/api/aerial')).json()).clips;
const slide = reel.find(c => c.kind === 'photo');
assert(slide && slide.src === '/img/777/m?v=42' && slide.duration === 7 && slide.caption === null, 'public reel: photo slide with image, 7 s default, default headline');
assert(!reel.some(c => c.title === 'Private one'), 'a private photo never appears on the public reel');
const adm = (await (await fetch(base + '/api/admin/media', { headers: basic })).json()).clips;
assert(adm.find(c => c.photo_id === '888').photo_visible === false, 'admin flags the slide that cannot show publicly');
await fetch(base + '/api/admin/media/' + slide.id, { method: 'PATCH', headers: { ...basic, 'content-type': 'application/json' }, body: JSON.stringify({ caption: 'Stunning visuals for your brand', duration: 10 }) });
reel = (await (await fetch(base + '/api/aerial')).json()).clips;
const s2 = reel.find(c => c.id === slide.id);
assert(s2.caption === 'Stunning visuals for your brand' && s2.duration === 10, 'custom headline + duration on a slide');
await fetch(base + '/api/admin/media/' + slide.id, { method: 'PATCH', headers: { ...basic, 'content-type': 'application/json' }, body: '{"overlay":"prints"}' });
assert((await (await fetch(base + '/api/aerial')).json()).clips.find(c => c.id === slide.id).overlay === 'prints', 'per-slide overlay message (prints)');
const badOv = await fetch(base + '/api/admin/media/' + slide.id, { method: 'PATCH', headers: { ...basic, 'content-type': 'application/json' }, body: '{"overlay":"nonsense"}' });
assert(badOv.ok && (await (await fetch(base + '/api/aerial')).json()).clips.find(c => c.id === slide.id).overlay === 'prints', 'unknown overlay value ignored');
assert(reel.filter(c => c.kind === 'video').every(c => 'caption' in c), 'video items carry a caption field too (default = licensing pitch)');
const tokAdd = await fetch(base + '/api/admin/media/photos', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"ids":["777"]}' });
assert(tokAdd.ok, 'Mac app token can add slides too (media scope)');

// revoke
const tid = db.prepare('SELECT id FROM api_tokens').get().id;
await fetch(base + '/api/admin/tokens/' + tid, { method: 'DELETE', headers: basic });
r = await cli('list'); assert(r.status !== 0 && /401/.test(r.stderr), 'revoked token stops working');

server.close();
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
