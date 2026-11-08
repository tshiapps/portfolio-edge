// Instagram matcher end to end: the real Worker over HTTP, a fake Instagram CDN, the Mac-side runner
// (tools/…/ig-match.mjs) and ig_match.py (with the light "hist" model instead of DINOv2 so it runs anywhere).
// Instagram versions are cropped to 4:5 / 1:1, desaturated and recompressed — like real posts.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const ok = (c, m) => { console.log((c ? 'ok  - ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };
const py = spawnSync('python3', ['-c', 'import cv2, PIL, numpy'], { encoding: 'utf8' });
if (py.status !== 0) { console.log('skip — needs python3 with opencv, pillow, numpy'); process.exit(0); }

// images: 6 "site photos" (random shapes/texture), Instagram versions of 4 of them + 1 unrelated post
const tmp = fs.mkdtempSync(os.tmpdir() + '/igm-');
const gen = spawnSync('python3', ['-c', `
import random, sys, numpy as np
T = sys.argv[1]
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter
def scene(seed):
    r = random.Random(seed); w, h = 1024, 683
    im = Image.fromarray((np.random.default_rng(seed).random((h, w, 3)) * 60 + r.randint(40, 150)).astype('uint8')).filter(ImageFilter.GaussianBlur(2))
    d = ImageDraw.Draw(im)
    for _ in range(90):
        x, y, s = r.randint(0, w), r.randint(0, h), r.randint(8, 90)
        c = tuple(r.randint(0, 255) for _ in range(3))
        [d.ellipse, d.rectangle][r.randint(0, 1)]((x, y, x + s, y + int(s * r.uniform(.4, 1.6))), fill=c, outline=(0, 0, 0))
    return im
for i in range(6): scene(i).save(f'{T}/site{i}.webp', quality=72)
for i, (ar, sat) in enumerate([(0.8, 0.0), (1.0, 0.6), (0.8, 1.3), (1.0, 1.0)]):
    im = scene(i); W, H = im.size; nw = int(H * ar); x = (W - nw) // 3
    v = ImageEnhance.Color(im.crop((x, 0, x + nw, H))).enhance(sat).resize((1080, int(1080 / ar)))
    v.save(f'{T}/ig{i}.jpg', quality=80)
scene(99).crop((0, 0, 683, 683)).resize((1080, 1080)).save(f'{T}/ig9.jpg', quality=80)
`, tmp], { encoding: 'utf8' });
if (gen.status !== 0) { console.log(gen.stderr); process.exit(1); }

const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(root + '/migrations').sort()) db.exec(fs.readFileSync(root + '/migrations/' + f, 'utf8'));
const norm = a => a.map(v => (v === undefined ? null : v));
class S { constructor(q, a = []) { this.q = q; this.a = a; } bind(...a) { return new S(this.q, a); }
  async run() { const r = db.prepare(this.q).run(...norm(this.a)); return { meta: { changes: Number(r.changes) } }; }
  async all() { return { results: db.prepare(this.q).all(...norm(this.a)).map(r => ({ ...r })) }; }
  async first() { const r = db.prepare(this.q).get(...norm(this.a)); return r ? { ...r } : null; } }
const env = {
  DB: { prepare: q => new S(q), async batch(st) { for (const x of st) await x.run(); } }, ADMIN_PASSWORD: 'pw', ENCRYPTION_KEY: 'k',
  BUCKET: { async get(k) { const m = /^t\/(\d+)\.webp$/.exec(k); const f = m && `${tmp}/site${+m[1] - 500}.webp`; return f && fs.existsSync(f) ? { body: fs.readFileSync(f), httpMetadata: { contentType: 'image/webp' } } : null; } },
  ASSETS: { fetch: async () => new Response('x') },
};
db.prepare("INSERT INTO accounts (nsid, token_enc, token_secret_enc) VALUES ('1@N1','x','y')").run();
for (let i = 0; i < 6; i++) db.prepare("INSERT INTO photos (id, account_id, title, status, is_public, synced_at) VALUES (?, 1, ?, 'ok', 1, 1)").run(String(500 + i), 'site ' + i);

const cdn = http.createServer((req, res) => { const f = `${tmp}${req.url}`; if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(fs.readFileSync(f)); });
await new Promise(r => cdn.listen(0, '127.0.0.1', r));
const cdnBase = `http://127.0.0.1:${cdn.address().port}`;
const igRows = [['8000', 'ig0.jpg'], ['8001', 'ig1.jpg'], ['8002', 'ig2.jpg'], ['8003', 'ig3.jpg'], ['8009', 'ig9.jpg']];
for (const [id, f] of igRows) db.prepare("INSERT INTO ig_media (id, post_id, media_type, ts, seen_at, media_url) VALUES (?, ?, 'IMAGE', 1700000000, 1, ?)").run(id, id, `${cdnBase}/${f}`);

const { default: worker } = await import(root + '/src/index.js');
const site = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const b = Buffer.concat(chunks);
  const r = await worker.fetch(new Request('http://127.0.0.1' + req.url, { method: req.method, headers: req.headers, body: b.length ? b : undefined }), env, {});
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;
const { token } = await (await fetch(base + '/api/admin/tokens', { method: 'POST', headers: { authorization: 'Basic ' + btoa('admin:pw'), 'content-type': 'application/json' }, body: '{}' })).json();

Object.assign(process.env, { AERIAL_TOKEN: token, AERIAL_SERVER: base, TSP_IG_PYTHON: 'python3', TSP_IG_MODEL: 'hist', TSP_IG_DIR: tmp + '/work' });
const igm = await import(root + '/tools/Aerial Uploader.app/Contents/Resources/ig-match.mjs');
const lines = [];
const ctx = { log: (t) => lines.push(t), step: () => {}, stopped: () => false };
const r1 = await igm.runMatch(ctx);
const links = db.prepare("SELECT ig_id, photo_id, status, inliers FROM ig_links WHERE rank = 0 ORDER BY ig_id").all();
const best = Object.fromEntries(links.map(l => [l.ig_id, l]));
ok(r1.checked === 5, `all 5 Instagram images checked (${lines.at(-1)})`);
ok(['8000', '8001', '8002', '8003'].every((id, i) => best[id]?.photo_id === String(500 + i) && best[id].status === 'auto'),
  `cropped / desaturated Instagram versions matched to the right site photo (${links.map(l => `${l.ig_id}→${l.photo_id} ${l.status} ${l.inliers}`).join(', ')})`);
ok(!best['8009'], 'a post that isn\'t on the site stays unmatched');
const r2 = await igm.runMatch(ctx);
ok(r2.checked === 0, 'second run: nothing new to check (and the site photos come from the local cache)');
ok(fs.readdirSync(tmp + '/work/site').length === 6, 'site photos cached locally');
site.close(); cdn.close();
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
