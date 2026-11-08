// Per-photo ingest: full metadata (getInfo + getExif), then the image resized to the master size (JPEG)
// plus a display/thumbnail (WebP), both stored in R2.
import { RateLimited } from '../flickr/api.js';
import { now } from '../lib/util.js';

const MAX_INPUT_BYTES = 20_000_000; // Images binding input limit

const c = v => (v && typeof v === 'object' && '_content' in v ? v._content : v ?? null);

function locationOf(info) {
  const l = info.location;
  if (!l) return null;
  return {
    latitude: +l.latitude || null, longitude: +l.longitude || null, accuracy: +l.accuracy || null,
    neighbourhood: c(l.neighbourhood), locality: c(l.locality), county: c(l.county),
    region: c(l.region), country: c(l.country), place_id: l.place_id || null, woeid: l.woeid || null,
  };
}

async function fetchMetadata(fl, p) {
  const info = (await fl.call('flickr.photos.getInfo', { photo_id: p.id, secret: p.secret })).photo;
  let exif = null;
  try {
    const e = (await fl.call('flickr.photos.getExif', { photo_id: p.id, secret: p.secret })).photo;
    exif = {
      camera: e.camera || null,
      items: (e.exif || []).map(x => ({ tagspace: x.tagspace, tag: x.tag, label: x.label, raw: c(x.raw), clean: c(x.clean) })),
    };
  } catch (e) {
    if (e instanceof RateLimited) throw e;
    exif = null; // EXIF can be unavailable (videos, stripped files) — not fatal
  }
  const loc = locationOf(info);
  return {
    info,
    fields: {
      title: c(info.title) ?? p.title,
      description: c(info.description) ?? p.description,
      raw_tags: JSON.stringify((info.tags?.tag || []).map(t => t.raw)),
      location: loc ? JSON.stringify(loc) : null,
      page_url: info.urls?.url?.find(u => u.type === 'photopage')?._content || p.page_url,
      exif: exif ? JSON.stringify(exif) : null,
      info: JSON.stringify(info),
      comments: +c(info.comments) || 0,
      views: +info.views || null,
    },
  };
}

// Candidate source sizes in preference order: smallest size that already reaches the target long edge
// (cheap to download, usually 3K/4K), then anything bigger, then the largest below target.
export function rankSources(sizes, longEdge) {
  const photos = (sizes || [])
    .filter(z => z.media !== 'video' && +z.width > 0 && +z.height > 0)
    .map(z => ({ ...z, edge: Math.max(+z.width, +z.height) }));
  const above = photos.filter(z => z.edge >= longEdge).sort((a, b) => a.edge - b.edge);
  const below = photos.filter(z => z.edge < longEdge).sort((a, b) => b.edge - a.edge);
  return [...above, ...below];
}

// Flickr's image CDN can refuse larger sizes to requests that don't look like a browser on flickr.com.
export const FLICKR_IMG_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  referer: 'https://www.flickr.com/',
  accept: 'image/avif,image/webp,image/jpeg,*/*;q=0.8',
};

// Flickr's image servers said "too many requests". Not a reason to settle for a smaller size —
// the sync pauses downloads and comes back for the full size later.
export class CdnRateLimited extends Error {
  constructor(retryAfter) { super(`Flickr image server rate limit (HTTP 429)`); this.retryAfter = retryAfter; }
}

// Tries candidates in order; returns the first usable one plus a record of every attempt (so a silent
// fallback to a small size is visible in the log instead of quietly lowering quality).
export async function downloadFirst(candidates) {
  const tried = [];
  for (const z of candidates) {
    let res;
    try { res = await fetch(z.source, { headers: FLICKR_IMG_HEADERS }); }
    catch (e) { tried.push(`${z.label}: ${e.message}`); continue; }
    if (res.status === 429) {
      res.body?.cancel();
      const ra = res.headers.get('retry-after');
      throw new CdnRateLimited(ra && /^\d+$/.test(ra) ? +ra : null);
    }
    if (!res.ok) { res.body?.cancel(); tried.push(`${z.label}: HTTP ${res.status}`); continue; }
    const len = +res.headers.get('content-length') || 0;
    if (len > MAX_INPUT_BYTES) { res.body?.cancel(); tried.push(`${z.label}: ${(len / 1e6).toFixed(0)} MB (over 20 MB)`); continue; }
    const type = res.headers.get('content-type') || '';
    if (type && !type.startsWith('image/')) { res.body?.cancel(); tried.push(`${z.label}: not an image (${type})`); continue; }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_INPUT_BYTES) { tried.push(`${z.label}: over 20 MB`); continue; }
    if (buf.byteLength < 2000) { tried.push(`${z.label}: tiny response (${buf.byteLength} B) — probably a placeholder`); continue; }
    return { z, buf, tried };
  }
  throw new Error(`No downloadable source size: ${tried.join('; ')}`);
}

const stream = buf => new Blob([buf]).stream();

// Output size boxes. Normal photos: long edge ≤ long_edge (2500) / thumb_edge (1024).
// Panoramas (aspect ≥ pano_ratio) are sized by their SHORT edge instead, so a 6:1 pano isn't squashed to
// 2500×417: master short edge ≤ pano_short (1400) with long edge ≤ pano_long_max (8000); thumb short edge
// ≤ pano_thumb_short (640, enough for the photo grid on retina screens) with long edge ≤ 4096.
export function sizeBoxes(s, w, h, showcase = false) {
  // showcase photos get the big size, the rest the base size (see lib/showcase.js)
  const L = showcase ? parseInt(s.long_edge) || 3840 : parseInt(s.base_edge) || 2048, T = parseInt(s.thumb_edge) || 1024;
  const ratio = parseFloat(s.pano_ratio) || 2.2;
  const a = Math.max(w, h) / Math.max(1, Math.min(w, h));
  if (!(w > 0 && h > 0) || a < ratio) return { pano: false, master: [L, L], thumb: [T, T], needLong: L };
  const S = parseInt(s.pano_short) || 1400, LM = parseInt(s.pano_long_max) || 8000;
  const TS = parseInt(s.pano_thumb_short) || 640, TM = 4096;
  const long = Math.min(LM, Math.round(S * a)), tlong = Math.min(TM, Math.round(TS * a));
  const box = (lg, sh) => (w >= h ? [lg, sh] : [sh, lg]);
  return { pano: true, master: box(long, S), thumb: box(tlong, TS), needLong: long };
}

async function makeImages(env, s, buf, rotate, boxes) { // s = this photo's account settings (forAccount)
  const Q = parseInt(s.quality) || 75;
  const TQ = parseInt(s.thumb_quality) || 72;

  let m = env.IMAGES.input(stream(buf));
  if (rotate) m = m.transform({ rotate });
  m = m.transform({ width: boxes.master[0], height: boxes.master[1], fit: 'scale-down' });
  const master = await (await m.output({ format: 'image/jpeg', quality: Q })).response().arrayBuffer();
  const mi = await env.IMAGES.info(stream(master));

  const thumb = await (await env.IMAGES.input(stream(master))
    .transform({ width: boxes.thumb[0], height: boxes.thumb[1], fit: 'scale-down' })
    .output({ format: 'image/webp', quality: TQ })).response().arrayBuffer();
  const ti = await env.IMAGES.info(stream(thumb));

  return { master, thumb, mw: mi.width, mh: mi.height, tw: ti.width, th: ti.height };
}

async function saveMeta(env, id, fields, finalStatus) {
  await env.DB.prepare(
    `UPDATE photos SET title=?2, description=?3, raw_tags=?4, location=?5, page_url=?6, exif=?7, info=?8,
       comments=?10, views=COALESCE(?11, views)${finalStatus ? `, status='ok', attempts=0, error=NULL, lease_until=NULL, synced_at=?9` : ''}
     WHERE id=?1`
  ).bind(id, fields.title, fields.description, fields.raw_tags, fields.location, fields.page_url,
    fields.exif, fields.info, now(), fields.comments, fields.views).run();
}

// Which Flickr sizes to try for a photo (largest needed first-fit order) and the output size boxes.
export async function candidatesFor(s, fl, p, minLong = 0) {
  const sizes = (await fl.call('flickr.photos.getSizes', { photo_id: p.id })).sizes.size;
  // Shape from the largest generated size (already rotated the way Flickr displays it).
  const big = rankSources(sizes, 0).slice(-1)[0] || {};
  const boxes = sizeBoxes(s, +big.width || +p.o_width || 0, +big.height || +p.o_height || 0, !!p.showcase);
  return { big, boxes, list: rankSources(sizes, Math.max(boxes.needLong, minLong)) };
}

// Resize downloaded source bytes into master + thumb, store in R2, mark the photo ok.
// Used by the Worker's own download and by the photo fetcher (bytes uploaded from Tony's network).
export async function storeImage(env, s, p, z, buf, rotation) {
  const boxes = sizeBoxes(s, +z.bigW || +z.width || +p.o_width || 0, +z.bigH || +z.height || +p.o_height || 0, !!p.showcase);
  // Flickr applies its rotation to generated sizes but not to the stored original.
  const rot = +rotation || 0;
  const rotate = z.label === 'Original' && [90, 180, 270].includes(rot) ? rot : 0;
  const img = await makeImages(env, s, buf, rotate, boxes);
  const meta = { account: String(p.account_id), source: z.label };
  await env.BUCKET.put(`m/${p.id}.jpg`, img.master, { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: meta });
  await env.BUCKET.put(`t/${p.id}.webp`, img.thumb, { httpMetadata: { contentType: 'image/webp' }, customMetadata: meta });
  await env.DB.prepare(
    `UPDATE photos SET width=?2, height=?3, bytes=?4, thumb_w=?5, thumb_h=?6, thumb_bytes=?7, source_size=?8,
       status='ok', refetch=0, attempts=0, error=NULL, lease_until=NULL, synced_at=?9, best_edge=?10, best_at=?9 WHERE id=?1`
  ).bind(p.id, img.mw, img.mh, img.master.byteLength, img.tw, img.th, img.thumb.byteLength, z.label, now(),
    Math.max(+z.width || 0, +z.height || 0) || Math.max(img.mw, img.mh)).run();
  return img;
}

export async function ingestPhoto(env, s, fl, p, { metaOnly = false } = {}) {
  if (!fl) throw new Error('Account is not connected');
  const { info, fields } = await fetchMetadata(fl, p);
  if (p.status === 'meta') { await saveMeta(env, p.id, fields, true); return 'meta'; }
  // keep the metadata even if the image download has to wait (e.g. handed to the photo fetcher)
  await saveMeta(env, p.id, fields, false);
  if (metaOnly) return 'handoff';

  const { big, boxes, list } = await candidatesFor(s, fl, p);
  const { z, buf, tried } = await downloadFirst(list);
  const usedEdge = Math.max(+z.width || 0, +z.height || 0);
  if (tried.length && usedEdge < Math.min(boxes.needLong, Math.max(+big.width || 0, +big.height || 0))) {
    // Fell back to a smaller size than the photo deserves — say why, loudly.
    await env.DB.prepare('INSERT INTO sync_log (level, account_id, msg) VALUES (?1, ?2, ?3)').bind('warn', p.account_id,
      `Photo ${p.id}: used ${z.label} (${z.width}×${z.height}) because larger sizes failed — ${tried.join('; ')}`.slice(0, 2000)).run();
  }
  await storeImage(env, s, p, { ...z, bigW: big.width, bigH: big.height }, buf, info.rotation);
  return 'image';
}
