// Cron-driven sync. Each tick (once a minute) does a bounded slice of work under a D1 lease:
//   1. per account: advance the current phase (full listing -> albums -> idle) and poll recentlyUpdated
//   2. ingest pending photos (metadata + resized image) until the time slice or API budget runs out
// Full listing is split into upload-date windows (re-split when a window exceeds ~3500 results) so very
// large accounts are listed completely; anything not seen in a finished full listing is marked deleted.
import { Flickr, loadApp, PHOTO_EXTRAS, RateLimited, FlickrError } from '../flickr/api.js';
import { getSettings, setSetting, log } from '../lib/settings.js';
import { now, safeJson, chunk } from '../lib/util.js';
import { ingestPhoto, CdnRateLimited } from './ingest.js';
import { recomputePopularity } from '../lib/popularity.js';
import { applyRules, loadScheme } from '../lib/tagging.js';
import { refreshShowcase, shrinkLoop, forAccount } from '../lib/showcase.js';
import { purgePhotos, purgePrivate } from '../lib/purge.js';
import { igTick } from '../lib/instagram.js';
import { publishTick } from '../lib/igpublish.js';
import { refreshFacets } from '../lib/catalog.js';
import { statsTick } from '../lib/stats.js';

const TICK_MS = 45_000;
const FULL_SYNC_EVERY = 24 * 3600;
const ALBUM_SYNC_EVERY = 24 * 3600;
const RECENT_EVERY = 24 * 3600;
const WINDOW_SPLIT_AT = 3500;
const MAX_ATTEMPTS = 5;
const INGEST_CONCURRENCY = 3;
const METRICS_MAX_AGE = 7 * 86400; // fallback refresh cycle when the listing doesn't carry counts

const c = v => (v && typeof v === 'object' && '_content' in v ? v._content : v ?? null);

async function save(env, acc, patch) {
  const keys = Object.keys(patch);
  const set = keys.map((k, i) => `${k} = ?${i + 2}`).join(', ');
  await env.DB.prepare(`UPDATE accounts SET ${set} WHERE id = ?1`).bind(acc.id, ...keys.map(k => patch[k])).run();
  Object.assign(acc, patch);
}

// ---------- photo upsert ----------

const UPSERT = `
INSERT INTO photos (id, account_id, secret, server, original_secret, title, description, tags, machine_tags,
  date_taken, date_upload, last_update, latitude, longitude, geo_accuracy, is_public, is_friend, is_family,
  license, views, media, original_format, o_width, o_height, page_url, seen_run, faves, comments, metrics_at, status)
VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,'pending')
ON CONFLICT(id) DO UPDATE SET
  status = CASE
    WHEN photos.status = 'deleted' THEN 'pending'
    WHEN photos.secret IS NOT excluded.secret OR photos.original_secret IS NOT excluded.original_secret
      OR photos.server IS NOT excluded.server THEN 'pending'
    WHEN photos.last_update IS NOT excluded.last_update AND photos.status = 'ok' THEN 'meta'
    WHEN photos.last_update IS NOT excluded.last_update AND photos.status = 'error' THEN 'pending'
    ELSE photos.status END,
  attempts = CASE WHEN photos.last_update IS NOT excluded.last_update OR photos.secret IS NOT excluded.secret
    OR photos.status = 'deleted' THEN 0 ELSE photos.attempts END,
  account_id = excluded.account_id, secret = excluded.secret, server = excluded.server,
  original_secret = excluded.original_secret, title = excluded.title, description = excluded.description,
  tags = excluded.tags, machine_tags = excluded.machine_tags, date_taken = excluded.date_taken,
  date_upload = excluded.date_upload, last_update = excluded.last_update, latitude = excluded.latitude,
  longitude = excluded.longitude, geo_accuracy = excluded.geo_accuracy, is_public = excluded.is_public,
  is_friend = excluded.is_friend, is_family = excluded.is_family, license = excluded.license,
  views = excluded.views, media = excluded.media, original_format = excluded.original_format,
  o_width = excluded.o_width, o_height = excluded.o_height, page_url = excluded.page_url,
  seen_run = excluded.seen_run,
  faves = COALESCE(excluded.faves, photos.faves), comments = COALESCE(excluded.comments, photos.comments),
  metrics_at = COALESCE(excluded.metrics_at, photos.metrics_at)`;

async function upsertPhotos(env, acc, photos) {
  if (!photos?.length) return;
  // only public photos are kept: private / friends / family ones are skipped, and removed if stored before
  const hidden = photos.filter(p => !+p.ispublic).map(p => String(p.id));
  photos = photos.filter(p => +p.ispublic);
  if (hidden.length) {
    const known = (await env.DB.prepare('SELECT id FROM photos WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(hidden)).all()).results.map(r => r.id);
    if (known.length) { await purgePhotos(env, known); await log(env, 'info', `Removed ${known.length} photo(s) that are private on Flickr`, acc.id); }
  }
  if (!photos.length) return;
  // Remember whether Flickr honoured the count_* extras; if not, metricsLoop refreshes counts per photo.
  const hasCounts = 'count_faves' in photos[0];
  await setSetting(env, 'listing_has_counts', hasCounts ? '1' : '0');
  const t = now();
  for (const part of chunk(photos, 50)) {
    await env.DB.batch(part.map(p => {
      const acc0 = +p.accuracy || 0;
      const lat = +p.latitude || 0, lon = +p.longitude || 0;
      const hasGeo = acc0 > 0 || lat !== 0 || lon !== 0;
      return env.DB.prepare(UPSERT).bind(
        String(p.id), acc.id, p.secret ?? null, p.server ?? null, p.originalsecret ?? null,
        p.title ?? '', c(p.description) ?? '', p.tags ?? '', p.machine_tags ?? '',
        p.datetaken ?? null, +p.dateupload || null, +p.lastupdate || null,
        hasGeo ? lat : null, hasGeo ? lon : null, hasGeo ? acc0 : null,
        +p.ispublic || 0, +p.isfriend || 0, +p.isfamily || 0,
        p.license ?? null, +p.views || 0, p.media ?? 'photo', p.originalformat ?? null,
        +p.o_width || null, +p.o_height || null,
        `https://www.flickr.com/photos/${p.pathalias || acc.path_alias || acc.nsid}/${p.id}/`,
        acc.run_id,
        hasCounts ? +p.count_faves || 0 : null, hasCounts ? +p.count_comments || 0 : null, hasCounts ? t : null,
      );
    }));
  }
}

// ---------- full listing ----------

function yearWindows(from, to) {
  const out = [];
  let a = from;
  while (a <= to) {
    const b = Math.min(a + 365 * 86400, to);
    out.push([a, b]);
    a = b + 1;
  }
  return out;
}

export async function startFullRun(env, acc) {
  await save(env, acc, { sync_phase: 'list', sync_state: null, run_id: acc.run_id + 1 });
}

async function listStep(env, fl, acc, summary) {
  let st = safeJson(acc.sync_state);
  if (!st) {
    const p = (await fl.call('flickr.people.getInfo', { user_id: acc.nsid })).person;
    const first = +c(p.photos?.firstdate) || 1072915200; // fall back to 2004
    st = { windows: yearWindows(first - 86400, now() + 86400), page: 1, listed: 0 };
    await save(env, acc, {
      flickr_count: +c(p.photos?.count) || 0, first_upload: first,
      username: c(p.username), realname: c(p.realname), path_alias: p.path_alias || null,
      sync_state: JSON.stringify(st),
    });
    await log(env, 'info', `Full listing started (run ${acc.run_id}); Flickr reports ${acc.flickr_count} items`, acc.id);
    return;
  }
  if (!st.windows.length) return finishListing(env, acc, st);

  const [min, max] = st.windows[0];
  const r = (await fl.call('flickr.people.getPhotos', {
    user_id: 'me', min_upload_date: min, max_upload_date: max, extras: PHOTO_EXTRAS,
    per_page: 500, page: st.page, content_types: 7, safe_search: 3,
  })).photos;

  if (st.page === 1 && +r.total > WINDOW_SPLIT_AT && max - min > 3600) {
    const mid = Math.floor((min + max) / 2);
    st.windows.splice(0, 1, [min, mid], [mid + 1, max]);
  } else {
    await upsertPhotos(env, acc, r.photo);
    st.listed += r.photo?.length || 0;
    summary.listed += r.photo?.length || 0;
    if (st.page < +r.pages) st.page++;
    else { st.windows.shift(); st.page = 1; }
  }
  await save(env, acc, { sync_state: JSON.stringify(st) });
}

export async function applyDeletions(env, acc) {
  const r = await env.DB.prepare(
    `UPDATE photos SET status='deleted', lease_until=NULL
     WHERE account_id=?1 AND status!='deleted' AND (seen_run IS NULL OR seen_run < ?2)`
  ).bind(acc.id, acc.run_id).run();
  return r.meta.changes || 0;
}

async function finishListing(env, acc, st) {
  const stale = (await env.DB.prepare(
    `SELECT COUNT(*) n FROM photos WHERE account_id=?1 AND status!='deleted' AND (seen_run IS NULL OR seen_run < ?2)`
  ).bind(acc.id, acc.run_id).first()).n;
  const live = (await env.DB.prepare(
    `SELECT COUNT(*) n FROM photos WHERE account_id=?1 AND seen_run = ?2`
  ).bind(acc.id, acc.run_id).first()).n;

  let note = null;
  if (stale > 0) {
    // Guard against a bad listing wiping the catalog: big drops wait for a manual confirm in the admin.
    if (stale > 25 && stale > (stale + live) * 0.05) {
      note = `${stale} photos no longer listed on Flickr — not marked deleted automatically. Confirm in admin if expected.`;
      await log(env, 'warn', note, acc.id);
    } else {
      const n = await applyDeletions(env, acc);
      await log(env, 'info', `Marked ${n} photos deleted (gone from Flickr)`, acc.id);
    }
  }
  await log(env, 'info', `Listing complete: ${st.listed} listed, ${live} in this run, Flickr reports ${acc.flickr_count}`, acc.id);
  await save(env, acc, {
    sync_phase: 'albums', sync_state: JSON.stringify({ stage: 'list', page: 1, run: now(), queue: [] }),
    last_full_sync: now(), last_error: note,
  });
}

// ---------- albums (Flickr photosets, mirrored read-only) ----------

async function albumStep(env, fl, acc) {
  const st = safeJson(acc.sync_state) || { stage: 'list', page: 1, run: now(), queue: [] };
  if (st.stage === 'list') {
    const r = (await fl.call('flickr.photosets.getList', { user_id: acc.nsid, per_page: 500, page: st.page })).photosets;
    const sets = r.photoset || [];
    if (sets.length) {
      // Flickr lists albums in the order you arranged them — keep that as the album's position
      const base = (st.page - 1) * 500;
      await env.DB.batch(sets.map((s, i) => env.DB.prepare(
        `INSERT INTO albums (id, source, account_id, flickr_id, title, description, cover_photo_id, photo_count, seen_run, position, updated_at)
         VALUES (?1,'flickr',?2,?3,?4,?5,?6,?7,?8,?9,unixepoch())
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description,
           cover_photo_id=excluded.cover_photo_id, photo_count=excluded.photo_count, seen_run=excluded.seen_run,
           position=excluded.position, updated_at=CASE WHEN albums.position IS excluded.position AND albums.title = excluded.title THEN albums.updated_at ELSE unixepoch() END`
      ).bind(`f:${s.id}`, acc.id, s.id, c(s.title) || '(untitled)', c(s.description) || '', s.primary || null,
        (+s.photos || 0) + (+s.videos || 0), st.run, base + i)));
    }
    st.queue.push(...sets.map(s => s.id));
    if (st.page < +r.pages) st.page++;
    else {
      // the collection tree is one call — do it now so moving albums between collections shows within a minute,
      // instead of after every album's photos have been re-read (which can take an hour)
      st.stage = 'photos'; st.page = 1;
      await syncCollections(env, fl, acc, st.run);
      st.collectionsDone = true;
    }
  } else if (!st.queue.length && !st.collectionsDone) {
    await syncCollections(env, fl, acc, st.run);
    st.collectionsDone = true;
  } else if (!st.queue.length) {
    const stale = await env.DB.prepare(
      `SELECT id FROM albums WHERE source='flickr' AND account_id=?1 AND (seen_run IS NULL OR seen_run < ?2)`
    ).bind(acc.id, st.run).all();
    for (const a of stale.results) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM album_photos WHERE album_id=?1').bind(a.id),
        env.DB.prepare('DELETE FROM albums WHERE id=?1').bind(a.id),
      ]);
    }
    await log(env, 'info', `Albums synced${stale.results.length ? `, removed ${stale.results.length} deleted` : ''}`, acc.id);
    await save(env, acc, { sync_phase: 'idle', sync_state: null, last_album_sync: now() });
    return;
  } else {
    const setId = st.queue[0];
    const albumId = `f:${setId}`;
    try {
      const r = (await fl.call('flickr.photosets.getPhotos', {
        photoset_id: setId, user_id: acc.nsid, per_page: 500, page: st.page, media: 'all',
      })).photoset;
      const stmts = [];
      if (st.page === 1) stmts.push(env.DB.prepare('DELETE FROM album_photos WHERE album_id=?1').bind(albumId));
      (r.photo || []).forEach((p, i) => stmts.push(env.DB.prepare(
        'INSERT OR REPLACE INTO album_photos (album_id, photo_id, position) VALUES (?1,?2,?3)'
      ).bind(albumId, String(p.id), (st.page - 1) * 500 + i)));
      for (const part of chunk(stmts, 100)) await env.DB.batch(part);
      if (st.page < +r.pages) st.page++;
      else { st.queue.shift(); st.page = 1; }
    } catch (e) {
      if (e instanceof FlickrError && e.code === 1) { st.queue.shift(); st.page = 1; } // album deleted mid-sync
      else throw e;
    }
  }
  await save(env, acc, { sync_state: JSON.stringify(st) });
}

// ---------- collections (folders of albums, can nest) ----------

async function syncCollections(env, fl, acc, run) {
  let tree;
  try {
    tree = (await fl.call('flickr.collections.getTree', { user_id: acc.nsid })).collections;
  } catch (e) {
    if (e instanceof RateLimited) throw e;
    await log(env, 'warn', `Collections not synced: ${e.message}`, acc.id);
    return;
  }
  const rows = [], links = [];
  const walk = (list, parent, chain) => (list || []).forEach((col, i) => {
    const id = `c:${col.id}`;
    rows.push([id, String(col.id), parent, c(col.title) || '(untitled)', c(col.description) || '', i]);
    const up = [...chain, id];
    (col.set || []).forEach((set, j) => up.forEach(cid => links.push([cid, `f:${set.id}`, cid === id ? 1 : 0, j])));
    walk(col.collection, id, up);
  });
  walk(tree?.collection, null, []);

  const stmts = [env.DB.prepare(
    'DELETE FROM collection_albums WHERE collection_id IN (SELECT id FROM collections WHERE account_id = ?1)'
  ).bind(acc.id)];
  for (const [id, fid, parent, title, desc, pos] of rows) {
    stmts.push(env.DB.prepare(
      `INSERT INTO collections (id, account_id, flickr_id, parent_id, title, description, position, seen_run)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
       ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, title=excluded.title,
         description=excluded.description, position=excluded.position, seen_run=excluded.seen_run`
    ).bind(id, acc.id, fid, parent, title, desc, pos, run));
  }
  // Direct links first so INSERT OR IGNORE keeps direct=1 when an album is also inherited.
  links.sort((a, b) => b[2] - a[2]);
  for (const l of links) {
    stmts.push(env.DB.prepare(
      'INSERT OR IGNORE INTO collection_albums (collection_id, album_id, direct, position) VALUES (?1,?2,?3,?4)'
    ).bind(...l));
  }
  stmts.push(env.DB.prepare(
    'DELETE FROM collections WHERE account_id = ?1 AND (seen_run IS NULL OR seen_run < ?2)'
  ).bind(acc.id, run));
  for (const part of chunk(stmts, 100)) await env.DB.batch(part);
  // the public catalog's cached copy moves on
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('catalog_ver', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(String(Date.now())).run();
  if (rows.length) await log(env, 'info', `Collections synced: ${rows.length}`, acc.id);
}

// ---------- incremental ----------

async function checkRecent(env, fl, acc, summary) {
  const started = now();
  const since = (acc.last_recent_check || acc.last_full_sync) - 300;
  let page = 1, pages = 1, n = 0;
  do {
    const r = (await fl.call('flickr.photos.recentlyUpdated', {
      min_date: since, extras: PHOTO_EXTRAS, per_page: 500, page,
    })).photos;
    await upsertPhotos(env, acc, r.photo);
    n += r.photo?.length || 0;
    pages = +r.pages || 1;
    page++;
  } while (page <= pages && page <= 10);
  summary.recent += n;
  if (n) await log(env, 'info', `${n} new/updated on Flickr since last check`, acc.id);
  await save(env, acc, { last_recent_check: started });
}

async function stepAccount(env, fl, acc, deadline, summary) {
  const t = now();
  if (acc.sync_phase === 'idle') {
    if (!acc.last_full_sync || t - acc.last_full_sync > FULL_SYNC_EVERY) await startFullRun(env, acc);
    else if (!acc.last_album_sync || t - acc.last_album_sync > ALBUM_SYNC_EVERY) {
      await save(env, acc, { sync_phase: 'albums', sync_state: JSON.stringify({ stage: 'list', page: 1, run: now(), queue: [] }) });
    }
  }
  if (acc.last_full_sync && (!acc.last_recent_check || t - acc.last_recent_check > RECENT_EVERY)) {
    await checkRecent(env, fl, acc, summary);
  }
  // A few listing/album calls per tick per account; the rest of the slice goes to ingest.
  for (let i = 0; i < 4 && Date.now() < deadline - 25_000; i++) {
    if (acc.sync_phase === 'list') await listStep(env, fl, acc, summary);
    else if (acc.sync_phase === 'albums') await albumStep(env, fl, acc);
    else break;
  }
}

// ---------- ingest ----------

export async function storageUsed(env) {
  const r = await env.DB.prepare(
    'SELECT COALESCE(SUM(bytes),0) + COALESCE(SUM(thumb_bytes),0) AS used FROM photos'
  ).first();
  return r.used || 0;
}

// ---------- Flickr image CDN pacing ----------
// Full-size downloads are paced per minute (counted in api_usage under negative "minute" buckets).
// A 429 halves the rate and pauses downloads (Retry-After, at least 10 min); an hour without trouble
// raises the rate again by 2/min, up to 30.
const CDN_MIN = 2, CDN_MAX = 30;

async function cdnAllowance(env, s) {
  const t = now();
  if (t < (+s.cdn_pause_until || 0)) return 0;
  let rate = +s.cdn_rate || 12;
  if (rate < CDN_MAX && t - (+s.cdn_rate_at || 0) > 3600) {
    rate = Math.min(CDN_MAX, rate + 2);
    s.cdn_rate = String(rate); s.cdn_rate_at = String(t);
    await setSetting(env, 'cdn_rate', rate); await setSetting(env, 'cdn_rate_at', t);
  }
  const used = (await env.DB.prepare('SELECT calls FROM api_usage WHERE bucket = ?1').bind(-Math.floor(t / 60)).first())?.calls || 0;
  return Math.max(0, rate - used);
}

async function cdnUse(env, n) {
  if (!n) return;
  await env.DB.prepare(
    'INSERT INTO api_usage (bucket, calls) VALUES (?1, ?2) ON CONFLICT(bucket) DO UPDATE SET calls = calls + ?2'
  ).bind(-Math.floor(now() / 60), n).run();
}

async function cdnBackoff(env, s, retryAfter) {
  const t = now();
  const rate = Math.max(CDN_MIN, Math.floor((+s.cdn_rate || 12) / 2));
  const pause = Math.max(600, retryAfter || 0);
  s.cdn_rate = String(rate); s.cdn_pause_until = String(t + pause); s.cdn_rate_at = String(t);
  await setSetting(env, 'cdn_rate', rate);
  await setSetting(env, 'cdn_pause_until', t + pause);
  await setSetting(env, 'cdn_rate_at', t);
  await log(env, 'warn', `Flickr's image server asked us to slow down (429). Pausing full-size downloads for ${Math.round(pause / 60)} min, then ${rate}/min.`);
}

async function ingestLoop(env, s, clients, deadline, summary, accounts = []) {
  const accById = new Map(accounts.map(a => [a.id, a]));
  const budgetBytes = (parseFloat(s.storage_budget_gb) || 8) * 1e9;
  while (Date.now() < deadline - 8000) {
    const imagesAllowed = (await storageUsed(env)) < budgetBytes;
    if (!imagesAllowed) summary.storageFull = true;
    // While Flickr is refusing the Worker (paused after a 429), or when set to always use the fetcher,
    // new image work is handed straight to the photo fetcher after its metadata is saved.
    const viaFetcher = s.fetch_mode === 'fetcher' || now() < (+s.cdn_pause_until || 0);
    const allowance = !imagesAllowed ? 0 : viaFetcher ? INGEST_CONCURRENCY : await cdnAllowance(env, s);
    if (imagesAllowed && !allowance) summary.cdnWaiting = true;
    if (viaFetcher) summary.viaFetcher = true;
    const t = now();
    // Image work (pending) only within the download allowance; metadata-only work (meta) any time.
    const take = async (statuses, limit) => limit <= 0 ? [] : (await env.DB.prepare(
      `UPDATE photos SET lease_until = ?1 WHERE id IN (
         SELECT p.id FROM photos p JOIN accounts a ON a.id = p.account_id AND a.enabled = 1
         WHERE p.status IN ${statuses} AND (p.lease_until IS NULL OR p.lease_until < ?2)
         ORDER BY p.date_upload DESC LIMIT ?3)
       RETURNING id, account_id, status, secret, title, description, page_url, attempts, showcase, o_width, o_height`
    ).bind(t + 300, t, limit).all()).results;
    const imgs = await take("('pending')", Math.min(INGEST_CONCURRENCY, allowance));
    const results = [...imgs, ...await take("('meta')", INGEST_CONCURRENCY - imgs.length)];
    if (!results.length) break;
    await cdnUse(env, imgs.length);

    const outcomes = await Promise.allSettled(results.map(async p => {
      const r = await ingestPhoto(env, forAccount(s, accById.get(p.account_id)), clients.get(p.account_id), p, { metaOnly: viaFetcher && p.status === 'pending' });
      if (r === 'handoff') await env.DB.prepare("UPDATE photos SET status = 'fetch', lease_until = NULL WHERE id = ?1").bind(p.id).run();
      return r;
    }));
    // consistent site tags (geotag + Flickr words) for everything whose metadata just arrived
    const done = results.filter((_, i) => outcomes[i].status === 'fulfilled').map(p => p.id);
    if (done.length) {
      try { summary.scheme ||= await loadScheme(env); await applyRules(env, done, summary.scheme); }
      catch (e) { console.error('tagging failed', e); }
    }
    let limited = false;
    for (let i = 0; i < results.length; i++) {
      const p = results[i], o = outcomes[i];
      if (o.status === 'fulfilled') { summary.ingested++; continue; }
      if (o.reason instanceof RateLimited) {
        limited = true;
        await env.DB.prepare('UPDATE photos SET lease_until = NULL WHERE id = ?1').bind(p.id).run();
        continue;
      }
      if (o.reason instanceof CdnRateLimited) {
        // Flickr won't serve full sizes to Cloudflare right now: hand this photo to the photo fetcher
        // (runs on Tony's network) without using an attempt, and back off the Worker's own downloads.
        await env.DB.prepare("UPDATE photos SET status = 'fetch', lease_until = NULL WHERE id = ?1").bind(p.id).run();
        summary.handedOff = (summary.handedOff || 0) + 1;
        if (!summary.cdnLimited) { summary.cdnLimited = true; await cdnBackoff(env, s, o.reason.retryAfter); }
        continue;
      }
      summary.errors++;
      const attempts = (p.attempts || 0) + 1;
      const msg = String(o.reason?.message || o.reason).slice(0, 500);
      await env.DB.prepare(
        `UPDATE photos SET attempts = ?2, error = ?3, lease_until = ?4,
           status = CASE WHEN ?2 >= ${MAX_ATTEMPTS} THEN 'error' ELSE status END WHERE id = ?1`
      ).bind(p.id, attempts, msg, now() + 60 * 2 ** attempts).run();
      if (attempts >= MAX_ATTEMPTS) await log(env, 'error', `Photo ${p.id} failed ${attempts}x: ${msg}`, p.account_id);
    }
    if (limited) { summary.rateLimited = true; break; }
  }
}

// ---------- popularity metrics fallback ----------
// Only used when Flickr ignores the count_* listing extras: refreshes faves/comments/views per photo,
// oldest first, after ingest work is done, so each photo is refreshed about weekly.

async function metricsLoop(env, clients, deadline, summary) {
  const flag = await env.DB.prepare("SELECT value FROM settings WHERE key = 'listing_has_counts'").first();
  if (flag?.value !== '0') return;
  while (Date.now() < deadline - 6000) {
    const t = now();
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.account_id, p.secret FROM photos p JOIN accounts a ON a.id = p.account_id AND a.enabled = 1
       WHERE p.status = 'ok' AND (p.metrics_at IS NULL OR p.metrics_at < ?1)
       ORDER BY p.metrics_at IS NOT NULL, p.metrics_at LIMIT 5`
    ).bind(t - METRICS_MAX_AGE).all();
    if (!results.length) break;
    const out = await Promise.allSettled(results.map(async p => {
      const fl = clients.get(p.account_id);
      const fav = (await fl.call('flickr.photos.getFavorites', { photo_id: p.id, per_page: 1 })).photo;
      const info = (await fl.call('flickr.photos.getInfo', { photo_id: p.id, secret: p.secret })).photo;
      await env.DB.prepare(
        'UPDATE photos SET faves = ?2, comments = ?3, views = COALESCE(?4, views), metrics_at = ?5 WHERE id = ?1'
      ).bind(p.id, +fav.total || 0, +c(info.comments) || 0, +info.views || null, now()).run();
    }));
    let limited = false;
    for (let i = 0; i < results.length; i++) {
      const o = outcomes(out, i);
      if (o === 'ok') { summary.metrics = (summary.metrics || 0) + 1; continue; }
      if (o === 'limited') { limited = true; continue; }
      // Don't hot-loop on a photo that keeps failing; try again next cycle.
      await env.DB.prepare('UPDATE photos SET metrics_at = ?2 WHERE id = ?1').bind(results[i].id, now()).run();
    }
    if (limited) { summary.rateLimited = true; break; }
  }
}

function outcomes(out, i) {
  if (out[i].status === 'fulfilled') return 'ok';
  return out[i].reason instanceof RateLimited ? 'limited' : 'failed';
}

// ---------- tick ----------

export async function runTick(env, { force = false } = {}) {
  const deadline = Date.now() + (+env.SYNC_TICK_MS || TICK_MS);
  const lock = await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('tick_lock', ?1, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
     WHERE CAST(settings.value AS INTEGER) < unixepoch()`
  ).bind(String(now() + 70)).run();
  if (!lock.meta.changes) return { skipped: 'another sync tick is running' };

  const summary = { listed: 0, recent: 0, ingested: 0, errors: 0 };
  try {
    const s = await getSettings(env);
    if (s.paused === '1' && !force) return { skipped: 'paused' };
    const app = await loadApp(env);
    if (!app) return { skipped: 'Flickr API key not configured' };
    const budget = parseInt(s.api_budget) || 3000;

    const { results: accounts } = await env.DB.prepare('SELECT * FROM accounts WHERE enabled = 1').all();
    const clients = new Map();
    for (const acc of accounts) {
      const fl = await Flickr.forAccount(env, app, budget, acc);
      clients.set(acc.id, fl);
      if (summary.rateLimited) continue;
      try {
        await stepAccount(env, fl, acc, deadline, summary);
      } catch (e) {
        if (e instanceof RateLimited) { summary.rateLimited = true; continue; }
        const msg = e instanceof FlickrError && (e.code === 98 || e.code === 99)
          ? `Flickr rejected the token (${e.message}) — reconnect this account`
          : String(e.message || e);
        await save(env, acc, { last_error: msg.slice(0, 500) });
        await log(env, 'error', msg, acc.id);
      }
    }
    // Instagram: token refresh + post list every few hours (independent of Flickr)
    try { const ig = await igTick(env, s); if (ig) summary.instagram = ig; } catch (e) { console.error('instagram', e); }
    // stats: a daily snapshot of every photo's counts + Flickr's stats API (Pro accounts)
    if (!summary.rateLimited) { try { const st = await statsTick(env, await getSettings(env)); if (Object.keys(st).length) summary.stats = st; } catch (e) { console.error('stats', e); } }
    // catalog facets (camera, year, place) for photos that are new or re-synced
    try { const nf = await refreshFacets(env); if (nf) summary.facets = nf; } catch (e) { console.error('facets', e); }
    // posting to Instagram from the Flickr magic tag (one step per tick)
    try { const pub = await publishTick(env, await getSettings(env)); if (pub) summary.igPublish = pub; } catch (e) { console.error('instagram publish', e); }
    // private photos synced before this rule existed: removed a batch at a time
    const purged = await purgePrivate(env);
    if (purged) { summary.purgedPrivate = purged; await log(env, 'info', `Removed ${purged} private photo(s) and their files`); }
    if (!summary.rateLimited) await ingestLoop(env, s, clients, deadline, summary, accounts);
    if (!summary.rateLimited) await metricsLoop(env, clients, deadline, summary);
    delete summary.scheme;
    // which photos deserve the big size, and shrink the ones that don't (from R2, no Flickr download)
    try { const sc = await refreshShowcase(env, s); if (sc) summary.showcase = sc; await shrinkLoop(env, s, deadline, summary); }
    catch (e) { console.error('showcase sizing failed', e); }
    if (now() - (+s.pop_computed_at || 0) > 6 * 3600) summary.scored = await recomputePopularity(env, s);
    else summary.scored = await recomputePopularity(env, s, { onlyMissing: true });
    return summary;
  } finally {
    await env.DB.prepare("UPDATE settings SET value = '0' WHERE key = 'tick_lock'").run();
  }
}
