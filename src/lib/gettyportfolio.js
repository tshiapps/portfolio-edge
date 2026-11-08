// Getty portfolio: every accepted asset (sold or not) from DeepMeta's "Export whole Portfolio" CSV.
// Re-importing the whole export each time is the intended workflow: rows are keyed by Getty asset ID and
// compared by a hash of the row, so only new or changed assets are written. Assets missing from a later full
// export are marked as gone from the portfolio (never deleted — their links and sales stay).
import { now } from './util.js';
import { FLICKR_ID_FILE } from '../routes/getty.js';
import { resetGettyCache } from './folders.js';

// RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes
export function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const NEED = ['Id', 'Artist', 'Title', 'Object name'];
const bool = (v) => (String(v).toLowerCase() === 'true' ? 1 : 0);
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const day = (v) => (/^\d{4}-\d{2}-\d{2}/.test(v || '') ? String(v).slice(0, 10) : null);

export function portfolioRows(text) {
  const all = parseCsv(text);
  if (!all.length) throw new Error('empty file');
  const head = all[0].map((h) => h.trim());
  for (const n of NEED) if (!head.includes(n)) throw new Error(`not a DeepMeta portfolio export (missing "${n}" column)`);
  const ix = Object.fromEntries(head.map((h, i) => [h, i]));
  const get = (r, k) => (ix[k] == null ? '' : (r[ix[k]] ?? '').trim());
  const out = [];
  for (const r of all.slice(1)) {
    const id = get(r, 'Id');
    if (!/^\d+$/.test(id)) continue;
    const type = get(r, 'Type');
    out.push({
      asset_id: id, artist: get(r, 'Artist') || null, asset_type: type || null,
      is_video: bool(get(r, 'Is video')) || /video/i.test(type) ? 1 : 0,
      title: get(r, 'Title') || null, description: get(r, 'Description') || null, object_name: get(r, 'Object name') || null,
      width: int(get(r, 'Width')), height: int(get(r, 'Height')), orientation: get(r, 'Orientation') || null,
      created_on: day(get(r, 'Created at')), submitted_at: get(r, 'Submitted at') || null,
      collection: get(r, 'Collection name') || null, license_model: get(r, 'License model') || null,
      editorial: bool(get(r, 'Editorial use')), city: get(r, 'City') || null, state: get(r, 'State province') || null,
      country: get(r, 'Country id') || null, keywords: get(r, 'Keywords') || null,
      page_url: get(r, 'Referral destinations').split(/\s+/)[0] || `https://www.gettyimages.com/detail/${id}`,
      deactivated: bool(get(r, 'Deactivated')),
    });
  }
  if (!out.length) throw new Error('no assets in the file');
  return out;
}

const COLS = ['artist', 'asset_type', 'is_video', 'title', 'description', 'object_name', 'width', 'height', 'orientation', 'created_on',
  'submitted_at', 'collection', 'license_model', 'editorial', 'city', 'state', 'country', 'keywords', 'page_url', 'deactivated'];

async function hashRow(r) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(JSON.stringify(COLS.map((c) => r[c] ?? null))));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function importPortfolio(env, text, file = '') {
  const rows = portfolioRows(text);
  const t = now();
  const existing = new Map((await env.DB.prepare('SELECT asset_id, row_hash, in_portfolio, artist FROM getty_assets').all()).results.map((r) => [r.asset_id, r]));
  const seen = new Set(rows.map((r) => r.asset_id));
  let added = 0, updated = 0, unchanged = 0, back = 0;
  const stmts = [], changed = [];
  const set = COLS.map((c, i) => `${c} = ?${i + 2}`).join(', ');
  for (const r of rows) {
    const h = await hashRow(r), ex = existing.get(r.asset_id);
    if (ex && ex.row_hash === h && ex.in_portfolio === 1) { unchanged++; continue; }
    if (!ex || !ex.row_hash) added++; else if (ex.in_portfolio === 0) back++; else updated++;
    const vals = COLS.map((c) => r[c] ?? null);
    stmts.push(env.DB.prepare(
      `INSERT INTO getty_assets (asset_id, ${COLS.join(', ')}, row_hash, in_portfolio, first_seen, last_seen)
       VALUES (?1, ${COLS.map((_, i) => `?${i + 2}`).join(', ')}, ?${COLS.length + 2}, 1, ?${COLS.length + 3}, ?${COLS.length + 3})
       ON CONFLICT(asset_id) DO UPDATE SET ${set}, row_hash = ?${COLS.length + 2}, in_portfolio = 1,
         first_seen = COALESCE(getty_assets.first_seen, ?${COLS.length + 3}), last_seen = ?${COLS.length + 3}`
    ).bind(r.asset_id, ...vals, h, t));
    changed.push(r);
  }
  // gone: in the portfolio before, from an account this file covers, but not in this file.
  // A file noticeably smaller than what we have for an account is treated as partial — nothing is marked gone.
  const byArtist = {};
  for (const r of rows) byArtist[r.artist] = (byArtist[r.artist] || 0) + 1;
  const had = {};
  for (const e of existing.values()) if (e.in_portfolio === 1) had[e.artist] = (had[e.artist] || 0) + 1;
  const partialFor = Object.keys(byArtist).filter((a) => had[a] && byArtist[a] < had[a] * 0.8);
  const goneIds = [...existing.values()].filter((e) => e.in_portfolio === 1 && byArtist[e.artist] && !partialFor.includes(e.artist) && !seen.has(e.asset_id)).map((e) => e.asset_id);
  for (const id of goneIds) stmts.push(env.DB.prepare('UPDATE getty_assets SET in_portfolio = 0, last_seen = ?2 WHERE asset_id = ?1').bind(id, t));
  // exact links: the Flickr photo ID in the file name you submitted (only if that photo is on the site)
  for (const r of changed) {
    const fid = FLICKR_ID_FILE.exec(r.object_name || '')?.[1];
    if (fid) stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO getty_links (asset_id, photo_id, status, how, decided_at)
       SELECT ?1, ?2, 'confirmed', 'filename', ?3 WHERE EXISTS (SELECT 1 FROM photos WHERE id = ?2 AND status != 'deleted')`
    ).bind(r.asset_id, fid, t));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  await resolveLinks(env);
  const note = partialFor.length ? `Looks partial for ${partialFor.join(', ')} — nothing marked as gone there` : null;
  await env.DB.prepare(
    `INSERT INTO getty_portfolio_imports (file, at, rows, added, updated, unchanged, gone, back, partial, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
  ).bind(String(file).slice(0, 200), t, rows.length, added, updated, unchanged, goneIds.length, back, partialFor.length ? 1 : 0, note).run();
  return { rows: rows.length, added, updated, unchanged, gone: goneIds.length, back, partial: !!partialFor.length, note,
    accounts: byArtist, videos: rows.filter((r) => r.is_video).length };
}

// one resolved photo per asset: your manual link (linked_photo_id) is read first by every consumer; here
// photo_id = confirmed > auto > the Flickr ID in a statement's file name
export async function resolveLinks(env, assetId = null) {
  const t = now();
  // statement file names (sold assets) are exact links too
  const sold = (await env.DB.prepare(
    `SELECT DISTINCT asset_id, alt_name FROM getty_sales WHERE alt_name GLOB '[0-9]*' ${assetId ? 'AND asset_id = ?1' : ''}`
  ).bind(...(assetId ? [assetId] : [])).all()).results;
  const st = [];
  for (const s of sold) {
    const fid = FLICKR_ID_FILE.exec(s.alt_name || '')?.[1];
    if (fid) st.push(env.DB.prepare(
      `INSERT OR IGNORE INTO getty_links (asset_id, photo_id, status, how, decided_at)
       SELECT ?1, ?2, 'confirmed', 'filename', ?3 WHERE EXISTS (SELECT 1 FROM photos WHERE id = ?2 AND status != 'deleted')`
    ).bind(s.asset_id, fid, t));
  }
  for (let i = 0; i < st.length; i += 100) await env.DB.batch(st.slice(i, i + 100));
  await env.DB.prepare(
    `UPDATE getty_assets SET photo_id = (
       SELECT l.photo_id FROM getty_links l WHERE l.asset_id = getty_assets.asset_id AND l.status IN ('confirmed', 'auto')
       ORDER BY l.status = 'confirmed' DESC, l.rank, l.score DESC LIMIT 1)
     ${assetId ? 'WHERE asset_id = ?1' : ''}`
  ).bind(...(assetId ? [assetId] : [])).run();
  resetGettyCache();
}
