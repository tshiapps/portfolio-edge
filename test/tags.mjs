// Tag scheme: geotag → location tags, Flickr words → content tags (+parents), manual edits respected,
// export/import for Claude's pass, organizer filters.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const db = new DatabaseSync(':memory:');
for (const f of readdirSync(root + '/migrations').sort()) db.exec(readFileSync(root + '/migrations/' + f, 'utf8'));
const norm = a => a.map(v => (v === undefined ? null : v));
class S { constructor(q, a = []) { this.q = q; this.a = a; } bind(...a) { return new S(this.q, a); }
  async run() { const r = /returning/i.test(this.q) ? { changes: db.prepare(this.q).all(...norm(this.a)).length } : db.prepare(this.q).run(...norm(this.a)); return { meta: { changes: Number(r.changes) } }; }
  async all() { return { results: db.prepare(this.q).all(...norm(this.a)).map(r => ({ ...r })) }; }
  async first() { const r = db.prepare(this.q).get(...norm(this.a)); return r ? { ...r } : null; } }
const env = { DB: { prepare: q => new S(q), async batch(st) { for (const x of st) await x.run(); } }, ADMIN_PASSWORD: 'pw', ENCRYPTION_KEY: 'k', ASSETS: { fetch: async () => new Response('x') } };
const { default: w } = await import(root + '/src/index.js');
const call = async (p, body, method) => { const r = await w.fetch(new Request('https://x/api/admin' + p, { method: method || (body ? 'POST' : 'GET'), headers: { authorization: 'Basic ' + btoa('admin:pw'), 'content-type': 'application/json' }, body: body && JSON.stringify(body) }), env, {}); return r.headers.get('content-type')?.includes('json') ? { status: r.status, ...(await r.json()) } : { status: r.status }; };
const ok = (c, m) => { console.log((c ? 'ok  - ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; };
const tagsOf = id => db.prepare("SELECT t.slug, pt.source FROM photo_tags pt JOIN site_tags t ON t.id = pt.tag_id WHERE pt.photo_id = ? AND pt.source != 'removed' ORDER BY t.slug").all(id).map(r => r.slug);

db.prepare("INSERT INTO accounts (nsid, token_enc, token_secret_enc) VALUES ('1@N1','x','y')").run();
const add = (id, title, tags, loc) => db.prepare("INSERT INTO photos (id, account_id, title, tags, raw_tags, location, latitude, status) VALUES (?, 1, ?, ?, ?, ?, ?, 'ok')")
  .run(id, title, tags.map(t => t.toLowerCase().replace(/[^a-z0-9]/g, '')).join(' '), JSON.stringify(tags), loc ? JSON.stringify(loc) : null, loc ? 40.7 : null);
add('1', 'Midtown at dusk', ['New York', 'urban', 'cityscape'], { locality: 'New York', region: 'New York', country: 'United States' });
add('2', 'Glacier', ['Alaska', 'mountains'], { locality: 'Anchorage', region: 'Alaska', country: 'United States' });
add('3', 'Reef', ['scuba', 'Coral'], null);
add('4', 'New upload', ['tag-concert'], null);
add('5', 'Mystery', ['DSC_1234'], null);

const ap = await call('/tags/apply', { offset: 0 });
ok(ap.done === 5 && ap.next === 5, 're-apply rules over all photos');
ok(JSON.stringify(tagsOf('1')) === JSON.stringify(['city', 'landscape', 'newyorkcity', 'newyorkstate', 'usa']), `NYC: ${tagsOf('1')}`);
const ny = db.prepare("SELECT slug, label FROM site_tags WHERE kind='location' ORDER BY id").all();
ok(ny.some(t => t.slug === 'newyorkstate' && t.label === 'New York State') && ny.some(t => t.slug === 'newyorkcity' && t.label === 'New York City'), 'geotag creates country › state › city tags (New York State vs New York City)');
ok(JSON.stringify(tagsOf('2')) === JSON.stringify(['alaska', 'anchorage', 'landscape', 'nature', 'usa']), `Alaska: ${tagsOf('2')}`);
ok(JSON.stringify(tagsOf('3')) === JSON.stringify(['underwater']), `scuba → underwater: ${tagsOf('3')}`);
ok(JSON.stringify(tagsOf('4')) === JSON.stringify(['concert', 'events']), `"tag-concert" on Flickr → Concert (+Events): ${tagsOf('4')}`);
ok(tagsOf('5').length === 0, 'nothing to go on → no tags (left for Claude / you)');

// manual edits: removing a rule tag sticks after re-apply; manual add stays
await call('/photos/bulk', { ids: ['1'], removeTags: ['city'] });
await call('/photos/bulk', { ids: ['1'], addTags: ['nature'] });
await call('/tags/apply', { offset: 0 });
ok(!tagsOf('1').includes('city') && tagsOf('1').includes('nature'), 'your removals and additions survive re-applying the rules');

// alias edit via the Tags page → re-apply picks it up
const nat = db.prepare("SELECT id FROM site_tags WHERE slug='events'").get();
const t = await call('/tags', { label: 'Mystery Shots', kind: 'content', aliases: ['DSC_1234'], parent_id: nat.id });
await call('/tags/apply', { offset: 0 });
ok(t.ok && tagsOf('5').includes('mysteryshots') && tagsOf('5').includes('events'), 'new tag with Flickr words applies on re-apply');
ok((await call('/tags', { label: 'mystery shots', kind: 'content' })).status === 409, 'duplicate slug refused');
ok((await call('/tags/' + nat.id, { parent_id: t.tag.id }, 'PATCH')).status === 400, 'cycle refused (a tag inside its own child)');

// export / import (Claude's pass)
const exp = await w.fetch(new Request('https://x/api/admin/tags/export', { headers: { authorization: 'Basic ' + btoa('admin:pw') } }), env, {});
const ex = await exp.json();
ok(ex.photos.length === 5 && ex.vocabulary.find(v => v.word === 'urban').mapped === 'city' && ex.scheme.some(s => s.slug === 'landscape'), 'export: scheme, vocabulary (with what each word maps to), photos');
add('6', 'Times Square', ['NYC', 'night'], null);
const imp = await call('/tags/import', { newTags: [{ slug: 'aerial', label: 'Aerial', kind: 'content' }], aliases: { newyorkcity: ['nyc'] }, photos: { '6': ['city'] } });
ok(imp.created === 1 && imp.tagged === 1, 'import: new tag + aliases + photo tags');
await call('/tags/apply', { offset: 0 });
ok(JSON.stringify(tagsOf('6')) === JSON.stringify(['city', 'landscape', 'newyorkcity', 'newyorkstate', 'usa']), `"NYC" word now → New York City (+parents), Claude's City kept: ${tagsOf('6')}`);
ok(db.prepare("SELECT source FROM photo_tags pt JOIN site_tags t ON t.id=pt.tag_id WHERE photo_id='6' AND slug='city'").get().source === 'ai', "Claude's tags marked as such");

// organizer filters
const f1 = await call('/photos?tag=city');
ok(f1.photos.map(p => p.id).sort().join() === '6', `filter by tag: ${f1.photos.map(p => p.id)}`);
const f2 = await call('/photos?notag=location');
ok(f2.photos.map(p => p.id).sort().join() === '3,4,5', `filter: photos without a location tag (${f2.photos.map(p => p.id)})`);
const tl = await call('/tags');
ok(tl.totals.no_content === 0 && tl.tags.find(x => x.slug === 'landscape').count >= 3, 'Tags page counts');
const det = await call('/photos/6');
ok(det.siteTags.some(x => x.slug === 'city' && x.source === 'ai'), 'photo details list site tags with their source');

// geotag clean-up: Chinese names, districts, neighbourhoods, DC, state suffix only where needed
const { geoParts } = await import(root + '/src/lib/tagging.js');
const gp = (locality, region, country) => geoParts({ locality, region, country }).map(p => p.slug).join('>');
ok(gp('Hongkou Qu', 'Shanghai', 'China') === 'china>shanghai', `Shanghai district: ${gp('Hongkou Qu', 'Shanghai', 'China')}`);
ok(gp('上海市', '上海直辖市', '中國') === 'china>shanghai', `Chinese names: ${gp('上海市', '上海直辖市', '中國')}`);
ok(gp('Daan', 'Taiwan', 'Taiwan') === 'taiwan>taipei', `Taipei district: ${gp('Daan', 'Taiwan', 'Taiwan')}`);
ok(gp('Midtown Manhattan', 'New York', 'United States') === 'usa>newyorkstate>newyorkcity', 'Midtown → New York City');
ok(gp('Alamo Square', 'California', 'United States') === 'usa>california>sanfrancisco', 'SF neighbourhood → San Francisco, no "state"');
ok(gp('Washington', 'District of Columbia', 'United States') === 'usa>washingtondc', 'DC');
ok(gp('Seattle', 'Washington', 'United States') === 'usa>washingtonstate>seattle', 'Washington State');
ok(gp('Admiralty', 'Central and Western District', 'Hong Kong') === 'hongkong' && gp(null, '中西區', '香港') === 'hongkong', 'Hong Kong → country only');
ok(gp('Oxford Manor Condominium', 'Utah', 'United States') === 'usa>utah', 'junk locality dropped');
// a location tag Claude made earlier is adopted by the geotag instead of duplicated
db.prepare("INSERT INTO site_tags (slug, label, kind, aliases) VALUES ('japan', 'Japan', 'location', '[]')").run();
add('7', 'Roppongi', [], { locality: 'Roppongi', region: 'Tokyo', country: 'Japan' });
await call('/tags/apply', { offset: 0 });
ok(JSON.stringify(tagsOf('7')) === JSON.stringify(['japan', 'tokyo']) && db.prepare("SELECT COUNT(*) n FROM site_tags WHERE slug LIKE 'japan%'").get().n === 1, `adopts existing Japan tag: ${tagsOf('7')}`);
const rg = await call('/tags/import', { resetGeo: true, photos: {} });
ok(rg.ok && db.prepare('SELECT COUNT(*) n FROM site_tags WHERE geo_key IS NOT NULL').get().n === 0, 'resetGeo clears geotag tags');

// organizer side panel: tags across a selection, and confirming Claude's tags
const sm = await call('/tags/summary', { ids: ['1', '6'] });
const city = sm.tags.find(t => t.slug === 'city');
ok(sm.total === 2 && city?.n >= 1 && Array.isArray(city.photos) && city.photos.every(id => ['1', '6'].includes(id)), `summary counts tags across the selection (city on ${city?.n}/2)`);
ok(typeof sm.no_content === 'number' && typeof sm.no_location === 'number', 'summary reports photos missing a content / location tag');
const aiBefore = sm.tags.reduce((a, t) => a + t.ai, 0);
const cf = await call('/tags/confirm', { ids: ['6'], slugs: [] });
const sm2 = await call('/tags/summary', { ids: ['6'] });
ok(aiBefore > 0 && cf.confirmed > 0 && sm2.tags.every(t => !t.ai), `confirming turns Claude's tags into yours (${cf.confirmed})`);
const fa = await call('/photos?tagsrc=ai');
ok(Array.isArray(fa.photos) && !fa.photos.some(p => p.id === '6'), 'filter: photos tagged by Claude');
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
