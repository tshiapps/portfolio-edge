// Instagram matcher (Mac side): downloads the site's photos and the Instagram images into a local cache,
// runs ig_match.py (DINOv2 + SIFT on this Mac's GPU/CPU) and sends the pairs back to the site.
// First run sets up a private Python environment (~1.5 GB: PyTorch, transformers, OpenCV) — once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from './aerial-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASE = process.env.TSP_IG_DIR || (process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'TSP Uploader', 'instagram')
  : path.join(os.homedir(), '.cache', 'tsp-uploader', 'instagram'));
const VENV = path.join(BASE, 'venv');
const PKGS = ['torch', 'torchvision', 'transformers', 'opencv-python-headless', 'pillow', 'numpy'];
const SETUP_MARK = path.join(VENV, '.tsp-ready-1');
const vpy = () => path.join(VENV, 'bin', 'python3');

function findPython() {
  const c = ['/opt/homebrew/bin/python3.12', '/opt/homebrew/bin/python3.11', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python3'];
  for (const p of c) {
    const r = spawnSync(p, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
    if (r.status === 0) { const [a, b] = r.stdout.trim().split('.').map(Number); if (a === 3 && b >= 9) return { bin: p, ver: r.stdout.trim() }; }
  }
  return null;
}
export const ready = () => fs.existsSync(SETUP_MARK) || !!process.env.TSP_IG_PYTHON;

function run(cmd, args, ctx, onLine) {
  return new Promise((resolve, reject) => {
    const ch = spawn(cmd, args, { env: { ...process.env, PYTHONUNBUFFERED: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' } });
    ctx.onStop?.(() => ch.kill('SIGTERM'));
    let tail = '';
    const feed = d => { tail = (tail + d).slice(-4000); String(d).split('\n').forEach(l => l.trim() && onLine?.(l.trim())); };
    ch.stdout.on('data', feed); ch.stderr.on('data', feed);
    ch.on('error', reject);
    ch.on('close', code => (code === 0 ? resolve() : reject(new Error(ctx.stopped?.() ? 'stopped' : `${path.basename(cmd)} exited ${code}: ${tail.split('\n').slice(-4).join(' ')}`))));
  });
}

export async function setup(ctx) {
  if (ready()) return;
  const py = findPython();
  if (!py) throw new Error('Python 3.9+ not found — install it with: brew install python');
  fs.mkdirSync(BASE, { recursive: true });
  ctx.log(`Setting up the matcher (one time, ~1.5 GB) with Python ${py.ver}…`);
  ctx.step?.('Creating Python environment…', null);
  if (!fs.existsSync(vpy())) await run(py.bin, ['-m', 'venv', VENV], ctx);
  ctx.step?.('Installing PyTorch, transformers, OpenCV… (a few minutes)', null);
  await run(vpy(), ['-m', 'pip', 'install', '--upgrade', 'pip'], ctx);
  await run(vpy(), ['-m', 'pip', 'install', ...PKGS], ctx, l => { if (/^(Collecting|Successfully|Downloading)/.test(l)) ctx.step?.(l.slice(0, 110), null); });
  fs.writeFileSync(SETUP_MARK, new Date().toISOString());
  ctx.log('✓ Matcher ready', 'ok');
}

// download with the upload token (site images) or straight from Instagram's CDN, into the cache
async function download(url, file, auth) {
  const res = await fetch(url, { headers: auth ? { authorization: `Bearer ${core.getToken()}` } : {} });
  if (!res.ok) { res.body?.cancel(); const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) throw new Error('tiny response');
  fs.writeFileSync(file + '.part', buf); fs.renameSync(file + '.part', file);
}
async function pool(items, n, fn, ctx) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length && !ctx.stopped?.()) await fn(items[i++]); }));
}

export async function runMatch(ctx, { all = false } = {}) {
  await setup(ctx);
  if (ctx.stopped?.()) return;
  const dirs = { tsp: path.join(BASE, 'site'), ig: path.join(BASE, 'instagram-images'), cache: path.join(BASE, 'cache') };
  Object.values(dirs).forEach(d => fs.mkdirSync(d, { recursive: true }));
  ctx.step?.('Asking the site what to compare…', null);
  const inp = await core.api('GET', '/media/ig/input');
  const igTodo = inp.ig.filter(x => all || !x.matched_at);
  ctx.log(`${inp.photos.length} site photos · ${inp.ig.length} Instagram images (${igTodo.length} to check${all ? ', re-checking all' : ''})`);
  if (!igTodo.length) { ctx.log('Nothing new on Instagram to match.', 'ok'); return { checked: 0 }; }

  // 1. site photos (thumbnail copies, ~0.1 MB each; a replaced photo gets a new version number)
  const server = core.server();
  const tsp = inp.photos.map(p => ({ id: p.id, key: `${p.id}:${p.v || 0}`, path: path.join(dirs.tsp, `${p.id}_${p.v || 0}.img`) }));
  const needT = tsp.filter(t => !fs.existsSync(t.path));
  let done = 0, failedT = 0;
  await pool(needT, 8, async t => {
    try { await download(`${server}/api/admin/media/ig/photo/${t.id}`, t.path, true); } catch { failedT++; }
    if (++done % 25 === 0 || done === needT.length) ctx.step?.(`Downloading site photos ${done}/${needT.length}`, Math.round(done / needT.length * 100));
  }, ctx);
  if (needT.length) ctx.log(`Site photos: ${needT.length - failedT} downloaded${failedT ? `, ${failedT} unavailable` : ''} (${tsp.length - needT.length} already here)`);

  // 2. Instagram images: the CDN link from the last sync, else a fresh one through the site
  const igItems = igTodo.map(x => ({ id: x.id, key: x.id, path: path.join(dirs.ig, `${x.id}.img`), url: x.media_url }));
  const needI = igItems.filter(x => !fs.existsSync(x.path));
  done = 0; let failedI = 0;
  await pool(needI, 4, async x => {
    try { if (!x.url) throw new Error('no link'); await download(x.url, x.path, false); }
    catch { try { await download(`${server}/api/admin/media/ig/img/${x.id}`, x.path, true); } catch { failedI++; } }
    if (++done % 10 === 0 || done === needI.length) ctx.step?.(`Downloading Instagram images ${done}/${needI.length}`, Math.round(done / needI.length * 100));
  }, ctx);
  if (needI.length) ctx.log(`Instagram images: ${needI.length - failedI} downloaded${failedI ? `, ${failedI} failed (retried next run)` : ''}`);
  if (ctx.stopped?.()) return;

  // 3. match on this Mac
  const decided = {};
  for (const d of inp.decided) {
    const o = decided[d.ig_id] ??= { confirmed: null, rejected: [] };
    if (d.status === 'confirmed') o.confirmed = d.photo_id; else o.rejected.push(d.photo_id);
  }
  const manifest = path.join(BASE, 'manifest.json'), out = path.join(BASE, 'results.json');
  fs.writeFileSync(manifest, JSON.stringify({
    cache: dirs.cache, out, model: process.env.TSP_IG_MODEL || 'dinov2', hf_model: 'facebook/dinov2-base', decided,
    tsp: tsp.filter(t => fs.existsSync(t.path)), ig: igItems.filter(x => fs.existsSync(x.path)),
  }));
  const label = { 'embed-tsp': 'Reading site photos', 'embed-ig': 'Reading Instagram images', verify: 'Comparing' };
  await run(process.env.TSP_IG_PYTHON || vpy(), [path.join(HERE, 'ig_match.py'), manifest], ctx, l => {
    const m = /^P (\S+) (\d+) (\d+)$/.exec(l);
    if (m) return ctx.step?.(`${label[m[1]] || m[1]} ${m[2]}/${m[3]}`, Math.round(+m[2] / Math.max(1, +m[3]) * 100));
    if (l.startsWith('L ')) return ctx.log(l.slice(2));
    if (/error|Traceback/i.test(l)) ctx.log(l, 'warn');
  });
  if (ctx.stopped?.()) return;

  // 4. back to the site
  const { results } = JSON.parse(fs.readFileSync(out, 'utf8'));
  for (let i = 0; i < results.length; i += 200) {
    ctx.step?.(`Saving matches ${Math.min(i + 200, results.length)}/${results.length}`, Math.round(i / results.length * 100));
    await core.api('POST', '/media/ig/results', { results: results.slice(i, i + 200) });
  }
  const auto = results.filter(r => r.candidates[0]?.status === 'auto').length, review = results.filter(r => r.candidates[0]?.status === 'review').length;
  ctx.log(`✓ ${auto} matched · ${review} to review in admin → Instagram · ${results.length - auto - review} not on the site`, 'ok');
  return { checked: results.length, auto, review };
}

// ---------- Getty: same matcher, Getty's own preview images (watermarked) ----------
// Preview: the link the site already has; else Getty's official embed lookup (oEmbed, no key); else the public
// comp image. Fetched once per asset into the local cache, two at a time — this is your own portfolio, not a crawl.
async function gettyPreview(x) {
  const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };
  const get = async (url, file) => {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) { res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2000) throw new Error('tiny');
    fs.writeFileSync(file + '.part', buf); fs.renameSync(file + '.part', file);
  };
  if (x.thumb_url) { try { await get(x.thumb_url, x.path); return null; } catch {} }
  let found = null;
  try {
    const r = await fetch(`https://embed.gettyimages.com/oembed?url=${encodeURIComponent('http://gty.im/' + x.id)}`, { headers: { ...UA, accept: 'application/json' } });
    if (r.ok) { const d = await r.json(); if (d.thumbnail_url) { await get(d.thumbnail_url, x.path); found = d.thumbnail_url; } }
    else r.body?.cancel();
  } catch {}
  if (!found) await get(`https://media.gettyimages.com/id/${x.id}/photo/x.jpg?s=612x612`, x.path);
  return found;
}

export async function runGetty(ctx, { all = false } = {}) {
  await setup(ctx);
  if (ctx.stopped?.()) return;
  const dirs = { tsp: path.join(BASE, 'site'), ext: path.join(BASE, 'getty-images'), cache: path.join(BASE, 'cache') };
  Object.values(dirs).forEach(d => fs.mkdirSync(d, { recursive: true }));
  ctx.step?.('Asking the site what to compare…', null);
  const inp = await core.api('GET', '/media/getty/input');
  const todo = inp.assets.filter(x => all ? true : !x.matched_at && !x.linked);
  ctx.log(`${inp.photos.length} site photos · ${inp.assets.length} Getty photos (${todo.length} to check${all ? ', re-checking all' : ''}; ${inp.assets.filter(x => x.linked).length} already linked)`);
  if (!todo.length) { ctx.log('Nothing new on Getty to match.', 'ok'); return { checked: 0 }; }

  const server = core.server();
  const tsp = inp.photos.map(p => ({ id: p.id, key: `${p.id}:${p.v || 0}`, path: path.join(dirs.tsp, `${p.id}_${p.v || 0}.img`) }));
  const needT = tsp.filter(t => !fs.existsSync(t.path));
  let done = 0, failedT = 0;
  await pool(needT, 8, async t => {
    try { await download(`${server}/api/admin/media/ig/photo/${t.id}`, t.path, true); } catch { failedT++; }
    if (++done % 25 === 0 || done === needT.length) ctx.step?.(`Downloading site photos ${done}/${needT.length}`, Math.round(done / needT.length * 100));
  }, ctx);
  if (needT.length) ctx.log(`Site photos: ${needT.length - failedT} downloaded${failedT ? `, ${failedT} unavailable` : ''} (${tsp.length - needT.length} already here)`);

  const items = todo.map(x => ({ id: x.id, key: x.id, path: path.join(dirs.ext, `${x.id}.img`), thumb_url: x.thumb_url }));
  const needG = items.filter(x => !fs.existsSync(x.path));
  done = 0; let failedG = 0; const thumbs = [];
  await pool(needG, 2, async x => {
    try { const t = await gettyPreview(x); if (t) thumbs.push({ id: x.id, thumb_url: t }); } catch { failedG++; }
    if (++done % 10 === 0 || done === needG.length) ctx.step?.(`Downloading Getty previews ${done}/${needG.length}`, Math.round(done / needG.length * 100));
    await new Promise(r => setTimeout(r, 250)); // gentle
  }, ctx);
  if (needG.length) ctx.log(`Getty previews: ${needG.length - failedG} downloaded${failedG ? `, ${failedG} unavailable (retried next run)` : ''}`);
  for (let i = 0; i < thumbs.length; i += 400) await core.api('POST', '/media/getty/thumbs', { items: thumbs.slice(i, i + 400) }).catch(() => {});
  if (ctx.stopped?.()) return;

  const decided = {};
  for (const d of inp.decided) {
    const o = decided[d.asset_id] ??= { confirmed: null, rejected: [] };
    if (d.status === 'confirmed') o.confirmed = d.photo_id; else o.rejected.push(d.photo_id);
  }
  const manifest = path.join(BASE, 'manifest-getty.json'), out = path.join(BASE, 'results-getty.json');
  fs.writeFileSync(manifest, JSON.stringify({
    source: 'getty', cache: dirs.cache, out, model: process.env.TSP_IG_MODEL || 'dinov2', hf_model: 'facebook/dinov2-base', decided,
    tsp: tsp.filter(t => fs.existsSync(t.path)), ext: items.filter(x => fs.existsSync(x.path)),
  }));
  const label = { 'embed-tsp': 'Reading site photos', 'embed-getty': 'Reading Getty previews', verify: 'Comparing' };
  await run(process.env.TSP_IG_PYTHON || vpy(), [path.join(HERE, 'ig_match.py'), manifest], ctx, l => {
    const m = /^P (\S+) (\d+) (\d+)$/.exec(l);
    if (m) return ctx.step?.(`${label[m[1]] || m[1]} ${m[2]}/${m[3]}`, Math.round(+m[2] / Math.max(1, +m[3]) * 100));
    if (l.startsWith('L ')) return ctx.log(l.slice(2));
    if (/error|Traceback/i.test(l)) ctx.log(l, 'warn');
  });
  if (ctx.stopped?.()) return;

  const { results } = JSON.parse(fs.readFileSync(out, 'utf8'));
  for (let i = 0; i < results.length; i += 200) {
    ctx.step?.(`Saving matches ${Math.min(i + 200, results.length)}/${results.length}`, Math.round(i / results.length * 100));
    await core.api('POST', '/media/getty/results', { results: results.slice(i, i + 200) });
  }
  const auto = results.filter(r => r.candidates[0]?.status === 'auto').length, review = results.filter(r => r.candidates[0]?.status === 'review').length;
  ctx.log(`✓ ${auto} matched · ${review} to review in admin → Getty ↔ photos · ${results.length - auto - review} not on the site`, 'ok');
  return { checked: results.length, auto, review };
}
