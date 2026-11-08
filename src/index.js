// tonyshi.photos — public portfolio, admin portal and Flickr sync in one Worker.
import { withPreview } from './lib/og.js';
import { requireAdmin } from './lib/auth.js';
import { checkBearer } from './lib/tokens.js';
import { err, HttpError } from './lib/util.js';
import { adminApi, adminPages } from './routes/admin.js';
import { publicApi } from './routes/public.js';
import { runTick } from './sync/engine.js';
import { getSettings } from './lib/settings.js';
import { serveSource } from './lib/igpublish.js';
import { secure } from './lib/headers.js';

export default {
  async fetch(request, env, ctx) {
    return secure(await handle(request, env, ctx));
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTick(env).then(s => console.log('sync tick', JSON.stringify(s))));
  },
};

async function handle(request, env, ctx) {
  {
    const url = new URL(request.url);
    const path = url.pathname;
    const isAdmin = path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/admin');
    try {
      if (isAdmin) {
        const bearer = (request.headers.get('authorization') || '').startsWith('Bearer ');
        const deny = bearer && path.startsWith('/api/admin') ? await checkBearer(request, env, path) : await requireAdmin(request, env);
        if (deny) return deny;
        if (path.startsWith('/api/admin')) return await adminApi(request, env, ctx, url);
        const page = await adminPages(request, env, url);
        if (page) return page;
        const res = await env.ASSETS.fetch(request);
        const out = new Response(res.body, res);
        out.headers.set('cache-control', 'no-store');
        out.headers.set('x-robots-tag', 'noindex');
        return out;
      }
      // the temporary JPEG Instagram downloads while a post is being published
      const igsrc = path.match(/^\/ig-src\/([0-9a-f]{32})\.jpg$/);
      if (igsrc) return (await serveSource(env, igsrc[1])) || err('Not found', 404);
      if (path.startsWith('/api/') || path.startsWith('/img/') || path.startsWith('/media/')) return await publicApi(request, env, ctx, url);
      if ((path === '/' || path === '/index.html') && (request.method === 'GET' || request.method === 'HEAD')) {
        const home = (await getSettings(env)).home_page === 'aerial' ? '/aerial' : '/photos';
        const res = await env.ASSETS.fetch(new Request(url.origin + home, request));
        const out = new Response(res.body, res);
        out.headers.set('cache-control', 'no-cache');
        return withPreview(env, ctx, url, out);
      }
      if ((path === '/catalog' || path.startsWith('/catalog/')) && (request.method === 'GET' || request.method === 'HEAD')) {
        return withPreview(env, ctx, url, await env.ASSETS.fetch(new Request(url.origin + '/catalog', request))); // catalog pages: the browser reads the path
      }
      if (path.startsWith('/photos/') && (request.method === 'GET' || request.method === 'HEAD')) {
        return withPreview(env, ctx, url, await env.ASSETS.fetch(new Request(url.origin + '/photos', request))); // folder pages: the grid reads the path
      }
      if (path === '/about' || path === '/about.html') return Response.redirect(url.origin + '/', 302); // bio retired for now
      return withPreview(env, ctx, url, await env.ASSETS.fetch(request));
    } catch (e) {
      if (e instanceof HttpError) return err(e.message, e.status);
      console.error(e);
      return err(isAdmin ? `Internal error: ${e.message}` : 'Something went wrong', 500);
    }
  }
}
