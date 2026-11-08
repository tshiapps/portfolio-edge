// Shared logic for the aerial CLI and the Aerial Uploader app: config/Keychain, server API,
// ffmpeg probe + encode (async, with progress), and the full compress→upload pipeline.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KEYCHAIN_SERVICE = 'tonyshi-photos-aerial';
export const CONF_FILE = path.join(os.homedir(), '.config', 'tonyshi-photos', 'aerial.json');
export const DEFAULT_SERVER = 'https://tonyshi.photos';
export const PROFILES = {
  desktop: { w: 1920, h: 960, crf: 26, maxrate: '4M', bufsize: '8M' },
  mobile: { w: 960, h: 480, crf: 28, maxrate: '1500k', bufsize: '3M' },
};
const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084']);
// On a Mac, decode with VideoToolbox (Apple silicon has ProRes/HEVC hardware); ffmpeg falls back to software if it can't.
export const HWDEC = process.platform === 'darwin' ? ['-hwaccel', 'videotoolbox'] : [];

// Can a browser play this file directly? H.264 8-bit 4:2:0 always; HEVC usually on a Mac. ProRes etc. never.
export function browserPlayable(info) {
  if (!info) return false;
  if (info.codec === 'h264') return /^yuvj?420p$/.test(info.pixFmt);
  return info.codec === 'hevc';
}

export const mb = n => `${(n / 1e6).toFixed(1)} MB`;

// "14", "0:14", "1:02.5"; a leading "-" counts back from the end of the clip ("-5" = 5 s before the end).
export function parseTime(s) {
  if (s === undefined || s === null || String(s).trim() === '') return undefined;
  let str = String(s).trim();
  const neg = str.startsWith('-');
  if (neg) str = str.slice(1).trim();
  const parts = str.split(':').map(Number);
  if (!str || parts.some(n => !Number.isFinite(n) || n < 0)) throw new Error(`Can't read time "${s}" (use 14, 0:14, 1:02.5, or -5 for 5 s before the end)`);
  const t = parts.reduce((acc, n) => acc * 60 + n, 0);
  return neg ? -t : t;
}

// Resolves start/end (possibly negative = from the end) against the clip's duration.
export function resolveSegment(info, opts = {}) {
  const dur = info.duration || 0;
  const max = +(opts.max || 20);
  const rel = t => (t !== undefined && t < 0 ? Math.max(0, dur + t) : t);
  let start = rel(parseTime(opts.start));
  let end = rel(parseTime(opts.end));
  if (start === undefined) start = end !== undefined ? Math.max(0, end - max) : 0;
  if (end === undefined) end = Math.min(dur, start + max);
  end = Math.min(end, dur || end);
  return { start: +start.toFixed(3), end: +end.toFixed(3), length: +(end - start).toFixed(3) };
}

export function readConf() { try { return JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')); } catch { return {}; } }
export function saveServer(url) {
  fs.mkdirSync(path.dirname(CONF_FILE), { recursive: true });
  fs.writeFileSync(CONF_FILE, JSON.stringify({ ...readConf(), server: url.replace(/\/$/, '') }, null, 2));
}
export function server() { return (process.env.AERIAL_SERVER || readConf().server || DEFAULT_SERVER).replace(/\/$/, ''); }
export function account() { return new URL(server()).host; }

export function getToken({ optional = false } = {}) {
  if (process.env.AERIAL_TOKEN) return process.env.AERIAL_TOKEN;
  const r = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account(), '-w'], { encoding: 'utf8' });
  if (r.status !== 0 || r.error) { if (optional) return null; throw new Error(`No upload token saved for ${account()}. Log in first.`); }
  return r.stdout.trim();
}

export function isTokenShape(t) { return /^tsp_[0-9a-f]{48}$/.test(t || ''); }

// Verifies a token against the server, then stores it in the Keychain.
export async function saveToken(token) {
  if (!isTokenShape(token)) throw new Error("That doesn't look like an upload token (it starts with tsp_).");
  const { clips } = await api('GET', '/media', undefined, undefined, token);
  if (process.env.AERIAL_TOKEN) { process.env.AERIAL_TOKEN = token; return clips; } // test/script mode: no Keychain
  const s = spawnSync('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account(), '-w', token], { encoding: 'utf8' });
  if (s.status !== 0) throw new Error(`Couldn't save to Keychain: ${s.stderr || s.error?.message}`);
  return clips;
}

export async function api(method, p, body, contentType, token = getToken()) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined && !contentType) { headers['content-type'] = 'application/json'; body = JSON.stringify(body); }
  if (contentType) { headers['content-type'] = contentType; headers['content-length'] = String(body.length); }
  let res;
  try { res = await fetch(server() + '/api/admin' + p, { method, headers, body }); }
  catch (e) { throw new Error(`Can't reach ${server()}: ${e.cause?.message || e.message}`); }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: text.trim() }; }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${data.error || text.slice(0, 200)}`);
  return data;
}

export function ffmpegStatus() {
  const miss = ['ffmpeg', 'ffprobe'].filter(t => spawnSync('which', [t]).status !== 0);
  return miss.length ? `${miss.join(' and ')} not found — install with: brew install ffmpeg` : null;
}

export function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' });
  if (r.error) throw new Error(`ffprobe: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`Can't read ${path.basename(file)}: ${r.stderr.trim()}`);
  const j = JSON.parse(r.stdout);
  const v = j.streams.find(s => s.codec_type === 'video');
  if (!v) throw new Error(`${path.basename(file)} has no video track`);
  const [num, den] = String(v.avg_frame_rate || v.r_frame_rate || '30/1').split('/').map(Number);
  return {
    duration: +j.format.duration || +v.duration || 0,
    width: v.width, height: v.height, fps: den ? num / den : 30,
    hdr: HDR_TRANSFERS.has(v.color_transfer), transfer: v.color_transfer || 'unknown',
    size: +j.format.size || 0, codec: v.codec_name || '', pixFmt: v.pix_fmt || '',
  };
}

// crop: 'none' keeps the original shape (fit within the profile width, never upscaled);
// 'center' | 'top' | 'bottom' crop to a 2:1 band keeping that part of the frame.
function filterChain(p, info, crop = 'none') {
  let f;
  if (crop === 'none' || !crop) {
    f = [`scale='min(${p.w},iw)':-2:flags=lanczos`];
  } else {
    const y = { top: '0', bottom: `ih-${p.h}`, center: `(ih-${p.h})/2` }[crop];
    if (y === undefined) throw new Error('crop must be none, center, top or bottom');
    f = [`scale=${p.w}:${p.h}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${p.w}:${p.h}:(iw-${p.w})/2:${y}`];
  }
  if (info.fps > 31) f.push('fps=30');
  if (info.hdr) f.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709',
    'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
  f.push('format=yuv420p');
  return f.join(',');
}

export async function ffmpeg(args, onProgress, total) {
  try { return await runFfmpeg(args, onProgress, total); }
  catch (e) {
    // hardware decode not available for this file → same job in software
    if (args[0] !== '-hwaccel') throw e;
    return runFfmpeg(args.slice(2), onProgress, total);
  }
}

function runFfmpeg(args, onProgress, total) {
  return new Promise((resolve, reject) => {
    const ch = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y', ...args]);
    let err = '', buf = '';
    ch.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && onProgress && total) onProgress(Math.min(1, +m[1] / 1e6 / total));
      }
    });
    ch.stderr.on('data', d => { err += d; });
    ch.on('error', reject);
    ch.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.trim().split('\n').slice(-3).join(' ')}`)));
  });
}

function encode(src, out, p, info, seg, opts, onProgress) {
  return ffmpeg([...HWDEC, '-ss', String(seg.start), '-t', String(seg.length), '-i', src,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', filterChain(p, info, opts.crop || 'none'),
    '-c:v', 'libx264', '-preset', opts.best ? 'slow' : 'veryfast', '-crf', String(p.crf),
    '-maxrate', p.maxrate, '-bufsize', p.bufsize, '-profile:v', 'high',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-movflags', '+faststart', '-tag:v', 'avc1', out], onProgress, seg.length);
}

// Compress one source file and (unless opts.noUpload) upload it. log(text) gets human-readable steps,
// progress(stage, fraction) gets 0..1 progress for 'desktop' / 'mobile' / 'upload'.
export async function processClip(src, opts = {}, log = console.log, progress = () => {}) {
  if (!fs.existsSync(src)) throw new Error(`No such file: ${src}`);
  const info = probe(src);
  const seg = resolveSegment(info, opts);
  const end = seg.end;
  if (!(seg.length > 0)) throw new Error(`${path.basename(src)}: nothing between ${seg.start}s and ${seg.end}s`);
  const title = (opts.title || '').trim() || path.basename(src, path.extname(src));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aerial-'));
  log(`▶ ${path.basename(src)} — ${info.width}×${info.height}, ${info.fps.toFixed(0)} fps, using ${seg.start}s–${end.toFixed(1)}s` +
    (info.hdr ? ` (HDR ${info.transfer} → SDR)` : ''));
  if (/log/i.test(info.transfer)) log('  note: looks like log footage — colors will be flat unless graded first.');

  const out = { desktop: path.join(dir, 'desktop.mp4'), mobile: path.join(dir, 'mobile.mp4'), poster: path.join(dir, 'poster.jpg') };
  try {
    const band = opts.crop && opts.crop !== 'none';
    log(`  compressing desktop ${band ? '1920×960 (2:1 crop)' : 'up to 1920 wide, original shape'}…`);
    await encode(src, out.desktop, PROFILES.desktop, info, seg, opts, f => progress('desktop', f));
    log(`  compressing mobile ${band ? '960×480' : 'up to 960 wide'}…`);
    await encode(src, out.mobile, PROFILES.mobile, info, seg, opts, f => progress('mobile', f));
    await ffmpeg(['-ss', String(Math.min(1, seg.length / 2)), '-i', out.desktop, '-frames:v', '1', '-q:v', '4', out.poster]);
    const size = k => fs.statSync(out[k]).size;
    const sizes = { desktop: size('desktop'), mobile: size('mobile'), poster: size('poster') };
    log(`  desktop ${mb(sizes.desktop)} · mobile ${mb(sizes.mobile)} · poster ${mb(sizes.poster)}  (source ${mb(info.size)})`);

    if (opts.noUpload) { log(`✓ Compressed files kept in ${dir}`); return { dir, title, sizes }; }
    const outInfo = probe(out.desktop);
    log(`  output ${outInfo.width}×${outInfo.height}`);
    const { id } = await api('POST', '/media', { title, source_name: path.basename(src), duration: seg.length, width: outInfo.width, height: outInfo.height });
    const parts = [['desktop', 'video/mp4'], ['mobile', 'video/mp4'], ['poster', 'image/jpeg']];
    const total = parts.reduce((t, [v]) => t + sizes[v], 0);
    let sent = 0;
    for (const [v, type] of parts) {
      log(`  uploading ${v}…`);
      await api('PUT', `/media/${id}/file/${v}`, fs.readFileSync(out[v]), type);
      sent += sizes[v]; progress('upload', sent / total);
    }
    const fin = await api('POST', `/media/${id}/finalize`);
    log(`✓ "${title}" is live — position ${fin.position + 1} on ${server()}/aerial`);
    return { id, title, position: fin.position, sizes };
  } finally {
    if (!opts.noUpload && !opts.keep) fs.rmSync(dir, { recursive: true, force: true });
  }
}
