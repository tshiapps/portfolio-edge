// Security headers on every response. Set in code on purpose (not an admin setting): a wrong policy would break
// the site silently. The only inline scripts allowed are the two tiny ones in the HTML pages, by hash
// (test/headers.mjs fails if a page gets a new inline script without its hash here).
export const INLINE_SCRIPT_HASHES = [
  'sha256-opRjTqQ1E5eUpc4SE9v3YoU5wuVpgtqT7zsobCj245Q=', // theme (before first paint, so there's no flash)
  'sha256-uQ4cy424R1530ANKvDdzUjJo7+wFn0jpbEN2KQE4FvI=', // footer year
];

const CSP = [
  "default-src 'self'",
  // Turnstile (inquiry form); Leaflet + marker clustering (catalog map), pinned versions
  `script-src 'self' ${INLINE_SCRIPT_HASHES.map(h => `'${h}'`).join(' ')} https://challenges.cloudflare.com https://unpkg.com/leaflet@1.9.4/ https://unpkg.com/leaflet.markercluster@1.5.3/`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com/leaflet@1.9.4/ https://unpkg.com/leaflet.markercluster@1.5.3/",
  "font-src 'self' https://fonts.gstatic.com",
  // social icons, Flickr thumbnails / buddy icons, Getty previews (admin), map tiles (catalog)
  "img-src 'self' data: blob: https://cdn.jsdelivr.net https://*.staticflickr.com https://*.gettyimages.com https://tile.openstreetmap.org",
  "media-src 'self' blob:",
  "connect-src 'self' https://challenges.cloudflare.com",
  "frame-src https://www.openstreetmap.org https://challenges.cloudflare.com", // lightbox map, Turnstile
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

const COMMON = {
  // no includeSubDomains: other tonyshi.photos subdomains are separate services
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
};

export function secure(res) {
  if (!res || res.status === 101) return res;
  let out = res;
  try { out.headers.set('x-content-type-options', 'nosniff'); } catch { out = new Response(res.body, res); } // immutable (e.g. from ASSETS / cache)
  for (const [k, v] of Object.entries(COMMON)) out.headers.set(k, v);
  const type = out.headers.get('content-type') || '';
  if (type.includes('text/html')) out.headers.set('content-security-policy', CSP);
  return out;
}
