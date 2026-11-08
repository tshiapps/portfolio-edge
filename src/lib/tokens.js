// API tokens for non-browser clients (the Mac uploader). Stored only as SHA-256 hashes.
// Scope 'media' can reach /api/admin/media/* and nothing else.
import { te, randomHex, now } from './util.js';

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', te.encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function createToken(env, name, scope = 'media') {
  const token = `tsp_${randomHex(24)}`;
  await env.DB.prepare('INSERT INTO api_tokens (name, hash, prefix, scope) VALUES (?1, ?2, ?3, ?4)')
    .bind(name, await sha256Hex(token), token.slice(0, 10), scope).run();
  return token;
}

// 'media' tokens are used by the Mac helpers: the Aerial Uploader and the photo fetcher.
const SCOPES = {
  media: path => path === '/api/admin/media' || path.startsWith('/api/admin/media/') || path.startsWith('/api/admin/fetch/'),
};

// Returns null if the bearer token is valid for this path, else a Response.
export async function checkBearer(request, env, path) {
  const h = request.headers.get('authorization') || '';
  const token = h.slice(7).trim();
  if (!/^tsp_[0-9a-f]{48}$/.test(token)) return new Response('Invalid token', { status: 401 });
  const row = await env.DB.prepare('SELECT id, scope FROM api_tokens WHERE hash = ?1 AND revoked_at IS NULL')
    .bind(await sha256Hex(token)).first();
  if (!row) return new Response('Invalid or revoked token', { status: 401 });
  if (!SCOPES[row.scope]?.(path)) return new Response('Token not allowed here', { status: 403 });
  await env.DB.prepare('UPDATE api_tokens SET last_used_at = ?2 WHERE id = ?1').bind(row.id, now()).run();
  return null;
}
