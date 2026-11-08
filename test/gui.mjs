// Drives the Aerial Uploader app over its local HTTP API (the same calls its window makes), with the
// real Worker behind it. The native Finder chooser is macOS-only, so files are added via /api/add.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSite } from './harness.mjs';

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  -', m); };
const site = await startSite();
const tmp = mkdtempSync(path.join(os.tmpdir(), 'aerial-gui-'));
const ff = args => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); if (r.status) throw new Error(r.stderr.toString()); };
ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(tmp, 'Lake.mov')]);
ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(tmp, 'Ridge.mov')]);
ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=3', '-c:v', 'prores_ks', '-profile:v', '0', path.join(tmp, 'ProRes.mov')]);

// launch the app (no window; isolated HOME so it doesn't touch real config/Keychain lookups)
const port = 20000 + Math.floor(Math.random() * 20000);
const app = spawn('node', [fileURLToPath(new URL('../tools/Aerial Uploader.app/Contents/Resources/aerial-gui.mjs', import.meta.url))], {
  env: { ...process.env, HOME: tmp, AERIAL_NO_OPEN: '1', AERIAL_GUI_PORT: String(port), AERIAL_SERVER: site.base },
});
let url;
await new Promise((res, rej) => {
  app.stdout.on('data', d => { const m = /running at (\S+)/.exec(String(d)); if (m) { url = m[1]; res(); } });
  app.on('exit', c => rej(new Error('app exited ' + c)));
});
const K = new URL(url).searchParams.get('k');
const g = (p, opts = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...opts, headers: { 'x-k': K, 'content-type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) });
const gj = async (p, o) => { const r = await g(p, o); return { status: r.status, ...(await r.json()) }; };

assert((await fetch(`http://127.0.0.1:${port}/api/state`)).status === 403, 'local app refuses requests without its launch key');
const page = await (await fetch(url)).text();
assert(/Choose videos…/.test(page) && /Compress &amp; Upload/.test(page), 'window page served (chooser + upload button)');

let st = await gj('/api/state');
assert(st.loggedIn === false && st.ffmpeg === null, 'starts logged out; ffmpeg detected');
assert((await gj('/api/upload', { method: 'POST', body: {} })).status === 400, 'upload refused until logged in');
const bad = await gj('/api/login', { method: 'POST', body: { token: 'nope' } });
assert(bad.status === 400 && /tsp_/.test(bad.error), 'bad token rejected with a clear message');
process.env.AERIAL_TOKEN = 'x'; // (harness has no Keychain; the app reads AERIAL_TOKEN in test mode)
app.kill(); await new Promise(r => app.on('exit', r));

// relaunch in token mode
const app2 = spawn('node', [fileURLToPath(new URL('../tools/Aerial Uploader.app/Contents/Resources/aerial-gui.mjs', import.meta.url))], {
  env: { ...process.env, HOME: tmp, AERIAL_NO_OPEN: '1', AERIAL_GUI_PORT: String(port + 1), AERIAL_SERVER: site.base, AERIAL_TOKEN: site.token },
});
await new Promise(res => app2.stdout.on('data', d => { const m = /running at (\S+)/.exec(String(d)); if (m) { url = m[1]; res(); } }));
const K2 = new URL(url).searchParams.get('k');
const h = (p, opts = {}) => fetch(`http://127.0.0.1:${port + 1}${p}`, { ...opts, headers: { 'x-k': K2, 'content-type': 'application/json', ...(opts.headers || {}) }, body: opts.body && JSON.stringify(opts.body) });
const hj = async (p, o) => { const r = await h(p, o); return { status: r.status, ...(await r.json()) }; };

// listen to the live event stream like the window does
const events = [];
const es = await fetch(`http://127.0.0.1:${port + 1}/api/events?k=${K2}`);
(async () => { const rd = es.body.getReader(); const dec = new TextDecoder(); let b = '';
  for (;;) { let r; try { r = await rd.read(); } catch { break; } const { value, done } = r; if (done) break; b += dec.decode(value);
    let i; while ((i = b.indexOf('\n\n')) >= 0) { const ln = b.slice(0, i); b = b.slice(i + 2); if (ln.startsWith('data: ')) events.push(JSON.parse(ln.slice(6))); } } })();

st = await hj('/api/state');
assert(st.loggedIn === true, 'logged in');
const add = await hj('/api/add', { method: 'POST', body: { paths: [path.join(tmp, 'Lake.mov'), path.join(tmp, 'Ridge.mov'), path.join(tmp, 'missing.mov')] } });
st = await hj('/api/state');
assert(add.added === 3 && st.files[0].info?.width === 1920 && st.files[2].status === 'error', 'files added with probed info; unreadable file flagged');
const lake = st.files[0];
await hj('/api/files/' + lake.id, { method: 'PATCH', body: { title: 'Lake at dawn', start: '0:01', end: '0:03', crop: 'top' } });
await hj('/api/files/' + st.files[2].id, { method: 'DELETE' });
// trim editor plumbing: filmstrip thumbs, ranged source playback, proxy for codecs browsers can't play
const th = await h(`/api/files/${lake.id}/thumb/5`);
assert(th.status === 200 && th.headers.get('content-type') === 'image/jpeg' && (await th.arrayBuffer()).byteLength > 1000, 'filmstrip thumbnail generated');
const src = await h(`/api/files/${lake.id}/source`, { headers: { range: 'bytes=0-99' } });
assert(src.status === 206 && (await src.arrayBuffer()).byteLength === 100, 'source video streams with byte ranges (for scrubbing)');
await hj('/api/add', { method: 'POST', body: { paths: [path.join(tmp, 'ProRes.mov')] } });
let pr = (await hj('/api/state')).files.find(f => f.name === 'ProRes.mov');
assert(pr.preview === 'proxy' && (await hj('/api/state')).files.find(f => f.name === 'Lake.mov').preview === 'source', 'ProRes flagged for a preview copy; H.264 previews directly');
for (let i = 0; i < 80 && pr.proxy !== 'ready'; i++) { await new Promise(r => setTimeout(r, 250)); pr = (await hj('/api/state')).files.find(f => f.name === 'ProRes.mov'); }
assert(pr.proxy === 'ready', 'preview copy built automatically in the background after adding');
assert(events.some(e => e.type === 'file' && e.data.id === pr.id && e.data.proxy === 'making'), 'preview-copy progress streamed to the window');
const px = await h(`/api/files/${pr.id}/proxy`);
const pxBuf = Buffer.from(await px.arrayBuffer());
const pxProbe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-i', 'pipe:0'], { input: pxBuf, encoding: 'utf8' }).stdout || '{}');
assert(px.status === 200 && pxProbe.streams?.[0]?.codec_name === 'h264' && pxProbe.streams[0].width === 640, 'ProRes gets a 640px H.264 preview copy');
const np = await hj(`/api/files/${lake.id}/need-proxy`, { method: 'POST' });
assert(np.ok && (await hj('/api/state')).files.find(f => f.id === lake.id).preview === 'proxy', 'window can switch a file to a preview copy when it plays black');
// "backwards" trim: last 2 seconds of the ProRes clip
await hj('/api/files/' + pr.id, { method: 'PATCH', body: { start: '-2', title: 'Last two' } });

const up = await hj('/api/upload', { method: 'POST', body: { max: 20 } });
assert(up.started, 'Compress & Upload started');
for (let i = 0; i < 120; i++) { st = await hj('/api/state'); if (!st.busy && st.files.every(f => f.status !== 'ready' && f.status !== 'working')) break; await new Promise(r => setTimeout(r, 250)); }
assert(st.files.length === 3 && st.files.every(f => f.status === 'done'), 'both clips processed: ' + st.files.map(f => f.status + (f.error ? ' ' + f.error : '')).join(', '));
const logText = st.log.map(l => l.text).join('\n');
assert(/compressing desktop/.test(logText) && /uploading poster/.test(logText) && /Finished: 3 of 3 uploaded/.test(logText), 'log shows each step');
assert(events.some(e => e.type === 'file' && e.data.progress?.desktop > 0 && e.data.progress.desktop < 1), 'live progress events streamed during encode');
assert(events.some(e => e.type === 'log' && /is live/.test(e.data.text)), 'live log events streamed');
const rows = site.db.prepare("SELECT title, duration FROM media_clips WHERE status='ready' ORDER BY position").all();
assert(rows.length === 3 && rows[0].title === 'Lake at dawn' && Math.abs(rows[0].duration - 2) < 0.01
  && rows[2].title === 'Last two' && Math.abs(rows[2].duration - 2) < 0.01, `uploaded with edited title + trim (${rows.map(r => r.title + ' ' + r.duration + 's').join(', ')})`);
// Photos tab: fetcher status + start/finish (nothing waiting on this test site)
const ph = await hj('/api/photos');
assert(ph.running === false && ph.remote && ph.remote.waiting === 0, `Photos tab reads the site's waiting count (${JSON.stringify(ph.remote)})`);
assert((await hj('/api/photos/start', { method: 'POST', body: {} })).started, 'Photos tab: Start');
for (let i = 0; i < 40 && (await hj('/api/photos')).running; i++) await new Promise(r => setTimeout(r, 100));
const ph2 = await hj('/api/photos');
assert(!ph2.running && ph2.log.some(l => /finished: 0 stored/.test(l.text)), 'Photos tab: runs and finishes with a log');
assert(events.some(e => e.type === 'pstate') && events.some(e => e.type === 'plog'), 'Photos tab: live state + log streamed to the window');
const clips = await hj('/api/clips');
assert(clips.clips.length === 3, 'app can list clips on the site');
const q = await hj('/api/quit', { method: 'POST' });
await new Promise(r => app2.on('exit', r));
assert(q.ok, 'Quit button stops the app');
// closing the window quits the app (after a short grace)
const app3 = spawn('node', [fileURLToPath(new URL('../tools/Aerial Uploader.app/Contents/Resources/aerial-gui.mjs', import.meta.url))], {
  env: { ...process.env, HOME: tmp, AERIAL_NO_OPEN: '1', AERIAL_GUI_PORT: String(port + 2), AERIAL_SERVER: site.base, AERIAL_TOKEN: site.token, AERIAL_CLOSE_GRACE_MS: '400' },
});
await new Promise(res => app3.stdout.on('data', d => { const m = /running at (\S+)/.exec(String(d)); if (m) { url = m[1]; res(); } }));
const ac = new AbortController();
await fetch(`http://127.0.0.1:${port + 2}/api/events?k=${new URL(url).searchParams.get('k')}`, { signal: ac.signal }).catch(() => {});
await new Promise(r => setTimeout(r, 200));
ac.abort(); // the window closes
const exited = await Promise.race([new Promise(r => app3.on('exit', () => r(true))), new Promise(r => setTimeout(() => r(false), 3000))]);
assert(exited, 'closing the window quits the app');
if (!exited) app3.kill();
site.server.close();
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
process.exit(process.exitCode || 0);
