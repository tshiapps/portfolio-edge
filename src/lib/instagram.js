// One Instagram professional account, reached one of two ways (both sealed in settings):
//  'ig' — Instagram Login token (IGAA…) on graph.instagram.com, refreshed weekly (60-day tokens)
//  'fb' — Facebook-side token (EAA…: user, Page or system-user) on graph.facebook.com against the
//         account's IG user id. A user token is swapped for its Page's token, which doesn't expire.
import { seal, unseal } from './crypto.js';
import { setSetting, getSettings, log } from './settings.js';
import { now } from './util.js';

const GRAPH = 'https://graph.instagram.com';
const FBGRAPH = 'https://graph.facebook.com';
export const V = 'v27.0';
const FIELDS = 'id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count,children{id,media_type,media_url,thumbnail_url}';

export class IgError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

export async function ig(path, token, params = {}, host = GRAPH) {
  const u = new URL(path.startsWith('http') ? path : `${host}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (token && !u.searchParams.has('access_token')) u.searchParams.set('access_token', token);
  const res = await fetch(u, { headers: { accept: 'application/json' } });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.error) throw new IgError(d.error?.message || `Instagram HTTP ${res.status}`, d.error?.code);
  return d;
}

export async function igToken(env) {
  const s = await getSettings(env);
  return s.ig_token ? unseal(env, s.ig_token) : null;
}

export const isFb = (s) => s.ig_api === 'fb';
export const hostOf = (s) => (isFb(s) ? FBGRAPH : GRAPH);

// find the Instagram account behind a Facebook-side token; returns { id, username, token }
async function fbAccount(token, wantId) {
  const IGF = 'instagram_business_account{id,username,media_count}';
  // a user / system-user token: the Pages it can see, each with its own (non-expiring) Page token
  let pages = [];
  try { pages = (await ig(`${V}/me/accounts`, token, { fields: `name,access_token,${IGF}`, limit: '100' }, FBGRAPH)).data || []; } catch {}
  const hit = pages.find((p) => p.instagram_business_account && (!wantId || p.instagram_business_account.id === wantId))
    || pages.find((p) => p.instagram_business_account);
  if (hit) return { ...hit.instagram_business_account, token: hit.access_token || token, page: hit.name };
  // a Page token itself
  try {
    const me = await ig(`${V}/me`, token, { fields: `name,${IGF}` }, FBGRAPH);
    if (me.instagram_business_account) return { ...me.instagram_business_account, token, page: me.name };
  } catch {}
  // an id given by hand (e.g. a system-user token assigned the Instagram account directly)
  if (wantId) {
    const u = await ig(`${V}/${wantId}`, token, { fields: 'id,username,media_count' }, FBGRAPH);
    return { ...u, token };
  }
  throw new IgError('Couldn’t find an Instagram account for this token. Make sure @tonyshiphoto is linked to a Facebook Page the token can see (permissions: instagram_basic, pages_show_list, pages_read_engagement), or enter the Instagram account ID.');
}

// paste a token: IGAA… (Instagram login) or EAA… (Facebook login / system user)
export async function saveToken(env, token, igId) {
  token = String(token || '').trim();
  igId = String(igId || '').trim().replace(/\D/g, '') || null;
  if (token.length < 40) throw new IgError('That doesn’t look like an access token');
  let me, api;
  if (/^IG/.test(token)) {
    api = 'ig';
    const r = await ig(`${V}/me`, token, { fields: 'user_id,username,account_type,media_count' });
    me = { id: String(r.user_id || r.id), username: r.username, media_count: r.media_count, token };
  } else {
    api = 'fb';
    me = await fbAccount(token, igId);
  }
  await setSetting(env, 'ig_api', api);
  await setSetting(env, 'ig_token', await seal(env, me.token));
  await setSetting(env, 'ig_token_at', String(now()));
  await setSetting(env, 'ig_user_id', String(me.id));
  await setSetting(env, 'ig_username', me.username || '');
  await setSetting(env, 'ig_error', '');
  await log(env, 'info', `Instagram connected: @${me.username} (${me.media_count ?? '?'} posts) via ${api === 'fb' ? `Facebook${me.page ? ` Page “${me.page}”` : ''}` : 'Instagram login'}`);
  return me;
}

export async function refreshIfDue(env, s) {
  if (!s.ig_token || isFb(s) || now() - (+s.ig_token_at || 0) < 7 * 86400) return false; // Facebook-side tokens don't get refreshed
  const tok = await unseal(env, s.ig_token);
  const r = await ig('refresh_access_token', tok, { grant_type: 'ig_refresh_token' });
  await setSetting(env, 'ig_token', await seal(env, r.access_token));
  await setSetting(env, 'ig_token_at', String(now()));
  return true;
}

// every post (and every carousel slide) → ig_media; posts no longer listed are marked deleted
export async function syncInstagram(env) {
  const s = await getSettings(env);
  const token = await igToken(env);
  if (!token) return null;
  const host = hostOf(s);
  const t = now(), mark = Date.now(); // mark = this sync's stamp on every row it sees
  let url = isFb(s) ? `${V}/${s.ig_user_id}/media` : `${V}/me/media`, params = { fields: FIELDS, limit: '100' }, posts = 0, rows = 0;
  try {
    for (let page = 0; url && page < 100; page++) {
      const d = await ig(url, token, params, host);
      params = {}; // the "next" link carries everything
      const stmts = [];
      for (const m of d.data || []) {
        posts++;
        const base = { post: m.id, type: m.media_product_type || null, permalink: m.permalink || null, caption: m.caption || null,
          ts: m.timestamp ? Math.floor(Date.parse(m.timestamp) / 1000) : null, likes: m.like_count ?? null, comments: m.comments_count ?? null };
        const items = m.media_type === 'CAROUSEL_ALBUM' && m.children?.data?.length
          ? m.children.data.map((c, i) => ({ id: c.id, mt: c.media_type, pos: i, url: c.media_type === 'VIDEO' ? c.thumbnail_url : c.media_url }))
          : [{ id: m.id, mt: m.media_type, pos: 0, url: m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url }];
        for (const it of items) {
          rows++;
          stmts.push(env.DB.prepare(
            `INSERT INTO ig_media (id, post_id, position, media_type, product_type, permalink, caption, ts, like_count, comments_count, seen_at, deleted, media_url)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12)
             ON CONFLICT(id) DO UPDATE SET post_id = excluded.post_id, position = excluded.position, media_type = excluded.media_type,
               product_type = excluded.product_type, permalink = excluded.permalink, caption = excluded.caption, ts = excluded.ts,
               like_count = excluded.like_count, comments_count = excluded.comments_count, seen_at = excluded.seen_at, deleted = 0,
               media_url = excluded.media_url`
          ).bind(it.id, base.post, it.pos, it.mt, base.type, base.permalink, base.caption, base.ts, base.likes, base.comments, mark, it.url || null));
        }
      }
      for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
      url = d.paging?.next || null;
    }
    await env.DB.prepare('UPDATE ig_media SET deleted = 1 WHERE seen_at < ?1 AND deleted = 0').bind(mark).run();
    await setSetting(env, 'ig_last_sync', String(t));
    await setSetting(env, 'ig_error', '');
    return { posts, rows };
  } catch (e) {
    await setSetting(env, 'ig_error', String(e.message).slice(0, 300));
    throw e;
  }
}

// a fresh image for one media item (Instagram's CDN links expire, so they're never stored)
export async function igImage(env, id) {
  const s = await getSettings(env);
  const token = await igToken(env);
  if (!token) throw new IgError('Instagram not connected');
  const m = await ig(`${V}/${id}`, token, { fields: 'media_type,media_url,thumbnail_url' }, hostOf(s));
  const src = m.media_type === 'VIDEO' ? m.thumbnail_url || m.media_url : m.media_url;
  if (!src) throw new IgError('No image for this item');
  const res = await fetch(src);
  if (!res.ok) throw new IgError(`Instagram image HTTP ${res.status}`);
  return res;
}

// cron: refresh the token weekly, sync posts every 6 hours
export async function igTick(env, s) {
  if (!s.ig_token) return null;
  try { await refreshIfDue(env, s); } catch (e) { await setSetting(env, 'ig_error', `Token refresh failed: ${e.message}`.slice(0, 300)); }
  if (now() - (+s.ig_last_sync || 0) < 6 * 3600) return null;
  try { return await syncInstagram(env); } catch (e) { console.error('instagram sync', e.message); return { error: e.message }; }
}

// the account's follower count (for the Instagram stats page)
export async function igProfile(env) {
  const s = await getSettings(env);
  const token = await igToken(env);
  if (!token || !s.ig_user_id) return null;
  const path = isFb(s) ? `${V}/${s.ig_user_id}` : `${V}/me`;
  return ig(path, token, { fields: 'followers_count,follows_count,media_count,username' }, hostOf(s));
}
