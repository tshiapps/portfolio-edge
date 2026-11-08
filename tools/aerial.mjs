#!/usr/bin/env node
// aerial — compress b-roll for the tonyshi.photos Aerial page and upload it.
//
//   aerial app                           open the Aerial Uploader window (file chooser, upload button, live log)
//   aerial login                         save an upload token (from Admin → Settings) in your Keychain
//   aerial add <clip.mov...> [options]   compress + upload; appears at the end of the playlist
//   aerial list                          show the playlist
//   aerial order <id> <id> ...           set the play order (ids not listed keep their order after these)
//   aerial hide|show <id>                take a clip off / put it back on the page
//   aerial rm <id>                       delete a clip and its files
//
// add options:
//   --title "Glacier"      title (default: file name)
//   --start 0:14           start point in the source (default 0); -10 = 10 s before the end
//   --end 0:26             end point (default: start + --max); -5 = 5 s before the end
//   --max 20               longest clip in seconds when --end isn't given (default 20)
//   --crop none|center|top|bottom   none keeps the original shape (default); others crop to 2:1 keeping that part
//   --best                 slower encode, ~10–15% smaller files at the same quality
//   --no-upload            just compress; keeps the files and prints where they are
//   --keep                 keep the compressed files after uploading
//
// Needs ffmpeg (brew install ffmpeg). Server defaults to https://tonyshi.photos (aerial login --server URL).
// AERIAL_TOKEN / AERIAL_SERVER env vars override the Keychain/config (handy for scripts).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as core from './Aerial Uploader.app/Contents/Resources/aerial-core.mjs';

const ok = msg => console.log(`\x1b[32m✓\x1b[0m ${msg}`);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    if (['best', 'keep', 'no-upload', 'help'].includes(k)) out[k] = true;
    else { if (argv[i + 1] === undefined) throw new Error(`--${k} needs a value`); out[k] = argv[++i]; }
  }
  return out;
}

async function list() {
  const { clips } = await core.api('GET', '/media');
  const ready = clips.filter(c => c.status === 'ready');
  if (!ready.length) return console.log('No clips yet. Add one with: aerial add clip.mov');
  ready.forEach((c, i) => console.log(
    `${String(i + 1).padStart(2)}. ${c.id}  ${c.enabled ? '   ' : '[hidden] '}${(c.title || '(untitled)').padEnd(28)} ` +
    `${(c.duration || 0).toFixed(1).padStart(5)}s  ${core.mb(c.desktop_bytes || 0)} / ${core.mb(c.mobile_bytes || 0)}`));
  const stuck = clips.length - ready.length;
  if (stuck) console.log(`\n${stuck} unfinished upload(s) — remove them in Admin → Aerial or with aerial rm <id>.`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  switch (cmd) {
    case 'app': case 'gui': return import('./Aerial Uploader.app/Contents/Resources/aerial-gui.mjs');
    case 'login': {
      if (opts.server) core.saveServer(opts.server);
      console.log(`Server: ${core.server()}\nCreate a token in Admin → Settings → Upload tokens, then paste it here.`);
      const r = spawnSync('/bin/zsh', ['-c', 'read -rs "T?Upload token: " </dev/tty; echo >&2; print -rn -- $T'],
        { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
      const clips = await core.saveToken((r.stdout || '').trim());
      return ok(`Token works and is saved in your Keychain. ${clips.filter(c => c.status === 'ready').length} clip(s) on the server.`);
    }
    case 'add': {
      if (!opts._.length) throw new Error('Usage: aerial add <clip.mov...> [--title ..] [--start 0:14] [--end 0:26]');
      const miss = core.ffmpegStatus(); if (miss) throw new Error(miss);
      if (!opts['no-upload']) core.getToken(); // fail fast before a long encode
      for (const src of opts._) {
        console.log('');
        await core.processClip(src, {
          title: opts._.length === 1 ? opts.title : undefined, start: opts.start, end: opts.end, max: opts.max,
          crop: opts.crop, best: opts.best, keep: opts.keep, noUpload: opts['no-upload'],
        });
      }
      return;
    }
    case 'list': case 'ls': return list();
    case 'order': {
      const ids = opts._;
      if (!ids.length) throw new Error('Usage: aerial order <id> <id> ...');
      const ready = (await core.api('GET', '/media')).clips.filter(c => c.status === 'ready').map(c => c.id);
      for (const id of ids) if (!ready.includes(id)) throw new Error(`Unknown clip id ${id} (see: aerial list)`);
      await core.api('POST', '/media/order', { ids: [...ids, ...ready.filter(id => !ids.includes(id))] });
      ok('Order saved'); return list();
    }
    case 'hide': case 'show':
      if (!opts._[0]) throw new Error(`Usage: aerial ${cmd} <id>`);
      await core.api('PATCH', `/media/${opts._[0]}`, { enabled: cmd === 'show' });
      return ok(cmd === 'show' ? 'Shown on the page' : 'Hidden from the page');
    case 'rm':
      if (!opts._[0]) throw new Error('Usage: aerial rm <id>');
      await core.api('DELETE', `/media/${opts._[0]}`);
      return ok('Deleted');
    default: {
      const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
      console.log(src.slice(1, src.findIndex(l => l.startsWith('import'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    }
  }
}

main().catch(e => { console.error(`\x1b[31m✗\x1b[0m ${e.message}`); process.exit(1); });
