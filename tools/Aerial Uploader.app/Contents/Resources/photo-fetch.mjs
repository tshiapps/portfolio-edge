// Photo fetcher engine (shared by the app's Photos tab and `npm run fetch`).
// Flickr won't serve full-size images to Cloudflare's shared servers, so this downloads them on your
// own connection, resizes them HERE with ffmpeg (same sizes/quality the site would use — no Cloudflare
// resizing fees, no 20 MB limit), and uploads the finished JPEG + WebP thumbnail.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as core from './aerial-core.mjs';

const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  referer: 'https://www.flickr.com/',
  accept: 'image/avif,image/webp,image/jpeg,*/*;q=0.8',
};
const sleep = (ms, stopper) => new Promise(r => {
  const t = setTimeout(r, ms);
  stopper?.onStop?.(() => { clearTimeout(t); r(); });
});
const mb = n => `${(n / 1e6).toFixed(1)} MB`;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const ch = spawn(cmd, args);
    let out = '', err = '';
    ch.stdout.on('data', d => { out += d; });
    ch.stderr.on('data', d => { err += d; });
    ch.on('error', reject);
    ch.on('close', c => c === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `${cmd} failed`)));
  });
}

async function dims(file) {
  const j = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file]));
  const s = j.streams?.[0] || {};
  return { w: +s.width || 0, h: +s.height || 0 };
}

// fit (w,h) inside box [W,H], never enlarging
const fit = (w, h, [W, H]) => { const f = Math.min(1, W / w, H / h); return [Math.max(1, Math.round(w * f)), Math.max(1, Math.round(h * f))]; };
// ffmpeg's JPEG scale (2 best … 31 worst) for a 0–100 "quality" like the site's setting (75 → 5)
const jpegQ = q => Math.max(2, Math.min(31, Math.round(2 + (100 - q) * 0.12)));
const ROTATE = { 90: ['transpose=1'], 180: ['hflip', 'vflip'], 270: ['transpose=2'] };

// Thumbnail format: WebP via ffmpeg if this ffmpeg has libwebp (Homebrew's current build doesn't), else the
// cwebp tool if installed (brew install webp), else JPEG — slightly larger, works everywhere.
let thumbFmt = null;
export async function thumbFormat() {
  if (thumbFmt) return thumbFmt;
  const enc = await run('ffmpeg', ['-hide_banner', '-encoders']).catch(() => '');
  const has = cmd => new Promise(r => spawn('which', [cmd]).on('close', c => r(c === 0)));
  if (!process.env.AERIAL_NO_WEBP && /\slibwebp\s/.test(enc)) thumbFmt = 'ffmpeg-webp';
  else if (!process.env.AERIAL_NO_WEBP && await has('cwebp')) thumbFmt = 'cwebp';
  else thumbFmt = 'jpeg';
  return thumbFmt;
}

// Resize one downloaded source into master JPEG + thumb, metadata stripped (no GPS leaks).
async function resize(src, dir, job, z) {
  let { w, h } = await dims(src);
  if (!w || !h) throw new Error('could not read the image');
  const rot = z.label === 'Original' ? ROTATE[job.rotation] || [] : []; // Flickr's own sizes are already rotated
  if (job.rotation === 90 || job.rotation === 270) { if (rot.length) [w, h] = [h, w]; }
  const [mw, mh] = fit(w, h, job.boxes.master);
  const [tw, th] = fit(mw, mh, job.boxes.thumb);
  const fmt = await thumbFormat();
  const master = path.join(dir, 'master.jpg'), thumb = path.join(dir, fmt === 'jpeg' ? 'thumb.jpg' : 'thumb.webp');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-map_metadata', '-1', '-frames:v', '1',
    '-vf', [...rot, `scale=${mw}:${mh}:flags=lanczos`, 'format=yuvj420p'].join(','), '-q:v', String(jpegQ(job.quality)), master]);
  if (fmt === 'ffmpeg-webp') {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', master, '-map_metadata', '-1', '-frames:v', '1',
      '-vf', `scale=${tw}:${th}:flags=lanczos`, '-c:v', 'libwebp', '-quality', String(job.thumbQuality), '-compression_level', '6', thumb]);
  } else if (fmt === 'cwebp') {
    await run('cwebp', ['-quiet', '-q', String(job.thumbQuality), '-resize', String(tw), String(th), '-metadata', 'none', master, '-o', thumb]);
  } else {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', master, '-map_metadata', '-1', '-frames:v', '1',
      '-vf', `scale=${tw}:${th}:flags=lanczos,format=yuvj420p`, '-q:v', String(jpegQ(job.thumbQuality)), thumb]);
  }
  // photos on the Aerial reel: an extra-large copy straight from the source (big, lower quality — it's on screen
  // for a few seconds, full-window, drifting). Sized to COVER a big 16:9 screen (cover = [width, height]), so a
  // panorama keeps enough height too; long edge capped; never enlarged.
  let reel = null, rw = 0, rh = 0;
  if (job.reel) {
    const [cw, ch] = job.reel.cover || job.reel.box || [6000, 3375];
    const f = Math.min(1, Math.max(cw / w, ch / h), (job.reel.maxLong || 12000) / Math.max(w, h));
    [rw, rh] = [Math.max(1, Math.round(w * f)), Math.max(1, Math.round(h * f))];
    reel = path.join(dir, 'reel.jpg');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-map_metadata', '-1', '-frames:v', '1',
      '-vf', [...rot, `scale=${rw}:${rh}:flags=lanczos`, 'format=yuvj420p'].join(','), '-q:v', String(jpegQ(job.reel.quality)), reel]);
  }
  return { master, thumb, thumbType: fmt === 'jpeg' ? 'image/jpeg' : 'image/webp', mw, mh, tw, th, reel, rw, rh };
}

// A giant original (30,000-px panoramas can be 100–300 MB) is slow to download and adds little: the site
// shows at most 8,000 px. If Flickr has a big enough sized copy (4K+), use that instead.
const HUGE_ORIGINAL = 80e6;

async function download(c, file, ctx, job) {
  let wait = 60_000, netFails = 0;
  for (let tryNo = 1; tryNo <= 6 && !ctx.stopped(); tryNo++) {
    let res;
    try { res = await fetch(c.url, { headers: HEADERS }); }
    catch (e) {
      if (++netFails <= 2) { ctx.log(`  network hiccup (${e.cause?.message || e.message}) — retrying`, 'warn'); await sleep(5000, ctx); continue; }
      return { error: `${c.label}: ${e.cause?.message || e.message}` };
    }
    if (res.status === 429) {
      res.body?.cancel();
      const ms = Math.max(wait, (+res.headers.get('retry-after') || 0) * 1000);
      ctx.log(`  Flickr says slow down (429) — waiting ${Math.round(ms / 1000)} s`, 'warn');
      await sleep(ms, ctx); wait = Math.min(wait * 2, 15 * 60_000);
      continue;
    }
    if (!res.ok) { res.body?.cancel(); return { error: `${c.label}: HTTP ${res.status}` }; }
    const total = +res.headers.get('content-length') || 0;
    if (c.label === 'Original' && total > HUGE_ORIGINAL && job?.candidates.some(x => x.label !== 'Original' && Math.max(x.width, x.height) >= 4096)) {
      res.body?.cancel();
      return { error: `Original is ${mb(total)} — using Flickr's large copy instead (much faster)`, skip: true };
    }
    let got = 0, lastPct = -1;
    const counter = new (await import('node:stream')).Transform({
      transform(chunk, _e, cb) {
        got += chunk.length;
        const pct = total ? Math.floor(got / total * 100) : null;
        if (pct !== lastPct) { lastPct = pct; ctx.step?.(`Downloading ${c.label}${total ? ` — ${pct}% of ${mb(total)}` : ` — ${mb(got)}`}`, pct); }
        cb(null, chunk);
      },
    });
    try { await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(file)); }
    catch (e) {
      // connection dropped mid-download (common on huge files): start that size again, twice at most
      if (++netFails <= 2) { ctx.log(`  download interrupted (${e.cause?.message || e.message}) — retrying`, 'warn'); await sleep(5000, ctx); continue; }
      return { error: `${c.label}: download kept failing (${e.cause?.message || e.message})` };
    }
    if (total && fs.statSync(file).size < total) {
      if (++netFails <= 2) { ctx.log('  download came back incomplete — retrying', 'warn'); continue; }
      return { error: `${c.label}: incomplete download` };
    }
    const size = fs.statSync(file).size;
    if (size < 2000) return { error: `${c.label}: tiny response` };
    return { size };
  }
  return { error: `${c.label}: still rate limited`, limited: true };
}

// One photo: try sizes best-first, resize locally, upload. Returns a summary line.
async function fetchOne(job, ctx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsp-photo-'));
  const tried = [];
  try {
    for (const c of job.candidates) {
      if (ctx.stopped()) throw new Error('stopped');
      ctx.step?.(`Downloading ${c.label} (${c.width}×${c.height})…`, 0);
      ctx.log(`  trying ${c.label} ${c.width}×${c.height}`);
      const src = path.join(dir, 'source' + (path.extname(new URL(c.url).pathname) || '.jpg'));
      const d = await download(c, src, ctx, job);
      if (d.error) { tried.push(d.error); ctx.log(`  ${d.error}`, d.skip ? 'info' : 'warn'); if (d.limited) break; continue; }
      if (c.label === 'Original' && job.bigW && job.bigH) {
        // An original whose orientation differs from how Flickr shows it (EXIF rotation) → use Flickr's sized copy.
        const { w, h } = await dims(src).catch(() => ({}));
        if (w && h && (w > h) !== (job.bigW > job.bigH) && !job.rotation) { tried.push('Original: orientation differs'); continue; }
      }
      ctx.log(`  downloaded ${c.label} — ${mb(d.size)}`);
      ctx.step?.('Resizing on this Mac…', null);
      let out;
      try { out = await resize(src, dir, job, c); }
      catch (e) {
        const { w, h } = await dims(src).catch(() => ({}));
        tried.push(`${c.label}: resize failed (${w || '?'}×${h || '?'}, ${mb(d.size)}): ${e.message}`);
        ctx.log(`  resize failed on ${c.label}: ${e.message} — trying the next size`, 'warn');
        continue; // a smaller Flickr size usually works
      }
      const mBuf = fs.readFileSync(out.master), tBuf = fs.readFileSync(out.thumb);
      ctx.log(`  resized → ${out.mw}×${out.mh} JPEG ${mb(mBuf.length)}, thumb ${out.tw}×${out.th} ${mb(tBuf.length)}`);
      ctx.step?.(`Uploading ${mb(mBuf.length + tBuf.length)}…`, null);
      await core.api('PUT', `/fetch/${job.id}/master`, mBuf, 'image/jpeg');
      await core.api('PUT', `/fetch/${job.id}/thumb`, tBuf, out.thumbType);
      let reelNote = '';
      if (out.reel) {
        const rBuf = fs.readFileSync(out.reel);
        ctx.log(`  Aerial reel copy → ${out.rw}×${out.rh} JPEG ${mb(rBuf.length)}`);
        await core.api('PUT', `/fetch/${job.id}/reel`, rBuf, 'image/jpeg');
        reelNote = ` + reel ${out.rw}×${out.rh}`;
      }
      await core.api('POST', `/fetch/${job.id}/done`, { label: c.label, source: { width: c.width, height: c.height }, master: { width: out.mw, height: out.mh }, thumb: { width: out.tw, height: out.th },
        ...(out.reel ? { reel: { width: out.rw, height: out.rh } } : {}) });
      return { ok: true, line: `${c.label} ${mb(d.size)} → ${out.mw}×${out.mh} (${mb(mBuf.length)}) + thumb ${out.tw}×${out.th}${reelNote}` };
    }
    throw new Error(tried.join('; ') || 'no sizes to try');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function status() { return core.api('GET', '/fetch/status'); }

// Work through the queue. ctx: { log(text, level), progress(stats), stopped(), onStop(fn), watch, pace }
export async function runFetcher(ctx) {
  const userStep = ctx.step;
  let lastEmit = 0;
  ctx.step = (text, pct) => {
    stats.step = text; stats.pct = pct;
    const t = Date.now();
    if (t - lastEmit > 250 || pct === 100 || pct === 0 || pct == null) { lastEmit = t; ctx.progress?.(stats); }
    userStep?.(text, pct);
  };
  const missing = core.ffmpegStatus();
  if (missing) throw new Error(missing);
  core.getToken();
  var stats = { done: 0, failed: 0, waiting: null, current: null, currentId: null, step: null, pct: null };
  ctx.progress?.(stats);
  ctx.log(`Photo fetcher started → ${core.server()}${ctx.watch ? ' (keeps watching)' : ''}`);
  const fmt = await thumbFormat();
  ctx.log(fmt === 'jpeg'
    ? 'Thumbnails: JPEG (your ffmpeg has no WebP encoder — fine; for ~30% smaller thumbnails: brew install webp)'
    : `Thumbnails: WebP (${fmt === 'cwebp' ? 'cwebp' : 'ffmpeg'})`);
  let first = true, prepWaits = 0;
  while (!ctx.stopped()) {
    // the first request after Start also retries photos cooling down from a failed attempt
    const q = await core.api('GET', `/fetch/queue?limit=5${first ? '&retry=1' : ''}`);
    first = false;
    stats.waiting = q.waiting; ctx.progress?.(stats);
    if (!q.photos.length && q.preparing && prepWaits < 16) {
      // just re-processed: the site hands photos over on its next run (every minute) — wait instead of quitting
      if (prepWaits === 0) ctx.log(`The site is still preparing ${q.preparing} photo(s) for the fetcher — they arrive within a minute or two. Waiting…`);
      prepWaits++;
      stats.step = `Waiting for the site to hand over ${q.preparing} photo(s)…`; stats.pct = null; ctx.progress?.(stats);
      await sleep(process.env.AERIAL_TEST_FAST ? 500 : 15_000, ctx);
      continue;
    }
    if (!q.photos.length) {
      if (q.waiting && q.nextRetryAt) {
        ctx.log(`${q.waiting} photo(s) still queued but being worked on elsewhere or cooling down until ${new Date(q.nextRetryAt * 1000).toLocaleTimeString()}.`, 'warn');
      }
      if (!ctx.watch) {
        if (!stats.done && !stats.failed && !q.waiting) {
          ctx.log(q.preparing
            ? `The site still has ${q.preparing} photo(s) it hasn't handed over — it may be retrying them itself. Tick "Keep running" or press Start again in a few minutes.`
            : 'Nothing waiting. Queue photos in the admin: Organizer → select → "Send to Mac fetcher".');
        }
        break;
      }
      ctx.log(`Nothing waiting — checking again in 5 min`);
      stats.step = 'Waiting for new photos…'; ctx.progress?.(stats);
      await sleep(300_000, ctx);
      continue;
    }
    for (const job of q.photos) {
      if (ctx.stopped()) break;
      stats.current = job.title || job.id; stats.currentId = job.id; stats.step = 'Starting…'; stats.pct = null; ctx.progress?.(stats);
      ctx.log(`▶ ${job.title ? `"${job.title}"` : job.id} (${job.id})`);
      if (job.error) { stats.failed++; ctx.log(`✗ ${job.id}: ${job.error}`, 'error'); continue; }
      try {
        const r = await fetchOne(job, ctx);
        stats.done++; stats.waiting = Math.max(0, (stats.waiting || 1) - 1);
        ctx.log(`✓ ${job.title ? `"${job.title.slice(0, 40)}" ` : job.id + ' '}${r.line}`, 'ok');
      } catch (e) {
        if (ctx.stopped()) break;
        stats.failed++;
        ctx.log(`✗ ${job.id}: ${e.message}`, 'error');
        await core.api('POST', `/fetch/${job.id}/release`, { error: e.message.slice(0, 400) }).catch(() => {});
      }
      stats.current = null; stats.currentId = null; stats.step = null; stats.pct = null; ctx.progress?.(stats);
      await sleep((ctx.pace ?? 2) * 1000, ctx);
    }
  }
  ctx.log(`Photo fetcher ${ctx.stopped() ? 'stopped' : 'finished'}: ${stats.done} stored${stats.failed ? `, ${stats.failed} failed (retried later)` : ''}.`, 'ok');
  return stats;
}
