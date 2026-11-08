// Getty Images contributor statements: Account Management → Royalties → Export (monthly, tab-separated).
// Same 65-column layout from 2011 to today; we keep the per-sale columns and ignore the statement summary ones.
const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

export function parseMonth(s) {            // 'Aug-2022' → '2022-08'
  const m = /^([A-Za-z]{3})-(\d{4})$/.exec(String(s || '').trim());
  return m && MONTHS[m[1].toLowerCase()] ? `${m[2]}-${MONTHS[m[1].toLowerCase()]}` : null;
}
export function parseDate(s) {             // '21-Oct-2025' → '2025-10-21'
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || '').trim());
  return m && MONTHS[m[2].toLowerCase()] ? `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}` : null;
}
const num = v => { const n = parseFloat(String(v ?? '').replace(/[,$]/g, '')); return Number.isFinite(n) ? n : 0; };

// Returns { months: { 'YYYY-MM': rows[] }, skipped } — a file normally holds exactly one statement month.
export function parseStatement(text, fileName = '') {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error('empty file');
  const head = lines[0].split('\t').map(h => h.trim());
  const col = name => head.indexOf(name);
  const need = ['Royalty Month', 'Asset Number', 'Gross Royalty in USD'];
  for (const n of need) if (col(n) < 0) throw new Error(`not a Getty statement (missing "${n}" column)`);
  const get = (cells, name) => { const i = col(name); return i >= 0 ? (cells[i] ?? '').trim() : ''; };
  const months = {};
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const c = line.split('\t');
    const month = parseMonth(get(c, 'Royalty Month'));
    const asset = get(c, 'Asset Number');
    if (!month || !asset) { skipped++; continue; } // statement-summary / zero lines
    const desc = get(c, 'Asset Description');
    (months[month] ??= []).push({
      royalty_month: month, sales_date: parseDate(get(c, 'Sales Date')), asset_id: asset,
      title: desc.startsWith(asset + '-') ? desc.slice(asset.length + 1) : desc,
      alt_name: get(c, 'Alternate Asset Number'), collection: get(c, 'Collection'), product_type: get(c, 'Product Type'),
      region: get(c, 'Sale Region'), territory: get(c, 'Sales Territory'), site: get(c, 'Purchase from Site'),
      usage: get(c, 'Rights Usage').slice(0, 300), file_size: get(c, 'File Size'),
      license_fee: num(get(c, 'License Fee in USD')), royalty_rate: num(get(c, 'Royalty Rate')),
      royalty: num(get(c, 'Gross Royalty in USD')), source_file: fileName,
    });
  }
  return { months, skipped };
}

// Re-importing a month replaces it, so dropping the same files again never double counts.
export async function importStatement(env, text, fileName) {
  const { months, skipped } = parseStatement(text, fileName);
  const out = [];
  for (const [month, rows] of Object.entries(months)) {
    const stmts = [env.DB.prepare('DELETE FROM getty_sales WHERE royalty_month = ?1').bind(month)];
    for (const r of rows) {
      stmts.push(env.DB.prepare(
        `INSERT INTO getty_sales (royalty_month, sales_date, asset_id, title, alt_name, collection, product_type, region,
           territory, site, usage, file_size, license_fee, royalty_rate, royalty, source_file)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`
      ).bind(r.royalty_month, r.sales_date, r.asset_id, r.title, r.alt_name, r.collection, r.product_type, r.region,
        r.territory, r.site, r.usage, r.file_size, r.license_fee, r.royalty_rate, r.royalty, r.source_file));
    }
    stmts.push(env.DB.prepare(
      `INSERT INTO getty_imports (royalty_month, source_file, rows, imported_at) VALUES (?1, ?2, ?3, unixepoch())
       ON CONFLICT(royalty_month) DO UPDATE SET source_file = excluded.source_file, rows = excluded.rows, imported_at = excluded.imported_at`
    ).bind(month, fileName, rows.length));
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    out.push({ month, rows: rows.length });
  }
  // a month whose statement had no sales still counts as covered
  const m = /^(\d{4})(\d{2})-/.exec(fileName || '');
  if (!out.length && m) {
    await env.DB.prepare(
      `INSERT INTO getty_imports (royalty_month, source_file, rows) VALUES (?1, ?2, 0)
       ON CONFLICT(royalty_month) DO UPDATE SET source_file = excluded.source_file, rows = 0, imported_at = unixepoch()`
    ).bind(`${m[1]}-${m[2]}`, fileName).run();
    out.push({ month: `${m[1]}-${m[2]}`, rows: 0 });
  }
  return { months: out, skipped };
}
