#!/usr/bin/env node
// Photo fetcher (command-line version of the app's Photos tab) — downloads full-size Flickr images on your
// own connection, resizes them locally with ffmpeg, and uploads the finished files to tonyshi.photos.
//
//   npm run fetch                 work through the queue, then stop
//   npm run fetch -- --watch      keep running, checking every 5 minutes (e.g. an always-on Mac or a Pi)
//   npm run fetch -- --pace 3     seconds between photos (default 2)
//
// Uses the upload token from the Aerial Uploader (Keychain). Elsewhere (a Pi): AERIAL_TOKEN=tsp_… AERIAL_SERVER=https://tonyshi.photos
import { runFetcher } from './Aerial Uploader.app/Contents/Resources/photo-fetch.mjs';

const args = process.argv.slice(2);
let stopped = false;
const stopFns = [];
process.on('SIGINT', () => {
  if (stopped) process.exit(130);
  stopped = true; console.log('Stopping… (Ctrl-C again to quit now)');
  stopFns.splice(0).forEach(f => f());
});

runFetcher({
  watch: args.includes('--watch'),
  pace: +(args[args.indexOf('--pace') + 1] || 0) || 2,
  stopped: () => stopped,
  onStop: fn => stopFns.push(fn),
  log: text => console.log(`${new Date().toLocaleTimeString()}  ${text}`),
}).catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
