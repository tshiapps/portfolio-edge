// Test harness: real Worker code over HTTP with SQLite as D1 and an in-memory R2.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';

export async function startSite() {
  const db = new DatabaseSync(':memory:');
  const migDir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(migDir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, migDir), 'utf8'));
  const norm = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...a) { return new Stmt(this.sql, a); }
    async run() { const r = db.prepare(this.sql).run(...norm(this.args)); return { meta: { changes: Number(r.changes) } }; }
    async all() { return { results: db.prepare(this.sql).all(...norm(this.args)).map(r => ({ ...r })) }; }
    async first() { const r = db.prepare(this.sql).get(...norm(this.args)); return r ? { ...r } : null; }
  }
  const DB = { prepare: sql => new Stmt(sql), async batch(st) { for (const s of st) await s.run(); } };
  const r2 = new Map();
  const BUCKET = {
    async put(k, body, o) { r2.set(k, { buf: Buffer.from(await new Response(body).arrayBuffer()), o }); },
    async get(k, opts) {
      const x = r2.get(k); if (!x) return null;
      let body = x.buf, range;
      if (opts?.range && typeof opts.range.offset === 'number') {
      const { offset, length } = opts.range;
      return { body: new Uint8Array(x.buf.subarray(offset, offset + length)), size: x.buf.length, httpMetadata: x.o.httpMetadata, httpEtag: '"e"' };
    }
    const h = opts?.range?.get?.('range');
      const m = h && /bytes=(\d*)-(\d*)/.exec(h);
      if (m) {
        if (m[1] === '') { range = { suffix: +m[2] }; body = x.buf.subarray(x.buf.length - +m[2]); }
        else { const s = +m[1], e = m[2] === '' ? x.buf.length - 1 : +m[2]; range = { offset: s, length: e - s + 1 }; body = x.buf.subarray(s, e + 1); }
      }
      return { body: new Uint8Array(body), size: x.buf.length, range, httpMetadata: x.o.httpMetadata, httpEtag: '"e"' };
    },
    async head(k) { const x = r2.get(k); return x ? { size: x.buf.length, httpMetadata: x.o.httpMetadata, httpEtag: '"e"' } : null; },
  async delete(keys) { [].concat(keys).forEach(k => r2.delete(k)); },
  };
  const env = { DB, BUCKET, ADMIN_PASSWORD: 'pw', ENCRYPTION_KEY: 'k', ASSETS: { fetch: async () => new Response('asset') } };
  const ctx = { waitUntil() {} };
  const { default: worker } = await import('../src/index.js');

  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    const r = await worker.fetch(new Request('http://127.0.0.1' + req.url, { method: req.method, headers: req.headers, body: buf.length ? buf : undefined }), env, ctx);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const basic = { authorization: 'Basic ' + btoa('admin:pw') };
  const { token } = await (await fetch(base + '/api/admin/tokens', { method: 'POST', headers: { ...basic, 'content-type': 'application/json' }, body: '{"name":"test"}' })).json();
  return { db, r2, base, server, basic, token };
}
