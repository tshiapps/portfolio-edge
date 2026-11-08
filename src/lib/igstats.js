// Instagram stats: daily followers + per-post likes/comments history (collected by the cron), and the queries for
// the admin page — what's popular, when to post, which kind of post works, hashtags, and what to post next.
import { igProfile } from './instagram.js';

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const addDays = (d, n) => day(Date.parse(d + 'T00:00:00Z') + n * 86400e3);
// one row per post (carousel slides share the post's numbers; the first slide stands for the post)
const POSTS = `SELECT m.post_id id, MIN(m.ts) ts, MAX(m.like_count) likes, MAX(m.comments_count) comments, MAX(m.caption) caption, MAX(m.permalink) permalink,
    MAX(m.product_type) product, COUNT(*) slides, MAX(m.media_type = 'VIDEO') video,
    (SELECT l.photo_id FROM ig_media x CROSS JOIN ig_links l ON l.ig_id = x.id AND l.status IN ('confirmed', 'auto') WHERE x.post_id = m.post_id ORDER BY x.position, l.status = 'confirmed' DESC LIMIT 1) photo_id,
    (SELECT x.id FROM ig_media x WHERE x.post_id = m.post_id ORDER BY x.position LIMIT 1) first_id
  FROM ig_media m WHERE m.deleted = 0 GROUP BY m.post_id`;

// cron, once a day (with the Flickr snapshot)
export async function igSnapshot(env, d = day()) {
  const s = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'ig_token'").first())?.value;
  if (!s) return null;
  let prof = null;
  try { prof = await igProfile(env); } catch {}
  if (prof) await env.DB.prepare('INSERT OR REPLACE INTO ig_daily (day, followers, follows, posts) VALUES (?1, ?2, ?3, ?4)')
    .bind(d, prof.followers_count ?? null, prof.follows_count ?? null, prof.media_count ?? null).run();
  const r = await env.DB.prepare(
    `INSERT OR REPLACE INTO ig_hist (post_id, day, likes, comments)
     SELECT p.id, ?1, p.likes, p.comments FROM (${POSTS}) p
     LEFT JOIN ig_hist h ON h.post_id = p.id AND h.day = (SELECT MAX(day) FROM ig_hist x WHERE x.post_id = p.id AND x.day < ?1)
     WHERE h.post_id IS NULL OR h.likes != p.likes OR h.comments != p.comments`
  ).bind(d).run();
  return { followers: prof?.followers_count ?? null, posts: r.meta.changes || 0 };
}

const engagement = p => (p.likes || 0) + (p.comments || 0);
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export async function igStats(env, q) {
  const period = Math.min(365, Math.max(7, +q.get('period') || 30));
  const today = day(), from = addDays(today, -period), tz = q.get('tz') || 'UTC';
  const [posts, fol, tsp] = await Promise.all([
    env.DB.prepare(`${POSTS} ORDER BY ts DESC`).all().then(r => r.results),
    env.DB.prepare('SELECT day, followers, posts FROM ig_daily WHERE day >= ?1 ORDER BY day').bind(addDays(today, -period * 2)).all().then(r => r.results),
    env.DB.prepare("SELECT COUNT(*) n FROM photos WHERE status = 'ok' AND is_public = 1").first(),
  ]);
  if (!posts.length) return { empty: true };
  const followers = fol.at(-1)?.followers ?? null;
  const folStart = fol.find(f => f.day >= from)?.followers ?? null, folPrev = fol[0]?.followers ?? null;
  const recent = posts.slice(0, 30), older = posts.slice(30, 60);
  const avg = (list, f) => list.length ? list.reduce((t, p) => t + f(p), 0) / list.length : 0;
  const sinceT = Math.floor(Date.parse(from) / 1000);

  // when to post: average engagement by weekday × 3-hour block (in the viewer's time zone), from the last 2 years
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false });
  const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const cells = {};
  const twoYears = Date.now() / 1000 - 730 * 86400;
  // compare each post to its era: likes relative to the median of the 20 posts around it (an account's reach changes over the years)
  const rel = posts.map((p, i) => { const win = posts.slice(Math.max(0, i - 10), i + 10).map(engagement); return engagement(p) / Math.max(1, median(win)); });
  posts.forEach((p, i) => {
    if (!p.ts || p.ts < twoYears) return;
    let parts; try { parts = Object.fromEntries(fmt.formatToParts(new Date(p.ts * 1000)).map(x => [x.type, x.value])); } catch { return; }
    const key = `${WD.indexOf(parts.weekday)}:${Math.floor((+parts.hour % 24) / 3)}`;
    (cells[key] ||= []).push(rel[i]);
  });
  const heat = Object.entries(cells).map(([k, v]) => { const [d, h] = k.split(':').map(Number); return { d, h, n: v.length, score: v.reduce((a, b) => a + b, 0) / v.length }; });

  // kind of post
  const kindOf = p => p.product === 'REELS' || (p.video && p.slides === 1) ? 'Reel / video' : p.slides > 1 ? 'Carousel' : 'Single photo';
  const kinds = {};
  posts.forEach((p, i) => { const k = kindOf(p); (kinds[k] ||= { k, n: 0, likes: 0, comments: 0, rel: 0 }); kinds[k].n++; kinds[k].likes += p.likes || 0; kinds[k].comments += p.comments || 0; kinds[k].rel += rel[i]; });

  // hashtags in captions
  const tags = {};
  posts.forEach((p, i) => {
    for (const t of new Set((p.caption || '').toLowerCase().match(/#[\p{L}\p{N}_]+/gu) || [])) { (tags[t] ||= { k: t, n: 0, rel: 0, likes: 0 }); tags[t].n++; tags[t].rel += rel[i]; tags[t].likes += p.likes || 0; }
  });

  // rising posts (likes gained in the period, from our daily history)
  const rising = (await env.DB.prepare(
    `WITH base AS (SELECT h.post_id, h.likes FROM ig_hist h WHERE h.day = COALESCE(
        (SELECT MAX(day) FROM ig_hist x WHERE x.post_id = h.post_id AND x.day <= ?1), (SELECT MIN(day) FROM ig_hist x WHERE x.post_id = h.post_id)))
     SELECT b.post_id id, b.likes base FROM base b`
  ).bind(from).all()).results;
  const baseBy = new Map(rising.map(r => [r.id, r.base]));
  const gains = posts.map(p => ({ ...p, gain: (p.likes || 0) - (baseBy.has(p.id) ? baseBy.get(p.id) : (p.ts >= sinceT ? 0 : p.likes || 0)) }))
    .filter(p => p.gain > 0).sort((a, b) => b.gain - a.gain).slice(0, 24);

  // what to post next: your most-loved site photos (Flickr fave rate + faves) that have never been on Instagram
  const next = (await env.DB.prepare(
    `SELECT p.id, p.title, p.synced_at v, p.views, p.faves, p.thumb_w w, p.thumb_h h,
       (SELECT COUNT(*) FROM getty_assets g JOIN getty_sales s ON s.asset_id = g.asset_id WHERE COALESCE(NULLIF(g.linked_photo_id, ''), g.photo_id) = p.id) getty
     FROM photos p WHERE p.status = 'ok' AND p.is_public = 1 AND p.hidden = 0 AND COALESCE(p.rating, 0) != 1 AND COALESCE(p.views, 0) >= 200
       AND NOT EXISTS (SELECT 1 FROM ig_links l WHERE l.photo_id = p.id AND l.status IN ('confirmed', 'auto'))
       AND NOT EXISTS (SELECT 1 FROM ig_posts x WHERE x.photo_id = p.id AND x.status IN ('queued', 'container', 'published', 'crop'))
     ORDER BY (COALESCE(p.faves, 0) * 1000.0 / MAX(COALESCE(p.views, 0), 1)) * 0.6 + COALESCE(p.pop_score, 0) * 4 DESC LIMIT 24`
  ).all().catch(() => ({ results: [] }))).results;

  // by subject (site tags of the linked photos)
  const subj = (await env.DB.prepare(
    `WITH posts AS (${POSTS}) SELECT t.label k, COUNT(DISTINCT po.id) n, ROUND(AVG(po.likes)) likes
     FROM posts po JOIN photo_tags pt ON pt.photo_id = po.photo_id AND pt.source != 'removed' JOIN site_tags t ON t.id = pt.tag_id AND t.kind = 'content'
     GROUP BY t.id HAVING n >= 3 ORDER BY likes DESC LIMIT 30`
  ).all().catch(() => ({ results: [] }))).results;

  const inPeriod = posts.filter(p => p.ts >= sinceT);
  return {
    period, followers, followersGain: followers != null && folStart != null ? followers - folStart : null, followersPrev: folStart != null && folPrev != null ? folStart - folPrev : null,
    followerSeries: fol.filter(f => f.day >= from), since: fol[0]?.day || null,
    totals: { posts: posts.length, likes: posts.reduce((t, p) => t + (p.likes || 0), 0), comments: posts.reduce((t, p) => t + (p.comments || 0), 0),
      linked: posts.filter(p => p.photo_id).length, sitePhotos: tsp.n },
    recent: { n: recent.length, likes: avg(recent, p => p.likes || 0), comments: avg(recent, p => p.comments || 0), median: median(recent.map(p => p.likes || 0)),
      prevLikes: avg(older, p => p.likes || 0), rate: followers ? avg(recent, engagement) / followers * 100 : null },
    inPeriod: { posts: inPeriod.length, likes: inPeriod.reduce((t, p) => t + (p.likes || 0), 0) },
    timeline: posts.slice(0, 80).reverse().map(p => ({ id: p.id, ts: p.ts, likes: p.likes || 0, comments: p.comments || 0 })),
    top: posts.map((p, i) => ({ ...p, rel: Math.round(rel[i] * 100) / 100, caption: (p.caption || '').slice(0, 160) })),
    heat, tz, kinds: Object.values(kinds).map(k => ({ ...k, avgLikes: Math.round(k.likes / k.n), avgComments: Math.round(k.comments / k.n * 10) / 10, rel: Math.round(k.rel / k.n * 100) / 100 })),
    hashtags: Object.values(tags).filter(t => t.n >= 3).map(t => ({ ...t, rel: Math.round(t.rel / t.n * 100) / 100, avgLikes: Math.round(t.likes / t.n) })).sort((a, b) => b.rel - a.rel).slice(0, 40),
    rising: gains.map(({ caption, ...p }) => p), next, subjects: subj,
  };
}
