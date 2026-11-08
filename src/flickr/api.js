// Rate-limited Flickr REST client. Every call reserves one unit from a per-hour budget kept in D1,
// so overlapping work (cron ticks, manual runs) can never push past Flickr's 3600/hour/key limit.
import { signUrl } from './oauth.js';
import { unseal } from '../lib/crypto.js';
import { now } from '../lib/util.js';

const REST = 'https://api.flickr.com/services/rest/';

export const PHOTO_EXTRAS = [
  'description', 'license', 'date_upload', 'date_taken', 'owner_name', 'original_format', 'last_update',
  'geo', 'tags', 'machine_tags', 'o_dims', 'views', 'media', 'path_alias', 'url_q',
  'count_faves', 'count_comments', // not in Flickr's docs; if ignored, a slower per-photo refresh kicks in
].join(',');

export class RateLimited extends Error {}
export class FlickrError extends Error {
  constructor(code, message) { super(`Flickr ${code}: ${message}`); this.code = code; }
}

export async function loadApp(env) {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('flickr_api_key','flickr_api_secret')"
  ).all();
  const m = Object.fromEntries(results.map(r => [r.key, r.value]));
  if (!m.flickr_api_key || !m.flickr_api_secret) return null;
  return { key: m.flickr_api_key, secret: await unseal(env, m.flickr_api_secret) };
}

export async function apiUsage(env) {
  const bucket = Math.floor(now() / 3600);
  const row = await env.DB.prepare('SELECT calls FROM api_usage WHERE bucket = ?1').bind(bucket).first();
  return row?.calls || 0;
}

async function reserve(env, budget) {
  const bucket = Math.floor(now() / 3600);
  const row = await env.DB.prepare(
    `INSERT INTO api_usage (bucket, calls) VALUES (?1, 1)
     ON CONFLICT(bucket) DO UPDATE SET calls = calls + 1 RETURNING calls`
  ).bind(bucket).first();
  if (row.calls > budget) throw new RateLimited(`Hourly Flickr API budget (${budget}) used up`);
}

export class Flickr {
  constructor(env, app, budget, account = null) {
    this.env = env; this.app = app; this.budget = budget; this.account = account;
  }

  static async forAccount(env, app, budget, accountRow) {
    // an account authorized with a different key than the current Settings key keeps using its own
    if (accountRow.app_key && accountRow.app_secret_enc) app = { key: accountRow.app_key, secret: await unseal(env, accountRow.app_secret_enc) };
    return new Flickr(env, app, budget, {
      token: await unseal(env, accountRow.token_enc),
      tokenSecret: await unseal(env, accountRow.token_secret_enc),
    });
  }

  async call(method, params = {}) {
    await reserve(this.env, this.budget);
    const p = { method, format: 'json', nojsoncallback: '1' };
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) p[k] = String(v);
    const url = await signUrl({
      url: REST, params: p,
      consumerKey: this.app.key, consumerSecret: this.app.secret,
      token: this.account?.token, tokenSecret: this.account?.tokenSecret || '',
    });
    const res = await fetch(url, { headers: { 'user-agent': 'tonyshi.photos-sync/1.0' } });
    if (res.status === 429) throw new RateLimited('Flickr returned 429');
    if (!res.ok) throw new FlickrError(res.status, `HTTP ${res.status}`);
    const j = await res.json();
    if (j.stat !== 'ok') throw new FlickrError(j.code, j.message);
    return j;
  }
}
