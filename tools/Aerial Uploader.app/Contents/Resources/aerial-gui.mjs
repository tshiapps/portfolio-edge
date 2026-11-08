// Aerial Uploader — a small local app: native Finder file chooser, per-clip trim/crop/title,
// Compress & Upload button and a live log. Serves its window on 127.0.0.1 only, guarded by a
// random per-launch key; quits on its own ~10 minutes after the window is closed.
import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from './aerial-core.mjs';
import * as photos from './photo-fetch.mjs';
import * as igm from './ig-match.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(path.dirname(core.CONF_FILE), 'aerial-app.json');
const IDLE_EXIT_MS = 10 * 60 * 1000;

// ---------- single instance ----------
// If this same build is already running, bring its window back. If an older build (or a copy elsewhere)
// is running, ask it to quit and start fresh — otherwise an outdated window would keep getting reused.
const BUILD = `${HERE}|${fs.statSync(fileURLToPath(import.meta.url)).mtimeMs}|${fs.statSync(path.join(HERE, 'aerial-gui.html')).mtimeMs}`;
console.log(`${new Date().toISOString()} launch from ${HERE}`);
try {
  const prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const base = `http://127.0.0.1:${prev.port}`;
  const res = await fetch(`${base}/api/ping?k=${prev.key}`, { signal: AbortSignal.timeout(800) });
  if (res.ok) {
    const info = await res.json().catch(() => ({}));
    if (info.build === BUILD) {
      console.log('already running — reopening its window');
      openWindow(`${base}/?k=${prev.key}`);
      setTimeout(() => process.exit(0), 3000); // don't vanish instantly (macOS complains about that)
      await new Promise(() => {});
    }
    console.log('an older copy is running — asking it to quit');
    await fetch(`${base}/api/quit`, { method: 'POST', headers: { 'x-k': prev.key }, signal: AbortSignal.timeout(2000) }).catch(() => {});
    await new Promise(r => setTimeout(r, 600));
  }
} catch { /* not running */ }

const KEY = randomBytes(16).toString('hex');
const files = [];          // { id, path, name, info, title, start, end, crop, status, progress, error, result }
const logLines = [];
const clients = new Set();
let busy = false;
let lastSeen = Date.now();

function emit(type, data) {
  const msg = `data: ${JSON.stringify({ type, data })}\n\n`;
  for (const c of clients) c.write(msg);
}
function log(text, level = 'info') {
  const line = { t: Date.now(), text, level };
  logLines.push(line); if (logLines.length > 1000) logLines.shift();
  emit('log', line);
}
const pub = f => ({ ...f });
process.on('exit', () => { for (const f of files) { try { fs.rmSync(proxyFile(f) + '.part.mp4', { force: true }); } catch {} } });
const pending = new Map();
function emitFile(f, throttle = false) {
  if (!throttle) return emit('file', pub(f));
  if (pending.has(f.id)) return;
  pending.set(f.id, setTimeout(() => { pending.delete(f.id); emit('file', pub(f)); }, 250));
}
const state = () => ({
  server: core.server(), account: core.account(), loggedIn: !!core.getToken({ optional: true }),
  ffmpeg: core.ffmpegStatus(), files: files.map(pub), busy, log: logLines.slice(-300),
});

function addPaths(paths) {
  const added = [];
  for (const p of paths) {
    if (!p || files.some(f => f.path === p && f.status !== 'done')) continue;
    const f = { id: randomBytes(4).toString('hex'), path: p, name: path.basename(p), title: path.basename(p, path.extname(p)),
      start: '', end: '', crop: 'none', status: 'ready', progress: { desktop: 0, mobile: 0, upload: 0 } };
    try { f.info = core.probe(p); } catch (e) { f.status = 'error'; f.error = e.message; }
    f.preview = f.info && core.browserPlayable(f.info) ? 'source' : 'proxy';
    files.push(f); added.push(f); emitFile(f);
    if (f.preview === 'proxy') wantProxy(f);
  }
  if (added.length) log(`Added ${added.length} file${added.length > 1 ? 's' : ''}: ${added.map(f => f.name).join(', ')}`);
  return added;
}

function chooseFiles() {
  const script = [
    'activate',
    'set f to choose file with prompt "Choose aerial clips" of type {"public.movie"} with multiple selections allowed',
    'set out to ""',
    'repeat with x in f', 'set out to out & POSIX path of x & linefeed', 'end repeat',
    'return out'];
  return new Promise(resolve => {
    const ch = spawn('osascript', script.flatMap(l => ['-e', l]));
    let out = '';
    ch.stdout.on('data', d => { out += d; });
    ch.on('error', () => resolve([]));
    ch.on('close', () => resolve(out.split('\n').map(s => s.trim()).filter(Boolean)));
  });
}

async function runUploads({ best, max }) {
  const queue = files.filter(f => f.status === 'ready' || f.status === 'error' && f.info);
  if (!queue.length) return;
  busy = true; emit('busy', true);
  log(`Starting ${queue.length} clip${queue.length > 1 ? 's' : ''}${best ? ' (best quality)' : ''}…`);
  let done = 0;
  for (const f of queue) {
    f.status = 'working'; f.error = null; f.progress = { desktop: 0, mobile: 0, upload: 0 }; emitFile(f);
    try {
      f.result = await core.processClip(f.path, { title: f.title, start: f.start, end: f.end, crop: f.crop, best, max },
        text => log(text), (stage, frac) => { f.progress[stage] = frac; emitFile(f, true); });
      f.status = 'done'; done++;
    } catch (e) {
      f.status = 'error'; f.error = e.message; log(`✗ ${f.name}: ${e.message}`, 'error');
    }
    emitFile(f);
  }
  log(`Finished: ${done} of ${queue.length} uploaded.`, done === queue.length ? 'ok' : 'error');
  busy = false; emit('busy', false);
}

// ---------- trim editor support: source/proxy streaming + filmstrip thumbnails ----------
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'aerial-app-'));
process.on('exit', () => { try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch {} });

function run(args) {
  return new Promise((resolve, reject) => {
    const ch = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    let err = ''; ch.stderr.on('data', d => { err += d; });
    ch.on('error', reject);
    ch.on('close', c => c === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || 'ffmpeg failed')));
  });
}

let slots = 3; const waiters = [];
async function limited(fn) {
  if (slots === 0) await new Promise(r => waiters.push(r));
  slots--;
  try { return await fn(); } finally { slots++; waiters.shift()?.(); }
}

const jobs = new Map(); // de-dupe concurrent generation of the same cache file
function cached(file, make) {
  if (fs.existsSync(file)) return Promise.resolve(file);
  if (!jobs.has(file)) jobs.set(file, limited(make).then(() => file).finally(() => jobs.delete(file)));
  return jobs.get(file);
}

const THUMBS = 12;
function thumb(f, n) {
  const at = Math.max(0, ((n + 0.5) / THUMBS) * (f.info?.duration || 0));
  return cached(path.join(CACHE, `${f.id}-t${n}.jpg`), () =>
    run(['-ss', at.toFixed(2), '-i', f.path, '-frames:v', '1', '-vf', 'scale=192:-2', '-q:v', '5', path.join(CACHE, `${f.id}-t${n}.jpg`)]));
}

// Low-res H.264 copy for files a browser can't play (ProRes, some HEVC), used only for the trim preview.
// Built one at a time in the background — started as soon as such a file is added — with progress events.
const proxyQueue = [];
let proxyBusy = false;
const proxyFile = f => path.join(CACHE, `${f.id}-proxy.mp4`);
function wantProxy(f) {
  if (!f.info || f.proxy === 'ready' || f.proxy === 'making' || f.proxy === 'queued') return;
  f.proxy = 'queued'; f.proxyFrac = 0; proxyQueue.push(f); emitFile(f); pumpProxies();
}
async function pumpProxies() {
  if (proxyBusy) return;
  const f = proxyQueue.shift();
  if (!f) return;
  proxyBusy = true; f.proxy = 'making'; emitFile(f);
  log(`Making a preview copy of ${f.name} for trimming…`);
  const tmp = proxyFile(f) + '.part.mp4';
  try {
    await core.ffmpeg([...core.HWDEC, '-i', f.path, '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', `scale=640:-2${f.info.fps > 31 ? ',fps=30' : ''},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-g', '15', '-movflags', '+faststart', tmp],
      frac => { f.proxyFrac = frac; emitFile(f, true); }, f.info.duration);
    fs.renameSync(tmp, proxyFile(f));
    f.proxy = 'ready'; f.proxyFrac = 1;
    log(`✓ Preview copy of ${f.name} ready`, 'ok');
  } catch (e) {
    f.proxy = 'failed'; log(`✗ Couldn't make a preview of ${f.name}: ${e.message}`, 'error');
  }
  emitFile(f);
  proxyBusy = false; pumpProxies();
}

function serveFile(req, res, file, type) {
  const size = fs.statSync(file).size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    let start = m[1] === '' ? size - +m[2] : +m[1];
    let end = m[1] !== '' && m[2] !== '' ? +m[2] : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start < 0) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size });
  fs.createReadStream(file).pipe(res);
}

const MIME = { '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4v': 'video/mp4' };

// ---------- Photos tab: full-size photo fetcher ----------
const P = { running: false, stop: false, stopFns: [], watch: false, stats: { done: 0, failed: 0, waiting: null, current: null }, log: [] };
const pstate = () => ({ running: P.running, watch: P.watch, stats: P.stats });
function plog(text, level = 'info') {
  const line = { t: Date.now(), text, level };
  P.log.push(line); if (P.log.length > 1000) P.log.shift();
  emit('plog', line);
  console.log(`${new Date().toISOString()} [photos] ${text}`); // → ~/Library/Logs/AerialUploader.log
}
async function startPhotos(watch) {
  if (P.running) return;
  Object.assign(P, { running: true, stop: false, watch, stopFns: [], stats: { done: 0, failed: 0, waiting: null, current: null } });
  emit('pstate', pstate());
  try {
    await photos.runFetcher({
      watch, pace: 2, log: plog,
      stopped: () => P.stop, onStop: fn => P.stopFns.push(fn),
      progress: st => { P.stats = { ...st }; emit('pstate', pstate()); },
    });
  } catch (e) { plog(`✗ ${e.message}`, 'error'); }
  finally { P.running = false; P.stopFns = []; emit('pstate', pstate()); }
}

// ---------- Instagram tab: match the site's photos with Instagram posts, on this Mac ----------
const I = { running: false, stop: false, stopFns: [], step: null, pct: null, log: [], last: null };
const istate = () => ({ running: I.running, step: I.step, pct: I.pct, ready: igm.ready(), last: I.last });
function ilog(text, level = 'info') {
  const line = { t: Date.now(), text, level };
  I.log.push(line); if (I.log.length > 1000) I.log.shift();
  emit('ilog', line);
  console.log(`${new Date().toISOString()} [instagram] ${text}`);
}
async function startIg(all, source = 'ig') {
  if (I.running) return;
  Object.assign(I, { running: true, stop: false, stopFns: [], step: 'Starting…', pct: null });
  emit('istate', istate());
  let lastEmit = 0;
  try {
    I.last = await (source === 'getty' ? igm.runGetty : igm.runMatch)({
      log: ilog, stopped: () => I.stop, onStop: fn => I.stopFns.push(fn),
      step: (text, pct) => { I.step = text; I.pct = pct; const t = Date.now(); if (t - lastEmit > 300 || pct === 100) { lastEmit = t; emit('istate', istate()); } },
    }, { all }) || I.last;
  } catch (e) { ilog(I.stop ? 'Stopped.' : `✗ ${e.message}`, I.stop ? 'info' : 'error'); }
  finally { Object.assign(I, { running: false, stopFns: [], step: null, pct: null }); emit('istate', istate()); }
}

// ---------- HTTP ----------
// ---------- Featured tab: press / publication images, cropped in the window, uploaded as JPEG ----------
const featFiles = new Map(); // id → { id, path, name, view }
const VIEWABLE = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
function chooseImages() {
  const script = [
    'activate',
    'set f to choose file with prompt "Choose screenshots, covers or clippings" of type {"public.image"} with multiple selections allowed',
    'set out to ""', 'repeat with x in f', 'set out to out & POSIX path of x & linefeed', 'end repeat', 'return out'];
  return new Promise(resolve => {
    const ch = spawn('osascript', script.flatMap(l => ['-e', l]));
    let out = '';
    ch.stdout.on('data', d => { out += d; });
    ch.on('error', () => resolve([]));
    ch.on('close', () => resolve(out.split('\n').map(s => s.trim()).filter(Boolean)));
  });
}
// the window can't show HEIC / TIFF etc. — convert those once with macOS's own sips
async function viewable(f) {
  const ext = path.extname(f.path).toLowerCase();
  if (VIEWABLE[ext]) return { file: f.path, type: VIEWABLE[ext] };
  if (!f.view || !fs.existsSync(f.view)) {
    const out = path.join(os.tmpdir(), `tsp-feat-${f.id}.jpg`);
    await new Promise((res, rej) => {
      const ch = spawn('sips', ['-s', 'format', 'jpeg', f.path, '--out', out]);
      ch.on('error', rej); ch.on('close', c => (c === 0 ? res() : rej(new Error(`couldn't open ${f.name}`))));
    });
    f.view = out;
  }
  return { file: f.view, type: 'image/jpeg' };
}
// a whole folder: every image in it (not sub-folders), in name order
const IMAGE_EXT = /\.(jpe?g|png|heic|heif|webp|tiff?|gif|bmp)$/i;
function chooseFolder() {
  const script = ['activate', 'set f to choose folder with prompt "Choose a folder of screenshots / covers"', 'return POSIX path of f'];
  return new Promise(resolve => {
    const ch = spawn('osascript', script.flatMap(l => ['-e', l]));
    let out = '';
    ch.stdout.on('data', d => { out += d; });
    ch.on('error', () => resolve(null));
    ch.on('close', () => resolve(out.trim() || null));
  });
}
// remembers what was already uploaded (by file path + size + date), so re-opening a folder skips those
const FEAT_DONE_FILE = path.join(path.dirname(core.CONF_FILE), 'featured-uploaded.json');
const featDone = (() => { try { return JSON.parse(fs.readFileSync(FEAT_DONE_FILE, 'utf8')); } catch { return {}; } })();
const featKey = fp => { try { const st = fs.statSync(fp); return `${fp}|${st.size}|${Math.round(st.mtimeMs)}`; } catch { return fp; } };
function markFeatDone(fp, id) {
  featDone[featKey(fp)] = { id, at: Date.now() };
  try { fs.mkdirSync(path.dirname(FEAT_DONE_FILE), { recursive: true }); fs.writeFileSync(FEAT_DONE_FILE, JSON.stringify(featDone)); } catch {}
}
const featItem = fp => {
  const f = { id: randomBytes(4).toString('hex'), path: fp, name: path.basename(fp) };
  featFiles.set(f.id, f);
  return { id: f.id, name: f.name, uploaded: !!featDone[featKey(fp)] };
};

async function rawBody(req, max) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw new Error('image too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}

async function body(req) {
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return {}; }
}
function send(res, status, data, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}

const srv = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if ((req.headers['x-k'] || url.searchParams.get('k')) !== KEY) return send(res, 403, { error: 'forbidden' });
  lastSeen = Date.now();
  const p = url.pathname, m = req.method;
  let r;
  try {
    if (p === '/' && m === 'GET') return send(res, 200, fs.readFileSync(path.join(HERE, 'aerial-gui.html')), 'text/html; charset=utf-8');
    if (p === '/api/ping') return send(res, 200, { ok: true, build: BUILD });
    if (p === '/api/state') return send(res, 200, state());
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': hi\n\n'); clients.add(res);
      req.on('close', () => { clients.delete(res); lastSeen = Date.now(); scheduleQuitIfClosed(); });
      return;
    }
    if (p === '/api/choose' && m === 'POST') return send(res, 200, { added: addPaths(await chooseFiles()).length });
    if (p === '/api/add' && m === 'POST') return send(res, 200, { added: addPaths((await body(req)).paths || []).length });
    if ((r = p.match(/^\/api\/files\/([0-9a-f]+)\/(source|proxy|thumb\/(\d+))$/)) && m === 'GET') {
      const f = files.find(x => x.id === r[1]);
      if (!f || !f.info) return send(res, 404, { error: 'not found' });
      if (r[2] === 'source') return serveFile(req, res, f.path, MIME[path.extname(f.path).toLowerCase()] || 'video/mp4');
      if (r[2] === 'proxy') {
        if (f.proxy !== 'ready') return send(res, 409, { error: 'preview not ready' });
        return serveFile(req, res, proxyFile(f), 'video/mp4');
      }
      const n = +r[3];
      if (!(n >= 0 && n < THUMBS)) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' });
      return res.end(fs.readFileSync(await thumb(f, n)));
    }
    if ((r = p.match(/^\/api\/files\/([0-9a-f]+)\/need-proxy$/)) && m === 'POST') {
      // the window found the original won't decode (black/blank video) — switch this file to a preview copy
      const f = files.find(x => x.id === r[1]);
      if (!f) return send(res, 404, { error: 'not found' });
      f.preview = 'proxy'; wantProxy(f); emitFile(f);
      return send(res, 200, { ok: true });
    }
    if ((r = p.match(/^\/api\/files\/([0-9a-f]+)$/))) {
      const f = files.find(x => x.id === r[1]);
      if (!f) return send(res, 404, { error: 'not found' });
      if (m === 'DELETE') { if (f.status === 'working') return send(res, 409, { error: 'busy' }); files.splice(files.indexOf(f), 1); emit('removed', f.id); return send(res, 200, { ok: true }); }
      if (m === 'PATCH') {
        const b = await body(req);
        for (const k of ['title', 'start', 'end', 'crop']) if (b[k] !== undefined) f[k] = String(b[k]);
        if (f.status === 'done') f.status = 'ready'; // editing a finished row means "upload again"
        try { core.parseTime(f.start); core.parseTime(f.end); f.error = f.info ? null : f.error; } catch (e) { f.error = e.message; }
        emitFile(f); return send(res, 200, { ok: true });
      }
    }
    if (p === '/api/clear-done' && m === 'POST') {
      for (let i = files.length - 1; i >= 0; i--) if (files[i].status === 'done') { emit('removed', files[i].id); files.splice(i, 1); }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/login' && m === 'POST') {
      const b = await body(req);
      if (b.server) core.saveServer(b.server);
      const clips = await core.saveToken(String(b.token || '').trim());
      log(`✓ Logged in to ${core.account()} — ${clips.filter(c => c.status === 'ready').length} clip(s) on the site`, 'ok');
      return send(res, 200, state());
    }
    if (p === '/api/upload' && m === 'POST') {
      if (busy) return send(res, 409, { error: 'Already working' });
      if (core.ffmpegStatus()) return send(res, 400, { error: core.ffmpegStatus() });
      if (!core.getToken({ optional: true })) return send(res, 400, { error: 'Log in first (paste an upload token).' });
      const b = await body(req);
      runUploads({ best: !!b.best, max: +b.max || 20 });
      return send(res, 200, { started: true });
    }
    if (p === '/api/clips' && m === 'GET') return send(res, 200, await core.api('GET', '/media'));
    if (p === '/api/photos' && m === 'GET') {
      let remote = null;
      if (core.getToken({ optional: true })) remote = await photos.status().catch(e => ({ error: e.message }));
      return send(res, 200, { ...pstate(), remote, log: P.log.slice(-300) });
    }
    if (p === '/api/photos/start' && m === 'POST') {
      if (core.ffmpegStatus()) return send(res, 400, { error: core.ffmpegStatus() });
      if (!core.getToken({ optional: true })) return send(res, 400, { error: 'Log in first (paste an upload token).' });
      startPhotos(!!(await body(req)).watch);
      return send(res, 200, { started: true });
    }
    if (p === '/api/photos/stop' && m === 'POST') {
      P.stop = true; P.stopFns.splice(0).forEach(f => f());
      plog('Stopping after the current photo…');
      return send(res, 200, { ok: true });
    }
    if (p === '/api/ig' && m === 'GET') {
      let remote = null;
      if (core.getToken({ optional: true })) {
        const [a, g] = await Promise.all([
          core.api('GET', '/media/ig/input').then(d => ({ photos: d.photos.length, ig: d.ig.length, unchecked: d.ig.filter(x => !x.matched_at).length })).catch(e => ({ error: e.message })),
          core.api('GET', '/media/getty/input').then(d => ({ getty: d.assets.length, unchecked: d.assets.filter(x => !x.matched_at && !x.linked).length })).catch(() => null),
        ]);
        remote = { ...a, gettyAssets: g?.getty ?? null, gettyUnchecked: g?.unchecked ?? null };
      }
      return send(res, 200, { ...istate(), remote, admin: core.server() + '/admin/#instagram', adminGetty: core.server() + '/admin/#gettymatch', log: I.log.slice(-300) });
    }
    if (p === '/api/ig/start' && m === 'POST') {
      if (!core.getToken({ optional: true })) return send(res, 400, { error: 'Log in first (paste an upload token).' });
      const b = await body(req);
      startIg(!!b.all, b.source === 'getty' ? 'getty' : 'ig');
      return send(res, 200, { started: true });
    }
    if (p === '/api/ig/stop' && m === 'POST') {
      I.stop = true; I.stopFns.splice(0).forEach(f => f()); ilog('Stopping…');
      return send(res, 200, { ok: true });
    }
    if (p === '/api/feat/choose' && m === 'POST') {
      const items = (await chooseImages()).map(featItem);
      if (items.length) log(`★ Featured: picked ${items.length} image${items.length > 1 ? 's' : ''}`);
      return send(res, 200, { items });
    }
    if (p === '/api/feat/choose-folder' && m === 'POST') {
      const dir = await chooseFolder();
      if (!dir) return send(res, 200, { items: [] });
      const names = fs.readdirSync(dir).filter(n => IMAGE_EXT.test(n) && !n.startsWith('.'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      const items = names.map(n => featItem(path.join(dir, n)));
      const already = items.filter(i => i.uploaded).length;
      log(`★ Featured: ${path.basename(dir.replace(/\/$/, ''))} — ${items.length} image${items.length === 1 ? '' : 's'}${already ? ` (${already} uploaded before)` : ''}`);
      return send(res, 200, { items, folder: dir });
    }
    if ((r = p.match(/^\/api\/feat\/file\/([0-9a-f]+)$/)) && m === 'GET') {
      const f = featFiles.get(r[1]);
      if (!f) return send(res, 404, { error: 'not found' });
      const v = await viewable(f);
      return serveFile(req, res, v.file, v.type);
    }
    if (p === '/api/feat/upload' && m === 'POST') {
      let meta = {};
      try { meta = JSON.parse(decodeURIComponent(req.headers['x-meta'] || '%7B%7D')); } catch {}
      const buf = await rawBody(req, 20e6);
      const { id } = await core.api('POST', '/media/features', { title: meta.title, caption: meta.caption, url: meta.url, fit: meta.fit });
      await core.api('PUT', `/media/features/${id}/image?w=${meta.w | 0}&h=${meta.h | 0}`, buf, 'image/jpeg');
      if (featFiles.get(meta.fid)) markFeatDone(featFiles.get(meta.fid).path, id);
      log(`★ Featured: uploaded “${meta.title || meta.name || id}” — ${meta.w}×${meta.h}, ${core.mb(buf.length)}`, 'ok');
      return send(res, 200, { ok: true, id });
    }
    if (p === '/api/feat/list' && m === 'GET') {
      const d = await core.api('GET', '/media/features');
      return send(res, 200, { shown: d.shown, features: d.features.map(f => ({ ...f, src: core.server() + f.src })), admin: core.server() + '/admin/#featured' });
    }
    if (p === '/api/quit' && m === 'POST') { send(res, 200, { ok: true }); setTimeout(() => process.exit(0), 100); return; }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

srv.listen(+process.env.AERIAL_GUI_PORT || 0, '127.0.0.1', () => {
  const port = srv.address().port;
  const url = `http://127.0.0.1:${port}/?k=${KEY}`;
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ port, key: KEY, pid: process.pid }));
  console.log(`Aerial Uploader running at ${url}`);
  openWindow(url);
});

// Closing the window quits the app: a few seconds' grace (page reloads reconnect), and if a video upload or
// the photo fetcher is still working, the app finishes that first and then quits.
const CLOSE_GRACE_MS = +process.env.AERIAL_CLOSE_GRACE_MS || 8000;
let quitTimer = null;
function scheduleQuitIfClosed() {
  clearTimeout(quitTimer);
  quitTimer = setTimeout(() => {
    if (clients.size) return;
    if (busy || P.running) return scheduleQuitIfClosed(); // check again after the work
    console.log(`${new Date().toISOString()} window closed — quitting`);
    process.exit(0);
  }, CLOSE_GRACE_MS);
}
setInterval(() => {
  if (!busy && !P.running && !clients.size && Date.now() - lastSeen > IDLE_EXIT_MS) process.exit(0);
}, 30_000).unref?.();

function openWindow(url) {
  if (process.env.AERIAL_NO_OPEN) return;
  const chrome = '/Applications/Google Chrome.app';
  const args = fs.existsSync(chrome)
    ? ['-na', 'Google Chrome', '--args', `--app=${url}`, '--window-size=980,860']
    : [url];
  spawn('open', args, { stdio: 'ignore', detached: true }).unref();
}
