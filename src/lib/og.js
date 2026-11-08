// Link previews: when a page link is pasted into iMessage, WhatsApp, X, Facebook, Slack… those apps read Open Graph tags.
// Pages are static files, so the Worker adds the tags on the way out:
//   ?p=<photo id>          → that photo's title and the photo itself
//   /catalog/<…>/<album>   → the album / collection name and its cover
//   anything else          → the page title and the site's name
import { PUBLIC, catalogTree } from './catalog.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SITE = 'Tony Shi Photography';

async function treeCached(env, ctx, origin) {
  const ver = (await env.DB.prepare("SELECT value FROM settings WHERE key IN ('catalog_ver', 'content_ver') UNION ALL SELECT MAX(updated_at) FROM albums").all()).results.map(r => r.value).join('-');
  const key = new Request(`${origin}/__og/${ver}-${Math.floor(Date.now() / 1800e3)}/tree`);
  const hit = await caches.default.match(key);
  if (hit) return hit.json();
  const t = await catalogTree(env);
  ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify(t), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=1800' } })));
  return t;
}

export async function previewFor(env, ctx, url) {
  const p = url.searchParams.get('p');
  if (/^\d{1,20}$/.test(p || '')) {
    const r = await env.DB.prepare(`SELECT p.id, p.title, p.description, p.thumb_w w, p.thumb_h h FROM photos p WHERE p.id = ?1 AND ${PUBLIC}`).bind(p).first();
    if (r) return { title: r.title ? `${r.title} — Tony Shi` : 'A photograph by Tony Shi',
      description: (r.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'A photograph by Tony Shi.',
      image: `${url.origin}/img/${r.id}/m`, w: r.w, h: r.h, large: true };
  }
  const m = decodeURIComponent(url.pathname).match(/^\/catalog\/(.+?)\/?$/);
  if (m && !/^(search|map|roll)$/.test(m[1])) {
    const d = await treeCached(env, ctx, url.origin);
    let node = { kids: d.tree, albums: [] }, hit = null;
    for (const part of m[1].split('/')) {
      const k = node.kids.find(x => x.path.split('/').pop() === part);
      if (k) { node = hit = k; continue; }
      const a = node.albums.find(x => x.path.split('/').pop() === part);
      hit = a ? { ...a, album: true } : null; break;
    }
    if (hit) {
      const cover = hit.album ? hit.cover : hit.covers?.[0]?.[0];
      return { title: `${hit.title} — Tony Shi`, description: `${hit.album ? 'An album' : 'A collection'} of ${hit.n.toLocaleString("en-US")} photograph${hit.n === 1 ? "" : "s"} by Tony Shi.`,
        image: cover ? `${url.origin}/img/${cover}/m` : null, large: !!cover };
    }
  }
  return null;
}

// adds the tags to an HTML page response (no-op where the runtime has no HTMLRewriter, e.g. tests)
export async function withPreview(env, ctx, url, res) {
  if (typeof HTMLRewriter === 'undefined' || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  let pv = null;
  try { pv = await previewFor(env, ctx, url); } catch {}
  const tags = (title, description) => [
    ['og:site_name', SITE], ['og:type', pv?.image ? 'article' : 'website'], ['og:url', url.origin + url.pathname + (url.searchParams.get('p') ? `?p=${url.searchParams.get('p')}` : '')],
    ['og:title', pv?.title || title], ['og:description', pv?.description || description],
    ...(pv?.image ? [['og:image', pv.image], ['twitter:image', pv.image]] : []),
    ['twitter:card', pv?.large ? 'summary_large_image' : 'summary'],
  ].map(([k, v]) => `<meta ${k.startsWith('twitter:') ? 'name' : 'property'}="${k}" content="${esc(v)}">`).join('');
  let title = SITE, description = '';
  return new HTMLRewriter()
    .on('title', { text(t) { if (t.text.trim()) title = t.text.trim(); } })
    .on('meta[name="description"]', { element(e) { description = e.getAttribute('content') || ''; } })
    .on('head', { element(e) { e.onEndTag(end => { end.before(tags(title, description), { html: true }); }); } })
    .on('title', { element(e) { if (pv?.title) e.setInnerContent(`${pv.title}`); } })
    .transform(res);
}
