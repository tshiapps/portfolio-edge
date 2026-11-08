// Stats: our own daily memory of every photo's Flickr counts (Flickr keeps 28 days, we keep everything), Flickr's
// stats API for daily views and referring sites (Pro accounts), and the queries behind the admin Stats page.
import { now } from './util.js';
import { getSettings, setSetting, log } from './settings.js';
import { Flickr, loadApp, RateLimited, FlickrError } from '../flickr/api.js';
import { igSnapshot } from './igstats.js';

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const addDays = (d, n) => day(Date.parse(d + 'T00:00:00Z') + n * 86400e3);

// ---------- collecting (cron) ----------
// once a day: snapshot changed counts + account totals
export async function snapshot(env, d = day()) {
  const r = await env.DB.prepare(
    `INSERT OR REPLACE INTO photo_hist (photo_id, day, views, faves, comments, tsp)
     SELECT p.id, ?1, COALESCE(p.views, 0), COALESCE(p.faves, 0), COALESCE(p.comments, 0), COALESCE(p.tsp_views, 0) FROM photos p
     LEFT JOIN photo_hist h ON h.photo_id = p.id AND h.day = (SELECT MAX(day) FROM photo_hist x WHERE x.photo_id = p.id AND x.day < ?1)
     WHERE p.status = 'ok' AND (h.photo_id IS NULL OR h.views != COALESCE(p.views, 0) OR h.faves != COALESCE(p.faves, 0)
       OR h.comments != COALESCE(p.comments, 0) OR h.tsp != COALESCE(p.tsp_views, 0))`
  ).bind(d).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO account_daily (account_id, day, photos, views, faves, comments, tsp)
     SELECT account_id, ?1, COUNT(*), SUM(COALESCE(views, 0)), SUM(COALESCE(faves, 0)), SUM(COALESCE(comments, 0)), SUM(COALESCE(tsp_views, 0))
     FROM photos WHERE status = 'ok' GROUP BY account_id`
  ).bind(d).run();
  return r.meta.changes || 0;
}

// Flickr stats API, per account: the last 28 days on the first run, then whatever day is missing (a few per tick)
async function flickrStats(env, s, acc, fl, budget) {
  const have = new Set((await env.DB.prepare('SELECT day FROM flickr_daily WHERE account_id = ?1 AND day >= ?2').bind(acc.id, addDays(day(), -28)).all()).results.map(r => r.day));
  let n = 0;
  for (let i = 1; i <= 28 && n < budget; i++) {
    const d = addDays(day(), -i);
    if (have.has(d)) continue;
    n++;
    const t = (await fl.call('flickr.stats.getTotalViews', { date: d })).stats;
    const v = k => +t?.[k]?.views || 0;
    const doms = (await fl.call('flickr.stats.getPhotostreamDomains', { date: d, per_page: 100 }).catch(e => { if (e instanceof RateLimited) throw e; return null; }))?.domains?.domain || [];
    await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO flickr_daily (account_id, day, total, photos, photostream, sets, galleries, collections) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
        .bind(acc.id, d, v('total'), v('photos'), v('photostream'), v('sets'), v('galleries'), v('collections')),
      ...doms.map(x => env.DB.prepare('INSERT OR REPLACE INTO flickr_domains (account_id, day, domain, views) VALUES (?1, ?2, ?3, ?4)').bind(acc.id, d, String(x.name || '?'), +x.views || 0)),
    ]);
  }
  return n;
}

export async function statsTick(env, s) {
  const out = {};
  const today = day();
  if (s.stats_day !== today) { // first tick of the UTC day
    out.snapshot = await snapshot(env, today);
    try { const ig = await igSnapshot(env, today); if (ig) out.instagram = ig; } catch (e) { console.error('ig snapshot', e); }
    await setSetting(env, 'stats_day', today);
  }
  // Flickr's stats API: Pro accounts only; a free account is re-checked weekly
  const app = await loadApp(env);
  if (!app) return out;
  const accs = (await env.DB.prepare('SELECT * FROM accounts WHERE enabled = 1').all()).results;
  for (const acc of accs) {
    if (acc.stats_ok === 0 && now() - (acc.stats_checked || 0) < 7 * 86400) continue;
    try {
      const fl = await Flickr.forAccount(env, app, +s.api_budget || 3000, acc);
      const n = await flickrStats(env, s, acc, fl, 4);
      if (acc.stats_ok !== 1) await env.DB.prepare('UPDATE accounts SET stats_ok = 1, stats_checked = ?2 WHERE id = ?1').bind(acc.id, now()).run();
      if (n) out[`flickr_${acc.id}`] = n;
    } catch (e) {
      if (e instanceof RateLimited) break;
      // "Stats are only available to Pro members" and similar → not available for this account
      await env.DB.prepare('UPDATE accounts SET stats_ok = 0, stats_checked = ?2 WHERE id = ?1').bind(acc.id, now()).run();
      if (acc.stats_ok !== 0) await log(env, 'info', `Flickr stats not available for this account (${e.message}) — only Pro accounts have them`, acc.id);
    }
  }
  return out;
}

// ---------- the page ----------
const PH = "p.status = 'ok'";
const accWhere = (a, col = 'p.account_id') => (a ? ` AND ${col} = ${+a}` : '');

export async function statsOverview(env, q) {
  const a = +q.get('account') || 0, period = Math.min(365, Math.max(7, +q.get('period') || 30));
  const today = day(), from = addDays(today, -period), prevFrom = addDays(today, -2 * period);
  const [tot, accs, firstSnap, series, fseries, domains, uploads] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) photos, SUM(COALESCE(views, 0)) views, SUM(COALESCE(faves, 0)) faves, SUM(COALESCE(comments, 0)) comments,
      SUM(COALESCE(galleries, 0)) galleries, SUM(COALESCE(tsp_views, 0)) tsp, SUM(COALESCE(faves, 0) > 0) faved FROM photos p WHERE ${PH}${accWhere(a)}`).first(),
    env.DB.prepare('SELECT id, username, stats_ok FROM accounts ORDER BY id').all(),
    env.DB.prepare('SELECT MIN(day) d FROM account_daily').first(),
    env.DB.prepare(`SELECT day, SUM(views) views, SUM(faves) faves, SUM(comments) comments, SUM(tsp) tsp FROM account_daily
      WHERE day >= ?1${accWhere(a, 'account_id')} GROUP BY day ORDER BY day`).bind(prevFrom).all(),
    env.DB.prepare(`SELECT day, SUM(total) total, SUM(photos) photos, SUM(photostream) photostream, SUM(sets) sets FROM flickr_daily
      WHERE day >= ?1${accWhere(a, 'account_id')} GROUP BY day ORDER BY day`).bind(prevFrom).all(),
    env.DB.prepare(`SELECT domain, SUM(views) views FROM flickr_domains WHERE day >= ?1${accWhere(a, 'account_id')} GROUP BY domain ORDER BY views DESC LIMIT 25`).bind(from).all(),
    env.DB.prepare(`SELECT strftime('%Y-%m', date_upload, 'unixepoch') m, COUNT(*) n, AVG(COALESCE(views, 0)) av, AVG(COALESCE(faves, 0)) af
      FROM photos p WHERE ${PH}${accWhere(a)} AND date_upload IS NOT NULL GROUP BY m ORDER BY m`).all(),
  ]);
  // daily gains from our own totals (consecutive days)
  const gains = [];
  const s = series.results;
  for (let i = 1; i < s.length; i++) gains.push({ day: s[i].day, views: s[i].views - s[i - 1].views, faves: s[i].faves - s[i - 1].faves, comments: s[i].comments - s[i - 1].comments, tsp: s[i].tsp - s[i - 1].tsp });
  const sum = (list, k, lo, hi) => list.filter(g => g.day > lo && g.day <= hi).reduce((t, g) => t + (g[k] || 0), 0);
  const fl = fseries.results;
  const period2 = {
    views: fl.length ? sum(fl, 'total', from, today) : sum(gains, 'views', from, today),
    viewsPrev: fl.length ? sum(fl, 'total', prevFrom, from) : sum(gains, 'views', prevFrom, from),
    faves: sum(gains, 'faves', from, today), favesPrev: sum(gains, 'faves', prevFrom, from),
    comments: sum(gains, 'comments', from, today), tsp: sum(gains, 'tsp', from, today),
    source: fl.length ? 'flickr' : 'snapshots',
  };
  return {
    period, account: a, accounts: accs.results, totals: tot, since: firstSnap?.d || null, inPeriod: period2,
    daily: fl.length ? fl.filter(x => x.day > from).map(x => ({ day: x.day, views: x.total, photos: x.photos, photostream: x.photostream, sets: x.sets }))
      : gains.filter(g => g.day > from),
    dailySource: period2.source, domains: domains.results, uploads: uploads.results,
  };
}

// photos that gained the most (views / faves) in the period — from our snapshots
export async function statsMovers(env, q) {
  const a = +q.get('account') || 0, period = Math.min(365, Math.max(1, +q.get('period') || 30));
  const by = q.get('by') === 'faves' ? 'faves' : q.get('by') === 'comments' ? 'comments' : q.get('by') === 'tsp' ? 'tsp' : 'views';
  const from = addDays(day(), -period);
  const { results } = await env.DB.prepare(
    `WITH base AS (SELECT h.photo_id, h.${by} v FROM photo_hist h
                   WHERE h.day = COALESCE((SELECT MAX(day) FROM photo_hist x WHERE x.photo_id = h.photo_id AND x.day <= ?1),
                                          (SELECT MIN(day) FROM photo_hist x WHERE x.photo_id = h.photo_id)))
     SELECT p.id, p.title, p.synced_at v, p.views, p.faves, p.comments, p.tsp_views tsp, p.date_upload,
       COALESCE(p.${by === 'tsp' ? 'tsp_views' : by}, 0) - COALESCE(b.v, 0) gain, b.v IS NULL fresh
     FROM photos p LEFT JOIN base b ON b.photo_id = p.id
     WHERE ${PH}${accWhere(a)} AND (b.v IS NOT NULL OR p.date_upload >= ?2)
     ORDER BY gain DESC LIMIT 40`
  ).bind(from, Math.floor(Date.parse(from) / 1000)).all();
  return { by, period, photos: results.filter(r => r.gain > 0) };
}

const SORTS = { views: 'COALESCE(p.views, 0) DESC', faves: 'COALESCE(p.faves, 0) DESC', comments: 'COALESCE(p.comments, 0) DESC',
  rate: '(COALESCE(p.faves, 0) * 1000.0 / MAX(COALESCE(p.views, 0), 1)) DESC', tsp: 'COALESCE(p.tsp_views, 0) DESC', galleries: 'COALESCE(p.galleries, 0) DESC' };
export async function statsLeaders(env, q) {
  const a = +q.get('account') || 0, sort = SORTS[q.get('sort')] ? q.get('sort') : 'views';
  // fave rate needs enough views to mean something
  const min = sort === 'rate' ? ' AND COALESCE(p.views, 0) >= 300' : '';
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.title, p.synced_at v, p.views, p.faves, p.comments, p.galleries, p.tsp_views tsp, p.date_upload, p.account_id,
       (SELECT SUM(m.like_count) FROM ig_links l JOIN ig_media m ON m.id = l.ig_id WHERE l.photo_id = p.id AND l.status IN ('confirmed', 'auto') AND m.deleted = 0 AND m.position = 0) ig,
       (SELECT COUNT(*) FROM getty_sales s JOIN getty_assets g ON g.asset_id = s.asset_id WHERE COALESCE(NULLIF(g.linked_photo_id, ''), g.photo_id) = p.id) getty
     FROM photos p WHERE ${PH}${accWhere(a)}${min} ORDER BY ${SORTS[sort]}, p.id LIMIT 50`
  ).all();
  return { sort, photos: results };
}

// what works: average performance by year taken, camera, country, content tag, album
export async function statsBreakdown(env, q) {
  const a = +q.get('account') || 0, by = q.get('by') || 'year';
  const AGG = `COUNT(*) n, ROUND(AVG(COALESCE(p.views, 0))) av, ROUND(AVG(COALESCE(p.faves, 0)), 1) af, SUM(COALESCE(p.views, 0)) sv, SUM(COALESCE(p.faves, 0)) sf,
    ROUND(SUM(COALESCE(p.faves, 0)) * 1000.0 / MAX(SUM(COALESCE(p.views, 0)), 1), 1) rate`;
  const sql = {
    year: `SELECT CAST(p.year AS TEXT) k, ${AGG} FROM photos p WHERE ${PH}${accWhere(a)} AND p.year IS NOT NULL GROUP BY p.year ORDER BY p.year DESC`,
    uploaded: `SELECT strftime('%Y', p.date_upload, 'unixepoch') k, ${AGG} FROM photos p WHERE ${PH}${accWhere(a)} AND p.date_upload IS NOT NULL GROUP BY k ORDER BY k DESC`,
    camera: `SELECT COALESCE(p.camera, '(unknown)') k, ${AGG} FROM photos p WHERE ${PH}${accWhere(a)} GROUP BY k HAVING n >= 5 ORDER BY sv DESC LIMIT 40`,
    country: `SELECT COALESCE(p.country, '(no place)') k, ${AGG} FROM photos p WHERE ${PH}${accWhere(a)} GROUP BY k HAVING n >= 3 ORDER BY sv DESC LIMIT 40`,
    city: `SELECT p.city || COALESCE(', ' || p.country, '') k, ${AGG} FROM photos p WHERE ${PH}${accWhere(a)} AND p.city IS NOT NULL GROUP BY k HAVING n >= 3 ORDER BY sv DESC LIMIT 50`,
    tag: `SELECT t.label k, ${AGG} FROM photos p JOIN photo_tags pt ON pt.photo_id = p.id AND pt.source != 'removed' JOIN site_tags t ON t.id = pt.tag_id AND t.kind = 'content'
          WHERE ${PH}${accWhere(a)} GROUP BY t.id HAVING n >= 5 ORDER BY sv DESC LIMIT 50`,
    album: `SELECT al.title k, ${AGG} FROM photos p JOIN album_photos ap ON ap.photo_id = p.id JOIN albums al ON al.id = ap.album_id AND al.source = 'flickr'
          WHERE ${PH}${accWhere(a)} GROUP BY al.id HAVING n >= 3 ORDER BY sv DESC LIMIT 60`,
    shape: `SELECT CASE WHEN MAX(COALESCE(p.o_width, p.width, 1), COALESCE(p.o_height, p.height, 1)) * 1.0 / MAX(1, MIN(COALESCE(p.o_width, p.width, 1), COALESCE(p.o_height, p.height, 1))) >= 2.2 THEN 'Panorama'
             WHEN COALESCE(p.thumb_h, 0) > COALESCE(p.thumb_w, 0) * 1.05 THEN 'Vertical' WHEN COALESCE(p.thumb_w, 0) > COALESCE(p.thumb_h, 0) * 1.05 THEN 'Horizontal' ELSE 'Square' END k,
             ${AGG} FROM photos p WHERE ${PH}${accWhere(a)} GROUP BY k ORDER BY sv DESC`,
  }[by];
  if (!sql) return { by, rows: [] };
  return { by, rows: (await env.DB.prepare(sql).all()).results };
}
