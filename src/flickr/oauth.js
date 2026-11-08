// Flickr OAuth 1.0a (HMAC-SHA1) — request token, authorize, access token, and request signing.
import { te, b64, randomHex, now } from '../lib/util.js';

const OAUTH = 'https://www.flickr.com/services/oauth';

// RFC 3986 percent-encoding as OAuth requires.
export function pct(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function hmacSha1(key, data) {
  const k = await crypto.subtle.importKey('raw', te.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', k, te.encode(data)));
}

// Signs params (mutates nothing) and returns the full URL with an RFC 3986 encoded query string.
export async function signUrl({ method = 'GET', url, params, consumerKey, consumerSecret, token, tokenSecret = '' }) {
  const p = {
    ...params,
    oauth_consumer_key: consumerKey,
    oauth_nonce: randomHex(16),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(now()),
    oauth_version: '1.0',
  };
  if (token) p.oauth_token = token;
  const pairs = Object.entries(p).map(([k, v]) => [pct(k), pct(v)]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const norm = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const base = `${method.toUpperCase()}&${pct(url)}&${pct(norm)}`;
  const sig = await hmacSha1(`${pct(consumerSecret)}&${pct(tokenSecret)}`, base);
  return `${url}?${norm}&oauth_signature=${pct(sig)}`;
}

async function formCall(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`Flickr OAuth ${res.status}: ${text.slice(0, 300)}`);
  return Object.fromEntries(new URLSearchParams(text));
}

export async function getRequestToken(app, callbackUrl) {
  const url = await signUrl({
    url: `${OAUTH}/request_token`,
    params: { oauth_callback: callbackUrl },
    consumerKey: app.key, consumerSecret: app.secret,
  });
  const r = await formCall(url);
  if (r.oauth_callback_confirmed !== 'true') throw new Error('Flickr did not confirm the callback');
  return { token: r.oauth_token, secret: r.oauth_token_secret };
}

export function authorizeUrl(token) {
  return `${OAUTH}/authorize?oauth_token=${pct(token)}&perms=read`;
}

export async function getAccessToken(app, token, tokenSecret, verifier) {
  const url = await signUrl({
    url: `${OAUTH}/access_token`,
    params: { oauth_verifier: verifier },
    consumerKey: app.key, consumerSecret: app.secret, token, tokenSecret,
  });
  const r = await formCall(url);
  return {
    token: r.oauth_token, secret: r.oauth_token_secret,
    nsid: r.user_nsid, username: r.username, fullname: r.fullname,
  };
}
