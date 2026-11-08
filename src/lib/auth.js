// Admin authentication: Cloudflare Access JWT when configured, otherwise HTTP Basic with ADMIN_PASSWORD.
import { te, b64urlDecode, td } from './util.js';

let certCache = { at: 0, keys: [] };

async function accessKeys(team) {
  if (Date.now() - certCache.at < 3600_000 && certCache.keys.length) return certCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const { keys } = await res.json();
  certCache = { at: Date.now(), keys };
  return keys;
}

async function verifyAccessJwt(token, env) {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return false;
  const header = JSON.parse(td.decode(b64urlDecode(h)));
  const payload = JSON.parse(td.decode(b64urlDecode(p)));
  const jwk = (await accessKeys(env.ACCESS_TEAM_DOMAIN)).find(k => k.kid === header.kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(s), te.encode(`${h}.${p}`));
  if (!ok) return false;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return false;
  if (payload.exp && payload.exp < Date.now() / 1000) return false;
  return true;
}

function timingSafeEqual(a, b) {
  const x = te.encode(a), y = te.encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// Returns null when authorized, otherwise a Response to send back.
export async function requireAdmin(request, env) {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const token = request.headers.get('cf-access-jwt-assertion');
    if (token && await verifyAccessJwt(token, env).catch(() => false)) return null;
    return new Response('Forbidden — Cloudflare Access required', { status: 403 });
  }
  if (!env.ADMIN_PASSWORD) {
    return new Response('Admin is locked: set ADMIN_PASSWORD (or configure Cloudflare Access).', { status: 503 });
  }
  const h = request.headers.get('authorization') || '';
  if (h.startsWith('Basic ')) {
    const [user, ...rest] = atob(h.slice(6)).split(':');
    if (user === 'admin' && timingSafeEqual(rest.join(':'), env.ADMIN_PASSWORD)) return null;
  }
  return new Response('Authentication required', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="tonyshi.photos admin", charset="UTF-8"' },
  });
}
