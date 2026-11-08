// Admin API (/api/admin/*) and the Flickr OAuth pages (/admin/flickr/*). Auth is enforced in index.js.
import { json, err, readJson, HttpError, now, safeJson, chunk } from '../lib/util.js';
import { getSettings, setSetting, log } from '../lib/settings.js';
import { seal, unseal } from '../lib/crypto.js';
import { loadApp, apiUsage, Flickr, RateLimited } from '../flickr/api.js';
import { FLICKR_IMG_HEADERS, candidatesFor, storeImage } from '../sync/ingest.js';
import { getRequestToken, authorizeUrl, getAccessToken } from '../flickr/oauth.js';
import { runTick, startFullRun, applyDeletions, storageUsed } from '../sync/engine.js';
import { mediaAdmin } from './media.js';
import { gettyAdmin } from './getty.js';
import { gettyMatchAdmin } from './gettymatch.js';
import { statsOverview, statsMovers, statsLeaders, statsBreakdown } from '../lib/stats.js';
import { igStats, igSnapshot } from '../lib/igstats.js';
import { tagsAdmin } from './tags.js';
import { foldersAdmin } from './folders.js';
import { featuresAdmin } from './features.js';
import { instagramAdmin } from './instagram.js';
import { setTags, bumpContent } from '../lib/tagging.js';
import { refreshShowcase, sizeStatus, forAccount, estimateAccount } from '../lib/showcase.js';
import { inquiryConfig, sendEmail } from '../lib/inquiry.js';
import { recomputePopularity, weights } from '../lib/popularity.js';

// ---------- OAuth connect flow ----------

export async function adminPages(request, env, url) {
  if (url.pathname === '/admin/flickr/connect') {
    const app = await loadApp(env);
    if (!app) return Response.redirect(`${url.origin}/admin/#settings?error=Save+your+Flickr+API+key+first`, 302);
    const { token, secret } = await getRequestToken(app, `${url.origin}/admin/flickr/callback`);
    await env.DB.prepare('DELETE FROM oauth_pending WHERE created_at < unixepoch() - 3600').run();
    await env.DB.prepare('INSERT INTO oauth_pending (token, secret_enc) VALUES (?1, ?2)').bind(token, await seal(env, secret)).run();
    return Response.redirect(authorizeUrl(token), 302);
  }
  if (url.pathname === '/admin/flickr/callback') {
    const token = url.searchParams.get('oauth_token');
    const verifier = url.searchParams.get('oauth_verifier');
    const pending = token && await env.DB.prepare('SELECT * FROM oauth_pending WHERE token = ?1').bind(token).first();
    if (!pending || !verifier) return Response.redirect(`${url.origin}/admin/#settings?error=Flickr+authorization+expired+—+try+again`, 302);
    const app = await loadApp(env);
    const acc = await getAccessToken(app, token, await unseal(env, pending.secret_enc), verifier);
    // the token only works with the key it was issued for → remember that key on the account
    const sealedSecret = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'flickr_api_secret'").first())?.value || null;
    await env.DB.prepare(
      `INSERT INTO accounts (nsid, username, realname, token_enc, token_secret_enc, app_key, app_secret_enc)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(nsid) DO UPDATE SET username=excluded.username, realname=excluded.realname,
         token_enc=excluded.token_enc, token_secret_enc=excluded.token_secret_enc,
         app_key=excluded.app_key, app_secret_enc=excluded.app_secret_enc, enabled=1, last_error=NULL`
    ).bind(acc.nsid, acc.username, acc.fullname, await seal(env, acc.token), await seal(env, acc.secret), app.key, sealedSecret).run();
    await env.DB.prepare('DELETE FROM oauth_pending WHERE token = ?1').bind(token).run();
    const row = await env.DB.prepare('SELECT id FROM accounts WHERE nsid = ?1').bind(acc.nsid).first();
    await log(env, 'info', `Connected Flickr account ${acc.username} (${acc.nsid})`, row.id);
    return Response.redirect(`${url.origin}/admin/#dashboard?connected=${encodeURIComponent(acc.username)}`, 302);
  }
  return null;
}

// ---------- helpers ----------

function phaseDetail(a) {
  const st = safeJson(a.sync_state);
  if (a.sync_phase === 'list') {
    if (!st) return 'starting full listing';
    return `listing Flickr: ${st.listed} found, ${st.windows.length} date window(s) left`;
  }
  if (a.sync_phase === 'albums') {
    if (!st || st.stage === 'list') return 'reading album list';
    return `reading albums: ${st.queue.length} left`;
  }
  return 'up to date';
}

function inList(ids, from = 1) {
  return ids.map((_, i) => `?${i + from}`).join(',');
}

function cleanIds(body) {
  const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(x => /^\d+$/.test(x)) : [];
  if (!ids.length) throw new HttpError(400, 'No photo ids');
  if (ids.length > 20000) throw new HttpError(400, 'Too many ids');
  return ids;
}

function photoFilters(url) {
  const q = url.searchParams;
  const where = [], args = [];
  const status = q.get('status') || '';
  if (status === 'deleted') where.push("p.status = 'deleted'");
  else {
    where.push("p.status != 'deleted'");
    if (['ok', 'pending', 'meta', 'error'].includes(status)) { args.push(status); where.push(`p.status = ?${args.length}`); }
    if (status === 'hidden') where.push('p.hidden = 1');
    if (status === 'incomplete') where.push("p.status IN ('pending','meta','fetch','error')");
    if (status === 'fetch') where.push("p.status = 'fetch'");
  }
  if (q.get('account')) { args.push(+q.get('account')); where.push(`p.account_id = ?${args.length}`); }
  const vis = q.get('vis');
  if (vis === 'public') where.push('p.is_public = 1');
  if (vis === 'private') where.push('p.is_public = 0');
  const stag = q.get('tag');
  if (stag) {
    args.push(stag);
    where.push(`EXISTS (SELECT 1 FROM photo_tags pt JOIN site_tags t ON t.id = pt.tag_id
      WHERE pt.photo_id = p.id AND pt.source != 'removed' AND t.slug = ?${args.length})`);
  }
  if (q.get('tagsrc') === 'ai') where.push("EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.source = 'ai')");
  const notag = q.get('notag');
  if (notag === 'content' || notag === 'location') {
    args.push(notag);
    where.push(`NOT EXISTS (SELECT 1 FROM photo_tags pt JOIN site_tags t ON t.id = pt.tag_id
      WHERE pt.photo_id = p.id AND pt.source != 'removed' AND t.kind = ?${args.length})`);
  }
  if (q.get('shape') === 'lowres') {
    // stored image noticeably smaller than it should be (e.g. only Flickr's 1024 size could be downloaded)
    where.push(`p.status = 'ok' AND MAX(COALESCE(p.width, 0), COALESCE(p.height, 0)) < 1500
      AND MAX(COALESCE(p.o_width, 0), COALESCE(p.o_height, 0)) >= 2000`);
  }
  if (q.get('shape') === 'pano') {
    args.push(+q.get('ratio') || 2.2);
    // original dimensions when known (stored ones may already be the squashed version)
    where.push(`(MAX(COALESCE(p.o_width, p.width, 0), COALESCE(p.o_height, p.height, 0)) * 1.0
      / MAX(1, MIN(COALESCE(p.o_width, p.width, 0), COALESCE(p.o_height, p.height, 0)))) >= ?${args.length}`);
  }
  const rating = q.get('rating');
  if (rating === 'unrated') where.push('COALESCE(p.rating, 0) = 0');
  else if (/^[1-5]$/.test(rating || '')) where.push(`p.rating = ${+rating}`);
  else if (/^[1-5]\+$/.test(rating || '')) where.push(`p.rating >= ${parseInt(rating)}`);
  const media = q.get('media');
  if (media === 'video') where.push("p.media = 'video'");
  const album = q.get('album');
  if (album === '__none__') where.push('NOT EXISTS (SELECT 1 FROM album_photos ap WHERE ap.photo_id = p.id)');
  else if (album === '__nolocal__') where.push("NOT EXISTS (SELECT 1 FROM album_photos ap WHERE ap.photo_id = p.id AND ap.album_id LIKE 'l:%')");
  else if (album) { args.push(album); where.push(`EXISTS (SELECT 1 FROM album_photos ap WHERE ap.photo_id = p.id AND ap.album_id = ?${args.length})`); }
  const coll = q.get('collection');
  if (coll) {
    args.push(coll);
    where.push(`EXISTS (SELECT 1 FROM album_photos ap JOIN collection_albums ca ON ca.album_id = ap.album_id
      WHERE ap.photo_id = p.id AND ca.collection_id = ?${args.length})`);
  }
  const term = (q.get('q') || '').trim();
  if (term) {
    args.push(`%${term.replace(/[%_]/g, '')}%`);
    const n = args.length;
    where.push(`(p.title LIKE ?${n} OR p.tags LIKE ?${n} OR p.description LIKE ?${n} OR p.raw_tags LIKE ?${n} OR p.location LIKE ?${n} OR p.id = ?${n + 1})`);
    args.push(term);
  }
  const sort = {
    upload: 'p.date_upload DESC', upload_asc: 'p.date_upload ASC',
    taken: 'p.date_taken DESC', taken_asc: 'p.date_taken ASC', title: 'p.title COLLATE NOCASE ASC',
    // Flickr popularity (v0 formula — tune later): a fave is worth 20 views, a comment 10.
    popular: 'COALESCE(p.pop_score, 0) DESC',
    faves: 'COALESCE(p.faves, 0) DESC, COALESCE(p.views, 0) DESC',
    views: 'COALESCE(p.views, 0) DESC', comments: 'COALESCE(p.comments, 0) DESC, COALESCE(p.faves, 0) DESC',
    rating: 'COALESCE(p.rating, 0) DESC, COALESCE(p.pop_score, 0) DESC',
  }[q.get('sort')] || 'p.date_upload DESC';
  const albumOrder = album && !album.startsWith('__') && q.get('sort') === 'album'
    ? `(SELECT position FROM album_photos ap WHERE ap.photo_id = p.id AND ap.album_id = ?${args.indexOf(album) + 1}) ASC` : null;
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', args, order: albumOrder || sort };
}

// ---------- API ----------

// photos the Mac photo fetcher should work on: not stored yet, or stored and being upgraded in the background
const REEL_MAX = 12000; // px, long-edge cap for Aerial reel copies (panoramas)
const FETCH_Q = "(status = 'fetch' OR (status = 'ok' AND refetch = 1))";

export async function adminApi(request, env, ctx, url) {
  const path = url.pathname.replace(/^\/api\/admin/, '') || '/';
  const m = request.method;
  let r;

  if (path === '/tags' || path.startsWith('/tags/')) {
    const res = await tagsAdmin(request, env, path, url);
    if (res) return res;
  }

  if (path === '/folders' || path.startsWith('/folders/')) {
    const res = await foldersAdmin(request, env, path, url);
    if (res) return res;
  }

  if (path.startsWith('/stats/') && m === 'GET') {
    if (path === '/stats/instagram') {
      // first visit: take today's snapshot right away so followers show
      if (!(await env.DB.prepare('SELECT 1 FROM ig_daily LIMIT 1').first())) await igSnapshot(env).catch(() => null);
      return json(await igStats(env, url.searchParams));
    }
    const f = { '/stats/overview': statsOverview, '/stats/movers': statsMovers, '/stats/leaders': statsLeaders, '/stats/breakdown': statsBreakdown }[path];
    if (f) return json(await f(env, url.searchParams));
  }

  if (path.startsWith('/getty/portfolio/') || path.startsWith('/getty/match/') || path.startsWith('/media/getty/')) {
    const res = await gettyMatchAdmin(request, env, path, url);
    if (res) return res;
  }

  if (path.startsWith('/getty/')) {
    const res = await gettyAdmin(request, env, path, url);
    if (res) return res;
  }

  if (path.startsWith('/ig/') || path.startsWith('/media/ig/')) {
    const res = await instagramAdmin(request, env, path, url);
    if (res) return res;
  }

  if (path === '/media/features' || path.startsWith('/media/features/')) {
    const res = await featuresAdmin(request, env, path, url);
    if (res) return res;
  }

  if (path.startsWith('/media') || path.startsWith('/tokens')) {
    const res = await mediaAdmin(request, env, path);
    if (res) return res;
  }

  if (path === '/status' && m === 'GET') {
    const s = await getSettings(env);
    const [accounts, counts, hidden, albums, logs, used, calls, app] = await Promise.all([
      env.DB.prepare(`SELECT id, nsid, username, realname, path_alias, enabled, flickr_count, sync_phase, sync_state,
        run_id, last_full_sync, last_album_sync, last_recent_check, last_error, created_at, app_key, long_edge, base_edge, quality FROM accounts ORDER BY id`).all(),
      env.DB.prepare('SELECT account_id, status, COUNT(*) n, SUM(is_public) pub FROM photos GROUP BY account_id, status').all(),
      env.DB.prepare("SELECT COUNT(*) n FROM photos WHERE hidden = 1 AND status != 'deleted'").first(),
      env.DB.prepare("SELECT source, COUNT(*) n FROM albums GROUP BY source").all(),
      env.DB.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 60').all(),
      storageUsed(env), apiUsage(env), loadApp(env).catch(() => null),
    ]);
    const keyRows = (await env.DB.prepare(
      "SELECT key, updated_at FROM settings WHERE key IN ('flickr_api_key','flickr_api_secret')"
    ).all()).results;
    const savedAt = Object.fromEntries(keyRows.map(r => [r.key, r.updated_at]));
    const byAcc = {};
    for (const row of counts.results) {
      byAcc[row.account_id] ??= { ok: 0, pending: 0, meta: 0, fetch: 0, error: 0, deleted: 0, public: 0 };
      byAcc[row.account_id][row.status] = row.n;
      if (row.status !== 'deleted') byAcc[row.account_id].public += row.pub || 0;
    }
    return json({
      config: {
        apiKey: app ? app.key : null,
        apiKeySavedAt: savedAt.flickr_api_key || null,
        apiSecretSaved: !!savedAt.flickr_api_secret,
        apiSecretSavedAt: savedAt.flickr_api_secret || null,
        encryptionKey: !!env.ENCRYPTION_KEY, images: !!env.IMAGES, bucket: !!env.BUCKET,
        turnstile: !!env.TURNSTILE_SECRET, resend: !!env.RESEND_API_KEY,
        inquiry: await (async () => { const c = await inquiryConfig(env, s); return {
          siteKey: c.siteKey, secret: !!c.turnstileSecret, resend: !!c.resendKey, to: c.to, from: c.from,
          ready: !!(c.siteKey && c.turnstileSecret && c.resendKey && c.to) }; })(),
        callbackUrl: `${url.origin}/admin/flickr/callback`,
      },
      settings: s,
      accounts: accounts.results.map(a => ({
        ...a, sync_state: undefined, phase_detail: phaseDetail(a),
        counts: byAcc[a.id] || { ok: 0, pending: 0, meta: 0, fetch: 0, error: 0, deleted: 0, public: 0 },
      })),
      hidden: hidden.n,
      albums: Object.fromEntries(albums.results.map(x => [x.source, x.n])),
      storage: { used, budget: (parseFloat(s.storage_budget_gb) || 8) * 1e9 },
      api: { calls, budget: parseInt(s.api_budget) || 3000 },
      paused: s.paused === '1',
      metrics: await env.DB.prepare(
        "SELECT COUNT(*) total, SUM(metrics_at IS NOT NULL) fresh, MIN(metrics_at) oldest FROM photos WHERE status = 'ok'"
      ).first(),
      listingHasCounts: s.listing_has_counts ?? null,
      cdn: { rate: +s.cdn_rate || 12, pausedUntil: +s.cdn_pause_until || 0 },
      lowres: (await env.DB.prepare(
        `SELECT COUNT(*) n FROM photos WHERE status = 'ok' AND MAX(COALESCE(width, 0), COALESCE(height, 0)) < 1500
         AND MAX(COALESCE(o_width, 0), COALESCE(o_height, 0)) >= 2000`
      ).first()).n,
      log: logs.results,
      now: now(),
    });
  }

  if (path === '/settings' && m === 'POST') {
    const b = await readJson(request);
    if (b.flickr_api_key !== undefined) {
      const k = String(b.flickr_api_key).trim();
      if (!/^[0-9a-f]{32}$/i.test(k)) throw new HttpError(400, 'Flickr API key should be 32 hex characters');
      await setSetting(env, 'flickr_api_key', k);
    }
    if (b.flickr_api_secret) {
      const sec = String(b.flickr_api_secret).trim();
      if (!/^[0-9a-f]{16}$/i.test(sec)) throw new HttpError(400, 'Flickr API secret should be 16 hex characters');
      await setSetting(env, 'flickr_api_secret', await seal(env, sec));
    }
    const ranges = {
      quality: [30, 100], long_edge: [800, 6000], base_edge: [800, 6000], thumb_edge: [256, 2048], thumb_quality: [30, 100], reel_edge: [2000, 10000], reel_quality: [30, 100],
      api_budget: [100, 3500], storage_budget_gb: [1, 1000], featured_count: [6, 300],
      pano_ratio: [1.5, 10], pano_short: [600, 4000], pano_long_max: [2500, 12000], pano_thumb_short: [300, 1200],
    };
    for (const [k, [lo, hi]] of Object.entries(ranges)) {
      if (b[k] === undefined) continue;
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < lo || v > hi) throw new HttpError(400, `${k} must be between ${lo} and ${hi}`);
      await setSetting(env, k, v);
    }
    if (b.paused !== undefined) await setSetting(env, 'paused', b.paused ? '1' : '0');
    if (b.hotlink_protect !== undefined) await setSetting(env, 'hotlink_protect', String(b.hotlink_protect) === '0' ? '0' : '1');
    if (b.getty_profile_url !== undefined) { const u = String(b.getty_profile_url).trim().slice(0, 500);
      if (u && !/^https:\/\/([a-z0-9-]+\.)*gettyimages\.[a-z.]+\//i.test(u)) return err('The Getty page must be a https://…gettyimages… link', 400);
      await setSetting(env, 'getty_profile_url', u); }
    if (b.hotlink_allow !== undefined) await setSetting(env, 'hotlink_allow', String(b.hotlink_allow).replace(/[^a-z0-9.,\s-]/gi, '').slice(0, 500));
    if (b.featured_album !== undefined) await setSetting(env, 'featured_album', String(b.featured_album || ''));
    // inquiry form: site key and addresses in clear, secrets sealed
    if (b.turnstile_site_key !== undefined) {
      const v = String(b.turnstile_site_key).trim();
      if (v && !/^0x[0-9A-Za-z_-]{10,}$/.test(v)) throw new HttpError(400, 'Turnstile site key looks wrong (it starts with 0x)');
      await setSetting(env, 'turnstile_site_key', v);
    }
    if (b.turnstile_secret) {
      const v = String(b.turnstile_secret).trim();
      if (!/^0x[0-9A-Za-z_-]{10,}$/.test(v)) throw new HttpError(400, 'Turnstile secret key looks wrong (it starts with 0x)');
      await setSetting(env, 'turnstile_secret', await seal(env, v));
    }
    if (b.resend_api_key) {
      const v = String(b.resend_api_key).trim();
      if (!/^re_[0-9A-Za-z_]{10,}$/.test(v)) throw new HttpError(400, 'Resend API key looks wrong (it starts with re_)');
      await setSetting(env, 'resend_api_key', await seal(env, v));
    }
    if (b.inquiry_to !== undefined) {
      const v = String(b.inquiry_to).trim();
      if (v && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v)) throw new HttpError(400, 'Send-to must be one email address');
      await setSetting(env, 'inquiry_to', v);
    }
    if (b.inquiry_from !== undefined) {
      const v = String(b.inquiry_from).trim();
      if (v && !/^([^<>]+<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(v)) throw new HttpError(400, 'From should look like: Name <no-reply@tonyshi.photos>');
      await setSetting(env, 'inquiry_from', v);
    }
    let rescore = false;
    for (const [k, lo, hi] of [['pop_faves', 0, 100], ['pop_views', 0, 100], ['pop_comments', 0, 100], ['pop_decay', 0, 3]]) {
      if (b[k] === undefined) continue;
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < lo || v > hi) throw new HttpError(400, `${k} must be between ${lo} and ${hi}`);
      await setSetting(env, k, v); rescore = true;
    }
    if (b.front_mode !== undefined) {
      if (!['weekly', 'top'].includes(b.front_mode)) throw new HttpError(400, 'front_mode must be weekly or top');
      await setSetting(env, 'front_mode', b.front_mode);
    }
    if (b.front_top_n !== undefined) {
      const v = Math.round(Number(b.front_top_n));
      if (!(v >= 6 && v <= 500)) throw new HttpError(400, 'front_top_n must be between 6 and 500');
      await setSetting(env, 'front_top_n', v);
    }
    if (b.front_order !== undefined) {
      if (!['shuffle', 'daily', 'rank'].includes(b.front_order)) throw new HttpError(400, 'front_order must be shuffle, daily or rank');
      await setSetting(env, 'front_order', b.front_order);
    }
    if (b.fetch_mode !== undefined) {
      if (!['auto', 'fetcher'].includes(b.fetch_mode)) throw new HttpError(400, 'fetch_mode must be auto or fetcher');
      await setSetting(env, 'fetch_mode', b.fetch_mode);
    }
    if (b.home_page !== undefined) {
      if (!['photos', 'aerial'].includes(b.home_page)) throw new HttpError(400, 'home_page must be photos or aerial');
      await setSetting(env, 'home_page', b.home_page);
    }
    if (rescore) return json({ ok: true, rescored: await recomputePopularity(env, await getSettings(env)) });
    return json({ ok: true });
  }

  if (path === '/popularity' && m === 'GET') {
    const st = await getSettings(env);
    const { results } = await env.DB.prepare(
      `SELECT id, title, faves, views, comments, date_upload, date_taken, is_public, hidden, pop_score, metrics_at
       FROM photos WHERE status = 'ok' AND media = 'photo'`
    ).all();
    return json({
      weights: weights(st), computedAt: +st.pop_computed_at || null,
      front: { mode: st.front_mode, n: +st.front_top_n, order: st.front_order },
      photos: results,
    });
  }

  if ((r = path.match(/^\/diag\/(\d+)$/)) && m === 'GET') {
    const p = await env.DB.prepare('SELECT * FROM photos WHERE id = ?1').bind(r[1]).first();
    if (!p) throw new HttpError(404, 'Not found');
    const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?1').bind(p.account_id).first();
    const app = await loadApp(env);
    const fl = await Flickr.forAccount(env, app, 3500, acc);
    const sizes = (await fl.call('flickr.photos.getSizes', { photo_id: p.id })).sizes.size;
    const probe = async (url, headers) => {
      try {
        const res = await fetch(url, { headers: { ...headers, range: 'bytes=0-0' } });
        res.body?.cancel();
        return { status: res.status, type: res.headers.get('content-type'), total: res.headers.get('content-range')?.split('/')[1] || res.headers.get('content-length') };
      } catch (e) { return { error: e.message }; }
    };
    const out = [];
    for (const z of sizes) {
      out.push({ label: z.label, size: `${z.width}×${z.height}`, plain: await probe(z.source, {}), browserLike: await probe(z.source, FLICKR_IMG_HEADERS) });
    }
    return json({ id: p.id, stored: { width: p.width, height: p.height, source: p.source_size, synced_at: p.synced_at }, sizes: out });
  }

  // ---------- photo fetcher (runs on Tony's network; Flickr throttles Cloudflare's shared IPs) ----------
  if (path === '/fetch/queue' && m === 'GET') {
    const limit = Math.min(+url.searchParams.get('limit') || 5, 20);
    // retry=1 (you pressed Start): also take photos cooling down after a failed try — those have an error
    // recorded; a photo actively being worked on has its error cleared when claimed, so it isn't taken twice.
    const retry = url.searchParams.get('retry') === '1' ? 1 : 0;
    const t = now();
    const { results } = await env.DB.prepare(
      `UPDATE photos SET lease_until = ?1, error = NULL WHERE id IN (
         SELECT id FROM photos WHERE ${FETCH_Q}
           AND (lease_until IS NULL OR lease_until < ?2 OR (?4 = 1 AND error IS NOT NULL))
         ORDER BY status = 'fetch' DESC, date_upload DESC LIMIT ?3)
       RETURNING id, account_id, title, o_width, o_height, info, showcase`
    ).bind(t + 1200, t, limit, retry).all();
    const st = await getSettings(env);
    const app = await loadApp(env);
    const clients = new Map();
    const out = [];
    // photos on the Aerial reel also get an extra-large copy
    const inReel = new Set(results.length ? (await env.DB.prepare(
      `SELECT DISTINCT photo_id FROM media_clips WHERE kind = 'photo' AND photo_id IN (SELECT value FROM json_each(?1))`
    ).bind(JSON.stringify(results.map(p => p.id))).all()).results.map(r => r.photo_id) : []);
    const reelEdge = parseInt(st.reel_edge) || 6000;
    const accSet = new Map();
    for (const p of results) {
      try {
        if (!clients.has(p.account_id)) {
          const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?1').bind(p.account_id).first();
          clients.set(p.account_id, await Flickr.forAccount(env, app, parseInt(st.api_budget) || 3000, acc));
          accSet.set(p.account_id, forAccount(st, acc));
        }
        const ps = accSet.get(p.account_id); // this account's sizes / quality
        const reel = inReel.has(p.id);
        // the reel copy must COVER a 16:9 screen reelEdge wide → panoramas need more pixels than their long edge suggests
        const ow = +p.o_width || 0, oh = +p.o_height || 0;
        const reelLong = !reel ? 0 : ow && oh
          ? Math.round(Math.max(ow, oh) * Math.min(1, Math.max(reelEdge / ow, (reelEdge * 9 / 16) / oh), REEL_MAX / Math.max(ow, oh)))
          : reelEdge;
        const c = await candidatesFor(ps, clients.get(p.account_id), p, reelLong);
        out.push({
          id: p.id, title: p.title, bigW: +c.big.width || null, bigH: +c.big.height || null,
          rotation: +safeJson(p.info)?.rotation || 0,
          // everything the fetcher needs to resize locally exactly like the Worker would
          boxes: { master: c.boxes.master, thumb: c.boxes.thumb, needLong: c.boxes.needLong },
          quality: parseInt(ps.quality) || 75, thumbQuality: parseInt(st.thumb_quality) || 72,
          ...(reel ? { reel: { cover: [reelEdge, Math.round(reelEdge * 9 / 16)], maxLong: REEL_MAX, quality: parseInt(st.reel_quality) || 60 } } : {}),
          // with local resizing the 20 MB limit doesn't apply, so the original comes first when it's big enough
          candidates: c.list.map(z => ({ label: z.label, url: z.source, width: +z.width, height: +z.height })),
        });
      } catch (e) {
        await env.DB.prepare('UPDATE photos SET lease_until = NULL WHERE id = ?1').bind(p.id).run();
        if (e instanceof RateLimited) break;
        out.push({ id: p.id, error: e.message });
      }
    }
    const left = await env.DB.prepare(
      `SELECT COUNT(*) n, MIN(CASE WHEN lease_until > ?1 THEN lease_until END) next FROM photos WHERE ${FETCH_Q}`
    ).bind(now()).first();
    // photos the site is still preparing (re-processed, not yet handed over) — they arrive within a minute or two
    const preparing = (await env.DB.prepare("SELECT COUNT(*) n FROM photos WHERE status = 'pending'").first()).n;
    return json({ photos: out, waiting: left.n, preparing, nextRetryAt: out.length ? null : left.next || null });
  }

  if ((r = path.match(/^\/fetch\/(\d+)$/)) && m === 'PUT') {
    const p = await env.DB.prepare('SELECT id, account_id, o_width, o_height, info, status, showcase FROM photos WHERE id = ?1').bind(r[1]).first();
    if (!p) throw new HttpError(404, 'No such photo');
    const q = url.searchParams;
    const len = +request.headers.get('content-length') || 0;
    if (!len) throw new HttpError(411, 'Content-Length required');
    if (len > 20e6) throw new HttpError(413, 'Over 20 MB — send a smaller size');
    const buf = await request.arrayBuffer();
    const st = forAccount(await getSettings(env), await env.DB.prepare('SELECT long_edge, base_edge, quality FROM accounts WHERE id = ?1').bind(p.account_id).first());
    const img = await storeImage(env, st, p,
      { label: q.get('label') || 'fetched', width: +q.get('w') || 0, height: +q.get('h') || 0, bigW: +q.get('bigW') || 0, bigH: +q.get('bigH') || 0 },
      buf, safeJson(p.info)?.rotation);
    return json({ ok: true, width: img.mw, height: img.mh, bytes: img.master.byteLength });
  }

  // two stored sizes: status, and "recheck now"
  if (path === '/photos/sizes' && (m === 'GET' || m === 'POST')) {
    const st = await getSettings(env);
    if (m === 'POST') await refreshShowcase(env, st, { force: true });
    return json(await sizeStatus(env, st));
  }

  if (path === '/fetch/status' && m === 'GET') {
    const st = await getSettings(env);
    const n = (await env.DB.prepare(`SELECT COUNT(*) n FROM photos WHERE ${FETCH_Q}`).first()).n;
    const { results } = await env.DB.prepare(
      `SELECT id, title, o_width, o_height, server, secret, error, attempts, lease_until FROM photos
       WHERE ${FETCH_Q} ORDER BY status = 'fetch' DESC, date_upload DESC LIMIT 200`
    ).all();
    const preparing = (await env.DB.prepare("SELECT COUNT(*) n FROM photos WHERE status = 'pending'").first()).n;
    return json({ waiting: n, preparing, mode: st.fetch_mode, photos: results.map(p => ({
      id: p.id, title: p.title, width: p.o_width, height: p.o_height, error: p.error, attempts: p.attempts,
      busy: (p.lease_until || 0) > now(),
      thumb: p.server && p.secret ? `https://live.staticflickr.com/${p.server}/${p.id}_${p.secret}_q.jpg` : null,
    })) });
  }

  // Resized on the fetcher's machine: it uploads the finished master (JPEG) and thumb (WebP), then /done.
  if ((r = path.match(/^\/fetch\/(\d+)\/(master|thumb|reel)$/)) && m === 'PUT') {
    const p = await env.DB.prepare('SELECT id, account_id FROM photos WHERE id = ?1').bind(r[1]).first();
    if (!p) throw new HttpError(404, 'No such photo');
    const len = +request.headers.get('content-length') || 0;
    if (!len) throw new HttpError(411, 'Content-Length required');
    if (len > 30e6) throw new HttpError(413, 'Too large');
    if (r[2] === 'reel') {
      await env.BUCKET.put(`p/${p.id}.r.jpg`, request.body, { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: { account: String(p.account_id), staged: '1' } });
      return json({ ok: true, bytes: len });
    }
    const master = r[2] === 'master';
    // thumbs are WebP when the Mac can make them, JPEG otherwise (same key; the stored content type is what's served)
    const type = master ? 'image/jpeg' : (request.headers.get('content-type') === 'image/jpeg' ? 'image/jpeg' : 'image/webp');
    await env.BUCKET.put(master ? `p/${p.id}.jpg` : `p/${p.id}.webp`, request.body, {
      httpMetadata: { contentType: type }, customMetadata: { account: String(p.account_id), staged: '1' },
    });
    return json({ ok: true, bytes: len });
  }
  if ((r = path.match(/^\/fetch\/(\d+)\/done$/)) && m === 'POST') {
    const b = await readJson(request);
    const p = await env.DB.prepare('SELECT id, account_id FROM photos WHERE id = ?1').bind(r[1]).first();
    if (!p) throw new HttpError(404, 'No such photo');
    const [sm, st2] = await Promise.all([env.BUCKET.get(`p/${p.id}.jpg`), env.BUCKET.get(`p/${p.id}.webp`)]);
    if (!sm || !st2) throw new HttpError(400, 'Upload master and thumb first');
    const meta = { account: String(p.account_id), source: String(b.label || 'fetched'), resized: 'fetcher' };
    // move staged files into place only once both are complete, so a half-finished upload never shows
    const [mBuf, tBuf] = [await sm.arrayBuffer(), await st2.arrayBuffer()];
    await env.BUCKET.put(`m/${p.id}.jpg`, mBuf, { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: meta });
    await env.BUCKET.put(`t/${p.id}.webp`, tBuf, { httpMetadata: { contentType: st2.httpMetadata?.contentType || 'image/webp' }, customMetadata: meta });
    await env.BUCKET.delete([`p/${p.id}.jpg`, `p/${p.id}.webp`]);
    const n = v => Math.max(1, Math.round(+v || 0));
    // extra-large copy for the Aerial reel, when the app made one
    const sr = b.reel ? await env.BUCKET.get(`p/${p.id}.r.jpg`) : null;
    if (sr) {
      await env.BUCKET.put(`r/${p.id}.jpg`, await sr.arrayBuffer(), { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: meta });
      await env.BUCKET.delete(`p/${p.id}.r.jpg`);
      await env.DB.prepare('UPDATE photos SET reel_w = ?2, reel_h = ?3 WHERE id = ?1').bind(p.id, n(b.reel.width), n(b.reel.height)).run();
    }
    await env.DB.prepare(
      `UPDATE photos SET width=?2, height=?3, bytes=?4, thumb_w=?5, thumb_h=?6, thumb_bytes=?7, source_size=?8,
         status='ok', refetch=0, attempts=0, error=NULL, lease_until=NULL, synced_at=?9, best_edge=?10, best_at=?9 WHERE id=?1`
    ).bind(p.id, n(b.master?.width), n(b.master?.height), mBuf.byteLength, n(b.thumb?.width), n(b.thumb?.height), tBuf.byteLength,
      String(b.label || 'fetched'), now(),
      // the source the app used (newer app versions say); otherwise what we stored is the best we know of
      b.source?.width ? Math.max(n(b.source.width), n(b.source.height)) : Math.max(n(b.master?.width), n(b.master?.height))).run();
    return json({ ok: true });
  }

  if ((r = path.match(/^\/fetch\/(\d+)\/release$/)) && m === 'POST') {
    const b = await readJson(request);
    const msg = String(b.error || 'fetcher could not download').slice(0, 500);
    await env.DB.prepare(
      `UPDATE photos SET lease_until = ?3, attempts = attempts + 1, error = ?2,
         status = CASE WHEN status = 'fetch' AND attempts + 1 >= 5 THEN 'error' ELSE status END,
         refetch = CASE WHEN refetch = 1 AND attempts + 1 >= 5 THEN 0 ELSE refetch END -- upgrade gives up; the current copy stays
       WHERE id = ?1 AND ${FETCH_Q}`
    ).bind(r[1], msg, now() + (b.retryAfter ? +b.retryAfter : 120)).run();
    return json({ ok: true });
  }

  if (path === '/inquiry/test' && m === 'POST') {
    const cfg = await inquiryConfig(env);
    if (!cfg.resendKey || !cfg.to) throw new HttpError(400, 'Save a Resend API key and a send-to address first.');
    try {
      const r = await sendEmail(cfg, {
        subject: '[tonyshi.photos] Test — your inquiry form email works',
        text: `This is a test from the tonyshi.photos admin.\nInquiries will arrive at ${cfg.to}, sent from ${cfg.from}.\n`,
      });
      return json({ ok: true, id: r.id, to: cfg.to });
    } catch (e) { throw new HttpError(400, e.message); }
  }

  if (path === '/sync/run' && m === 'POST') {
    ctx.waitUntil(runTick(env, { force: true }).then(x => console.log('manual tick', JSON.stringify(x))));
    return json({ started: true });
  }

  // per-account sizes / quality (null = use Settings); estimate = rough storage at those values
  if ((r = path.match(/^\/accounts\/(\d+)\/sizes$/))) {
    const st = await getSettings(env);
    const v = (x, lo, hi) => (x === null || x === '' || x === undefined ? null : Math.max(lo, Math.min(hi, Math.round(+x) || 0)) || null);
    if (m === 'GET') {
      const q = url.searchParams;
      const acc = await env.DB.prepare('SELECT long_edge, base_edge, quality FROM accounts WHERE id = ?1').bind(+r[1]).first();
      if (!acc) throw new HttpError(404, 'No such account');
      const eff = forAccount(st, acc);
      const want = { long: v(q.get('long'), 800, 8000) || +eff.long_edge, base: v(q.get('base'), 800, 8000) || +eff.base_edge, quality: v(q.get('q'), 30, 100) || +eff.quality };
      const est = await estimateAccount(env, st, +r[1], want);
      return json({ ...acc, global: { long_edge: +st.long_edge, base_edge: +st.base_edge, quality: +st.quality }, want, estimate: est,
        storage: { used: await storageUsed(env), budget: (parseFloat(st.storage_budget_gb) || 9.5) * 1e9 } });
    }
    if (m === 'POST') {
      const b = await readJson(request);
      await env.DB.prepare('UPDATE accounts SET long_edge = ?2, base_edge = ?3, quality = ?4 WHERE id = ?1')
        .bind(+r[1], v(b.long_edge, 800, 8000), v(b.base_edge, 800, 8000), v(b.quality, 30, 100)).run();
      const res = await refreshShowcase(env, st, { force: true });
      await log(env, 'info', `Account sizes set: ${b.long_edge || 'default'} / ${b.base_edge || 'default'} px, quality ${b.quality || 'default'}`, +r[1]);
      return json({ ok: true, ...res });
    }
  }

  if ((r = path.match(/^\/accounts\/(\d+)\/([a-z-]+)$/)) && m === 'POST') {
    const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?1').bind(+r[1]).first();
    if (!acc) throw new HttpError(404, 'No such account');
    switch (r[2]) {
      case 'pause': await env.DB.prepare('UPDATE accounts SET enabled = 0 WHERE id = ?1').bind(acc.id).run(); break;
      case 'resume': await env.DB.prepare('UPDATE accounts SET enabled = 1 WHERE id = ?1').bind(acc.id).run(); break;
      case 'resync': await startFullRun(env, acc); await log(env, 'info', 'Full resync requested', acc.id); break;
      case 'albums': {
        // also restarts an album sync that's already under way (so a re-org on Flickr is picked up from the start)
        const r2 = await env.DB.prepare("UPDATE accounts SET sync_phase='albums', sync_state=NULL WHERE id=?1 AND sync_phase IN ('idle', 'albums')").bind(acc.id).run();
        if (!r2.meta.changes) return json({ ok: false, message: 'A full photo listing is running for this account — albums and collections sync right after it' });
        break;
      }
      case 'apply-deletions': {
        const n = await applyDeletions(env, acc);
        await env.DB.prepare('UPDATE accounts SET last_error = NULL WHERE id = ?1').bind(acc.id).run();
        await log(env, 'info', `Confirmed: marked ${n} photos deleted`, acc.id);
        return json({ ok: true, deleted: n });
      }
      default: throw new HttpError(400, 'Unknown action');
    }
    return json({ ok: true });
  }

  if (path === '/maintenance/retry-errors' && m === 'POST') {
    const x = await env.DB.prepare(
      "UPDATE photos SET status='pending', attempts=0, error=NULL, lease_until=NULL WHERE status='error'"
    ).run();
    return json({ ok: true, retried: x.meta.changes });
  }

  if (path === '/maintenance/purge-deleted' && m === 'POST') {
    const { results } = await env.DB.prepare("SELECT id FROM photos WHERE status='deleted' LIMIT 400").all();
    const ids = results.map(x => x.id);
    if (ids.length) {
      await env.BUCKET.delete(ids.flatMap(id => [`m/${id}.jpg`, `t/${id}.webp`, `s/${id}.webp`]));
      for (const part of chunk(ids, 90)) {
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM album_photos WHERE photo_id IN (${inList(part)})`).bind(...part),
          env.DB.prepare(`DELETE FROM photos WHERE id IN (${inList(part)})`).bind(...part),
        ]);
      }
      await log(env, 'info', `Purged ${ids.length} deleted photos from R2 and the catalog`);
    }
    return json({ ok: true, purged: ids.length });
  }

  if (path === '/photos' && m === 'GET') {
    const f = photoFilters(url);
    const limit = Math.min(+url.searchParams.get('limit') || 200, 500);
    const offset = Math.max(+url.searchParams.get('offset') || 0, 0);
    const [rows, total] = await Promise.all([
      env.DB.prepare(`SELECT p.id, p.account_id, p.title, p.status, p.is_public, p.is_friend, p.is_family, p.hidden, p.rating,
          p.media, p.width, p.height, p.o_width, p.o_height, p.thumb_w, p.thumb_h, p.date_taken, p.date_upload,
          p.server, p.secret, p.error, p.views, p.faves, p.comments, p.pop_score, p.synced_at
        FROM photos p ${f.where} ORDER BY ${f.order}, p.id LIMIT ${limit} OFFSET ${offset}`).bind(...f.args).all(),
      env.DB.prepare(`SELECT COUNT(*) n FROM photos p ${f.where}`).bind(...f.args).first(),
    ]);
    return json({ total: total.n, offset, photos: rows.results });
  }

  if (path === '/photos/ids' && m === 'GET') {
    const f = photoFilters(url);
    const { results } = await env.DB.prepare(`SELECT p.id FROM photos p ${f.where} ORDER BY ${f.order} LIMIT 20000`).bind(...f.args).all();
    return json({ ids: results.map(x => x.id) });
  }

  if ((r = path.match(/^\/photos\/(\d+)$/)) && m === 'GET') {
    const p = await env.DB.prepare('SELECT * FROM photos WHERE id = ?1').bind(r[1]).first();
    if (!p) throw new HttpError(404, 'Not found');
    const albums = await env.DB.prepare(
      'SELECT a.id, a.title, a.source FROM album_photos ap JOIN albums a ON a.id = ap.album_id WHERE ap.photo_id = ?1 ORDER BY a.source DESC, a.title'
    ).bind(p.id).all();
    const siteTags = await env.DB.prepare(
      `SELECT t.slug, t.label, t.kind, pt.source FROM photo_tags pt JOIN site_tags t ON t.id = pt.tag_id
       WHERE pt.photo_id = ?1 AND pt.source != 'removed' ORDER BY t.kind, t.label`
    ).bind(p.id).all();
    const collections = await env.DB.prepare(
      `SELECT DISTINCT c.id, c.title FROM album_photos ap JOIN collection_albums ca ON ca.album_id = ap.album_id
       JOIN collections c ON c.id = ca.collection_id WHERE ap.photo_id = ?1 ORDER BY c.title`
    ).bind(p.id).all();
    const instagram = (await env.DB.prepare(
      `SELECT m.id, m.permalink, m.ts, m.like_count, m.comments_count, l.status FROM ig_links l JOIN ig_media m ON m.id = l.ig_id
       WHERE l.photo_id = ?1 AND l.status IN ('confirmed', 'auto') AND m.deleted = 0 ORDER BY m.ts`
    ).bind(p.id).all().catch(() => ({ results: [] }))).results;
    const getty = (await env.DB.prepare(
      `SELECT a.asset_id, a.artist, a.title, a.collection, a.license_model, a.page_url, a.in_portfolio, a.submitted_at,
         CASE WHEN a.linked_photo_id = ?1 THEN 'you' ELSE (SELECT l.how FROM getty_links l WHERE l.asset_id = a.asset_id AND l.photo_id = ?1) END how,
         (SELECT COUNT(*) FROM getty_sales s WHERE s.asset_id = a.asset_id) sales, (SELECT ROUND(SUM(royalty), 2) FROM getty_sales s WHERE s.asset_id = a.asset_id) royalty
       FROM getty_assets a WHERE COALESCE(NULLIF(a.linked_photo_id, ''), a.photo_id) = ?1 ORDER BY a.submitted_at`
    ).bind(p.id).all().catch(() => ({ results: [] }))).results;
    const info = safeJson(p.info);
    return json({
      instagram, getty,
      collections: collections.results,
      siteTags: siteTags.results,
      ...p, info: undefined,
      exif: safeJson(p.exif), location: safeJson(p.location), raw_tags: safeJson(p.raw_tags, []),
      flickr: info ? {
        rotation: info.rotation, safety_level: info.safety_level, comments: info.comments?._content,
        notes: info.notes?.note?.length || 0, people: info.people?.haspeople,
        usage: info.usage, visibility: info.visibility, owner: info.owner,
      } : null,
      albums: albums.results,
    });
  }

  if (path === '/photos/bulk' && m === 'POST') {
    const b = await readJson(request);
    const ids = cleanIds(b);
    if (b.rating !== undefined) {
      const v = Math.max(0, Math.min(5, parseInt(b.rating) || 0));
      for (const part of chunk(ids, 90)) await env.DB.prepare(`UPDATE photos SET rating = ?1 WHERE id IN (${inList(part, 2)})`).bind(v, ...part).run();
      await bumpContent(env); // album-builder folders that leave out low ratings change
      return json({ ok: true, updated: ids.length, rating: v });
    }
    if (Array.isArray(b.addTags) || Array.isArray(b.removeTags)) {
      const add = (b.addTags || []).map(String), rem = (b.removeTags || []).map(String);
      for (const part of chunk(ids, 200)) {
        if (add.length) await setTags(env, part, add, { source: 'manual' });
        if (rem.length) await setTags(env, part, rem, { remove: true });
      }
      return json({ ok: true, updated: ids.length });
    }
    if (b.fetch === true) {
      // straight to the Mac photo fetcher (skips the Worker's own download attempt)
      let n = 0;
      for (const part of chunk(ids, 90)) {
        const a = await env.DB.prepare(`UPDATE photos SET refetch = 1, attempts = 0, error = NULL, lease_until = NULL
             WHERE id IN (${inList(part)}) AND status = 'ok'`).bind(...part).run();
        const c = await env.DB.prepare(`UPDATE photos SET status = 'fetch', attempts = 0, error = NULL, lease_until = NULL
             WHERE id IN (${inList(part)}) AND status IN ('meta', 'error', 'pending', 'fetch')`).bind(...part).run();
        n += (a.meta.changes || 0) + (c.meta.changes || 0);
      }
      await log(env, 'info', `Sent ${n} photo(s) to the Mac photo fetcher`);
      return json({ ok: true, queued: n });
    }
    if (b.reprocess === true) {
      let n = 0;
      for (const part of chunk(ids, 90)) {
        const r = await env.DB.prepare(
          `UPDATE photos SET status = 'pending', attempts = 0, error = NULL, lease_until = NULL
           WHERE id IN (${inList(part)}) AND status IN ('ok', 'meta', 'error', 'fetch')`
        ).bind(...part).run();
        n += r.meta.changes || 0;
      }
      await log(env, 'info', `Re-processing ${n} photo(s) on request`);
      return json({ ok: true, queued: n });
    }
    if (typeof b.hidden !== 'boolean') throw new HttpError(400, 'Nothing to change');
    for (const part of chunk(ids, 90)) {
      await env.DB.prepare(`UPDATE photos SET hidden = ?${part.length + 1} WHERE id IN (${inList(part)})`)
        .bind(...part, b.hidden ? 1 : 0).run();
    }
    await bumpContent(env);
    return json({ ok: true, updated: ids.length });
  }

  if (path === '/collections' && m === 'GET') {
    const [cols, links] = await Promise.all([
      env.DB.prepare(
        `SELECT c.*, acc.username AS account_name,
           (SELECT COUNT(DISTINCT ap.photo_id) FROM collection_albums ca JOIN album_photos ap ON ap.album_id = ca.album_id
            WHERE ca.collection_id = c.id) AS n
         FROM collections c LEFT JOIN accounts acc ON acc.id = c.account_id
         ORDER BY c.account_id, c.position`
      ).all(),
      env.DB.prepare(
        `SELECT ca.collection_id, a.id AS album_id, a.title, a.photo_count FROM collection_albums ca
         JOIN albums a ON a.id = ca.album_id WHERE ca.direct = 1 ORDER BY ca.position`
      ).all(),
    ]);
    return json({ collections: cols.results, albums: links.results });
  }

  if (path === '/albums' && m === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT a.*, acc.username AS account_name,
        (SELECT COUNT(*) FROM album_photos ap WHERE ap.album_id = a.id) AS n
       FROM albums a LEFT JOIN accounts acc ON acc.id = a.account_id
       ORDER BY CASE a.source WHEN 'local' THEN 0 ELSE 1 END, a.account_id, COALESCE(a.position, 1e9), a.title COLLATE NOCASE`
    ).all();
    return json({ albums: results });
  }

  if (path === '/albums' && m === 'POST') {
    const b = await readJson(request);
    const title = String(b.title || '').trim().slice(0, 200);
    if (!title) throw new HttpError(400, 'Album needs a title');
    const id = `l:${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO albums (id, source, title, description) VALUES (?1, 'local', ?2, ?3)")
      .bind(id, title, String(b.description || '').slice(0, 5000)).run();
    return json({ ok: true, id });
  }

  if ((r = path.match(/^\/albums\/([^/]+)(\/photos)?$/))) {
    const id = decodeURIComponent(r[1]);
    const album = await env.DB.prepare('SELECT * FROM albums WHERE id = ?1').bind(id).first();
    if (!album) throw new HttpError(404, 'No such album');
    if (album.source !== 'local' && m !== 'GET') throw new HttpError(400, 'Flickr albums are mirrored read-only — make changes on Flickr');

    if (!r[2] && m === 'PATCH') {
      const b = await readJson(request);
      await env.DB.prepare(
        `UPDATE albums SET title = COALESCE(?2, title), description = COALESCE(?3, description),
           cover_photo_id = COALESCE(?4, cover_photo_id), updated_at = unixepoch() WHERE id = ?1`
      ).bind(id, b.title ? String(b.title).slice(0, 200) : null,
        b.description !== undefined ? String(b.description).slice(0, 5000) : null,
        b.cover_photo_id ? String(b.cover_photo_id) : null).run();
      return json({ ok: true });
    }
    if (!r[2] && m === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM album_photos WHERE album_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM albums WHERE id = ?1').bind(id),
      ]);
      return json({ ok: true });
    }
    if (r[2] && m === 'POST') {
      const b = await readJson(request);
      const ids = cleanIds(b);
      if (b.action === 'remove') {
        for (const part of chunk(ids, 90)) {
          await env.DB.prepare(`DELETE FROM album_photos WHERE album_id = ?${part.length + 1} AND photo_id IN (${inList(part)})`)
            .bind(...part, id).run();
        }
      } else {
        const start = (await env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM album_photos WHERE album_id = ?1').bind(id).first()).n;
        const stmts = ids.map((pid, i) => env.DB.prepare(
          'INSERT OR IGNORE INTO album_photos (album_id, photo_id, position) VALUES (?1, ?2, ?3)'
        ).bind(id, pid, start + i));
        for (const part of chunk(stmts, 100)) await env.DB.batch(part);
      }
      const n = (await env.DB.prepare('SELECT COUNT(*) n FROM album_photos WHERE album_id = ?1').bind(id).first()).n;
      await env.DB.prepare(
        `UPDATE albums SET photo_count = ?2, updated_at = unixepoch(),
           cover_photo_id = CASE WHEN cover_photo_id IN (SELECT photo_id FROM album_photos WHERE album_id = ?1)
             THEN cover_photo_id ELSE (SELECT photo_id FROM album_photos WHERE album_id = ?1 ORDER BY position LIMIT 1) END
         WHERE id = ?1`
      ).bind(id, n).run();
      return json({ ok: true, count: n });
    }
  }

  if ((r = path.match(/^\/img\/(\d+)\/(t|m)$/)) && m === 'GET') {
    const key = r[2] === 't' ? `t/${r[1]}.webp` : `m/${r[1]}.jpg`;
    const obj = await env.BUCKET.get(key);
    if (!obj) return new Response('Not stored yet', { status: 404 });
    return new Response(obj.body, {
      headers: {
        'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
        'cache-control': 'private, max-age=3600', etag: obj.httpEtag,
      },
    });
  }

  return err('Not found', 404);
}
