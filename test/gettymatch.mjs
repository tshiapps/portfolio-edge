// Getty portfolio + matching: DeepMeta CSV import (quoted commas/newlines, two accounts, video, Flickr-ID file
// names), re-import diffing (unchanged / changed / gone / back / partial), review decisions, photo details, and
// the Mac matcher end to end on watermarked, recompressed ~600 px Getty-style previews (light "hist" model).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const ok = (c, m) => { console.log((c ? 'ok  - ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };

const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(root + '/migrations').sort()) db.exec(fs.readFileSync(root + '/migrations/' + f, 'utf8'));
const norm = a => a.map(v => (v === undefined ? null : v));
class S { constructor(q, a = []) { this.q = q; this.a = a; } bind(...a) { return new S(this.q, a); }
  async run() { const r = db.prepare(this.q).run(...norm(this.a)); return { meta: { changes: Number(r.changes) } }; }
  async all() { return { results: db.prepare(this.q).all(...norm(this.a)).map(r => ({ ...r })) }; }
  async first() { const r = db.prepare(this.q).get(...norm(this.a)); return r ? { ...r } : null; } }
const tmp = fs.mkdtempSync(os.tmpdir() + '/gm-');
const env = {
  DB: { prepare: q => new S(q), async batch(st) { for (const x of st) await x.run(); } }, ADMIN_PASSWORD: 'pw', ENCRYPTION_KEY: 'k',
  BUCKET: { async get(k) { const m = /^t\/(\d+)\.webp$/.exec(k); const f = m && `${tmp}/site${+m[1] - 500}.webp`; return f && fs.existsSync(f) ? { body: fs.readFileSync(f), httpMetadata: { contentType: 'image/webp' } } : null; } },
  ASSETS: { fetch: async () => new Response('x') },
};
db.prepare("INSERT INTO accounts (nsid, token_enc, token_secret_enc) VALUES ('1@N1','x','y')").run();
for (let i = 0; i < 6; i++) db.prepare("INSERT INTO photos (id, account_id, title, status, is_public, synced_at) VALUES (?, 1, ?, 'ok', 1, 1)").run(String(500 + i), 'site ' + i);
db.prepare("INSERT INTO photos (id, account_id, title, status, is_public, synced_at) VALUES ('5871998996', 1, 'flickr era', 'ok', 1, 1)").run();

const { default: worker } = await import(root + '/src/index.js');
const go = (p, init = {}) => worker.fetch(new Request('https://x' + p, { ...init, headers: { authorization: 'Basic ' + btoa('admin:pw'), 'content-type': 'application/json' } }), env, { waitUntil() {} });
const J = async (p, body) => (await go('/api/admin' + p, { method: body ? 'POST' : 'GET', body: body && JSON.stringify(body) })).json();

// ---------- CSV import ----------
const HEAD = 'Account type,Artist,Id,iStock id,Title,Description,Type,Is video,Copyright,Object name,Orientation,Model released,Property released,Has color,Editorial use,Width,Height,Created at,Submitted at,Collection id,Collection name,Collection code,iStock collection,S+,Country id,City,State province,License model,Clip length,Shot speed,Mastered to,Referral destinations,Keywords,Deactivated';
const row = (artist, id, title, obj, type = 'Creative Photo', desc = 'A, "quoted" description\nwith a new line', video = false) =>
  `"Getty","${artist}","${id}",,"${title}","${desc.replace(/"/g, '""')}","${type}",${video},"TONY SHI","${obj}","Horizontal",false,false,true,false,6000,4000,2024-05-01T00:00:00.000Z,2024-06-01T10:00:00.000Z,520,"Moment","FKE",,false,"US","New York","NY","royaltyfree",,,,"https://www.gettyimages.com/detail/photo/x/${id}","Skyline, New York City, Night",false`;
const rowsA = [
  row('Tony Shi Photography', '9000', 'Site zero', 'DSC_0001.jpg'), row('Tony Shi Photography', '9001', 'Site one', 'dsc_9022_3_tonemapped.jpg'),
  row('Tony Shi Photography', '9002', 'Site two', 'a.jpg'), row('Tony Shi Photography', '9003', 'Site three', 'b.jpg'),
  row('Tony Shi Photography', '9009', 'Not on the site', 'c.jpg'), row('Tony Shi Photography', '9010', 'Flickr era', '5871998996.jpg'),
  row('Tony Shi Photography', '9011', 'Timelapse', 'v.mov', 'Creative Video', 'clip', true), row('He Shi', '107593201', 'Acela Express', '318d9785.jpg', 'Editorial Photo'),
];
const csv = r => [HEAD, ...r].join('\r\n') + '\r\n';
let im = await J('/getty/portfolio/import', { file: 'dm-portfolio-1.csv', text: csv(rowsA) });
ok(im.rows === 8 && im.added === 8 && im.videos === 1 && im.accounts['He Shi'] === 1, `first import: 8 assets from 2 accounts (${JSON.stringify(im)})`);
ok(db.prepare("SELECT description FROM getty_assets WHERE asset_id = '9000'").get().description === 'A, "quoted" description\nwith a new line', 'quoted commas, quotes and new lines parsed');
ok(db.prepare("SELECT photo_id FROM getty_assets WHERE asset_id = '9010'").get().photo_id === '5871998996', 'Flickr-ID file name → linked straight away');
im = await J('/getty/portfolio/import', { file: 'dm-portfolio-2.csv', text: csv(rowsA) });
ok(im.added === 0 && im.updated === 0 && im.unchanged === 8 && im.gone === 0, 'same export again: everything unchanged, nothing written');
const rowsB = rowsA.filter(r => !r.includes('"9003"')).map(r => r.replace('"Site two"', '"Site two (retitled)"'));
rowsB.push(row('Tony Shi Photography', '9012', 'Brand new', 'n.jpg'));
im = await J('/getty/portfolio/import', { file: 'dm-portfolio-3.csv', text: csv(rowsB) });
ok(im.added === 1 && im.updated === 1 && im.gone === 1 && im.unchanged === 6, `next export: 1 new, 1 changed, 1 gone (${JSON.stringify(im)})`);
ok(db.prepare("SELECT in_portfolio FROM getty_assets WHERE asset_id = '9003'").get().in_portfolio === 0, 'gone asset kept, marked as gone');
const rowsC = [...rowsA, row('Tony Shi Photography', '9012', 'Brand new', 'n.jpg')];
im = await J('/getty/portfolio/import', { file: 'dm-portfolio-4.csv', text: csv(rowsC) });
ok(im.back === 1 && im.updated === 1 && db.prepare("SELECT in_portfolio FROM getty_assets WHERE asset_id = '9003'").get().in_portfolio === 1, 'it comes back');
im = await J('/getty/portfolio/import', { file: 'partial.csv', text: csv(rowsC.slice(0, 2)) });
ok(im.partial && im.gone === 0 && /partial/i.test(im.note), `a much smaller export is treated as partial — nothing marked gone (${im.note})`);
ok((await go('/api/admin/getty/portfolio/import', { method: 'POST', body: JSON.stringify({ file: 'x.csv', text: 'a,b\n1,2' }) })).status === 400, 'a non-DeepMeta file is refused');
// sold-only knowledge from a statement + its Flickr file name
db.prepare("INSERT INTO getty_sales (royalty_month, asset_id, alt_name, royalty) VALUES ('2025-01', '107593201', '5871998996_abcdef1234_o.jpg', 12.5)").run();
const { resolveLinks } = await import(root + '/src/lib/gettyportfolio.js');
await resolveLinks(env);
ok(db.prepare("SELECT photo_id FROM getty_assets WHERE asset_id = '107593201'").get().photo_id === '5871998996', 'statement file names link too');

let st = await J('/getty/match/status');
ok(st.counts.portfolio === 9 && st.counts.videos === 1 && st.counts.matched === 2 && st.counts.unchecked === 6, `status (${JSON.stringify(st.counts)})`);

// ---------- matcher end to end (watermarked previews) ----------
const py = spawnSync('python3', ['-c', 'import cv2, PIL, numpy'], { encoding: 'utf8' });
if (py.status !== 0) { console.log('skip matcher — needs python3 with opencv, pillow, numpy'); }
else {
  const gen = spawnSync('python3', ['-c', `
import random, sys, numpy as np
T = sys.argv[1]
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont
def scene(seed):
    r = random.Random(seed); w, h = 1024, 683
    im = Image.fromarray((np.random.default_rng(seed).random((h, w, 3)) * 60 + r.randint(40, 150)).astype('uint8')).filter(ImageFilter.GaussianBlur(2))
    d = ImageDraw.Draw(im)
    for _ in range(90):
        x, y, s = r.randint(0, w), r.randint(0, h), r.randint(8, 90)
        c = tuple(r.randint(0, 255) for _ in range(3))
        [d.ellipse, d.rectangle][r.randint(0, 1)]((x, y, x + s, y + int(s * r.uniform(.4, 1.6))), fill=c, outline=(0, 0, 0))
    return im
def getty(im, edit):
    im = ImageEnhance.Brightness(im).enhance(edit[0]); im = ImageEnhance.Contrast(im).enhance(edit[1])
    W, H = im.size
    if edit[2]: im = im.crop((int(W * .06), int(H * .05), int(W * .97), H))   # Getty version cropped a little
    im = im.resize((612, int(612 * im.size[1] / im.size[0])))
    o = Image.new('RGBA', im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(o)
    w, h = im.size
    for k in range(5):  # translucent watermark: big text-like strokes across the middle
        d.text((w * .15 + k * 3, h * .42 + k * 2), 'gettyimages', fill=(255, 255, 255, 110), font_size=72)
    d.text((10, h - 22), 'Credit: Tony Shi Photography', fill=(255, 255, 255, 200), font_size=14)
    im = Image.alpha_composite(im.convert('RGBA'), o).convert('RGB')
    bar = Image.new('RGB', (w, h + 40), (255, 255, 255)); bar.paste(im, (0, 0))   # plain strip under the image
    return bar
for i in range(6): scene(i).save(f'{T}/site{i}.webp', quality=72)
for i, e in enumerate([(1.0, 1.0, False), (1.15, 1.2, True), (0.85, 1.1, False), (1.05, 0.9, True)]):
    getty(scene(i), e).save(f'{T}/g{9000 + i}.jpg', quality=75)
getty(scene(77), (1, 1, False)).save(f'{T}/g9009.jpg', quality=75)
getty(scene(5), (1, 1.05, False)).save(f'{T}/g9012.jpg', quality=75)
`, tmp], { encoding: 'utf8' });
  if (gen.status !== 0) { console.log(gen.stderr); process.exit(1); }
  const cdn = http.createServer((req, res) => { const f = `${tmp}${req.url}`; if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(fs.readFileSync(f)); });
  await new Promise(r => cdn.listen(0, '127.0.0.1', r));
  const cdnBase = `http://127.0.0.1:${cdn.address().port}`;
  for (const id of ['9000', '9001', '9002', '9003', '9009', '9012']) db.prepare('UPDATE getty_assets SET thumb_url = ? WHERE asset_id = ?').run(`${cdnBase}/g${id}.jpg`, id);
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
  const ctx = { log: t => lines.push(t), step: () => {}, stopped: () => false };
  const r1 = await igm.runGetty(ctx);
  const links = db.prepare("SELECT asset_id, photo_id, status, inliers FROM getty_links WHERE how = 'matcher' AND rank = 0 ORDER BY asset_id").all();
  const best = Object.fromEntries(links.map(l => [l.asset_id, l]));
  ok(r1.checked === 6, `6 unlinked Getty photos checked — video and file-name-linked ones skipped (${lines.at(-1)})`);
  ok(['9000', '9001', '9002', '9003'].every((id, i) => best[id]?.photo_id === String(500 + i) && best[id].status === 'auto'),
    `watermarked, re-edited, cropped 612 px previews matched to the right photo (${links.map(l => `${l.asset_id}→${l.photo_id} ${l.status} ${l.inliers}`).join(', ')})`);
  ok(best['9012']?.photo_id === '505', 'new asset from the latest export matched too');
  ok(!best['9009'], 'an asset that isn’t on the site stays unmatched');
  ok(db.prepare("SELECT photo_id FROM getty_assets WHERE asset_id = '9001'").get().photo_id === '501', 'resolved link stored on the asset');
  const det = await J('/photos/501');
  ok(det.getty?.[0]?.asset_id === '9001' && det.getty[0].how === 'matcher', 'photo details list its Getty asset');
  const r2 = await igm.runGetty(ctx);
  ok(r2.checked === 0, 'second run: nothing new to check');
  // next export brings a new asset → only that one gets checked
  im = await J('/getty/portfolio/import', { file: 'dm-portfolio-5.csv', text: csv([...rowsC, row('Tony Shi Photography', '9013', 'Newer', 'm.jpg')]) });
  db.prepare('UPDATE getty_assets SET thumb_url = ? WHERE asset_id = ?').run(`${cdnBase}/g9002.jpg`, '9013');
  const r3 = await igm.runGetty(ctx);
  ok(im.added === 1 && r3.checked === 1, `re-import + re-run: only the new asset is checked (${JSON.stringify(im)})`);
  // review decisions
  await J('/getty/match/decide', { asset_id: '9009', action: 'confirm', photo_id: '504' });
  ok(db.prepare("SELECT photo_id FROM getty_assets WHERE asset_id = '9009'").get().photo_id === '504', 'manual link from “Not on the site”');
  await J('/getty/match/decide', { asset_id: '9000', action: 'reject', photo_id: '500' });
  ok(!db.prepare("SELECT photo_id FROM getty_assets WHERE asset_id = '9000'").get().photo_id, 'rejecting the auto match unlinks it');
  const lst = await J('/getty/match/list?view=matched&q=Site');
  ok(lst.items.length >= 3 && lst.items.every(x => /site/i.test(x.title)), `review list with search (${lst.items.map(x => x.title).join(' | ')})`);
  st = await J('/getty/match/status');
  ok(st.confirmedBy.filename === 2 && st.confirmedBy.you === 1, `confirmed by file name / by you counted (${JSON.stringify(st.confirmedBy)})`);
  site.close(); cdn.close();
}
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
