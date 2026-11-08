/* tonyshi.photos admin — vanilla JS, hash-routed. */
(() => {
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const drawer = $('#drawer');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = n => (n ?? 0).toLocaleString();
const fmtBytes = b => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round((b || 0) / 1e3) + ' KB';
const ago = t => {
  if (!t) return 'never';
  const s = Math.floor(Date.now() / 1000) - t;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return Math.floor(s / 86400) + ' d ago';
};
const date = t => t ? new Date(t * 1000).toLocaleString() : '—';

function toast(msg, bad = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), bad ? 7000 : 3500);
}

async function api(path, opts = {}) {
  const res = await fetch('/api/admin' + path, {
    ...opts,
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const run = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

let timer = null;
let albumsCache = null;
async function albums(force) {
  if (!albumsCache || force) albumsCache = (await api('/albums')).albums;
  return albumsCache;
}

// ---------------- routing ----------------
function route() {
  clearInterval(timer);
  closeDrawer();
  document.body.classList.remove('withside');
  view.onclick = null; view.oninput = null;
  const [name, qs] = (location.hash.slice(1) || 'dashboard').split('?');
  const params = new URLSearchParams(qs || '');
  if (params.get('error')) toast(params.get('error'), true);
  if (params.get('connected')) toast(`Connected Flickr account ${params.get('connected')} — sync starts within a minute`);
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + (name === 'igstats' ? 'stats' : name)));
  ({ dashboard, organizer, albums: albumsView, builder: builderView, featured: featView, instagram: igView, tags: tagsView, popularity: popularityView, media: mediaView, getty: gettyView, gettymatch: gettyMatchView, stats: statsView, igstats: igStatsView, settings }[name] || dashboard)(params);
}
window.addEventListener('hashchange', route);

// ---------------- dashboard ----------------
async function dashboard() {
  const draw = async () => {
    const s = await api('/status');
    const tot = { ok: 0, pending: 0, meta: 0, fetch: 0, error: 0, deleted: 0, flickr: 0 };
    s.accounts.forEach(a => { for (const k of ['ok', 'pending', 'meta', 'fetch', 'error', 'deleted']) tot[k] += a.counts[k] || 0; tot.flickr += a.flickr_count || 0; });
    const catalog = tot.ok + tot.pending + tot.meta + tot.fetch + tot.error;
    const sp = s.storage.used / s.storage.budget, ap = s.api.calls / s.api.budget;
    const setup = !s.config.apiKey || !s.accounts.length || !s.config.encryptionKey;
    view.innerHTML = `
      ${setup ? `<div class="callout" style="margin-bottom:16px">
        <strong>Setup:</strong>
        ${!s.config.encryptionKey ? 'Set the <code>ENCRYPTION_KEY</code> secret first. ' : ''}
        ${!s.config.apiKey ? 'Add your Flickr API key and secret in <a href="#settings">Settings</a>, then connect your account(s).'
          : !s.accounts.length ? '<a class="btn primary" href="/admin/flickr/connect">Connect a Flickr account</a>' : ''}
      </div>` : ''}
      <div class="cards">
        <div class="card"><div class="k">On Flickr</div><div class="v">${fmtN(tot.flickr)}</div><div class="small muted">reported by Flickr</div></div>
        <div class="card"><div class="k">In catalog</div><div class="v">${fmtN(catalog)}</div>
          <div class="bar"><i style="width:${tot.flickr ? Math.min(100, catalog / tot.flickr * 100) : 0}%"></i></div></div>
        <div class="card"><div class="k">Stored (ready)</div><div class="v">${fmtN(tot.ok)}</div>
          <div class="bar"><i style="width:${catalog ? tot.ok / catalog * 100 : 0}%"></i></div></div>
        <div class="card"><div class="k">Queued</div><div class="v">${fmtN(tot.pending + tot.meta)}</div><div class="small muted">${fmtN(tot.meta)} metadata-only</div></div>
        <div class="card"><div class="k">Errors</div><div class="v ${tot.error ? 'err' : ''}">${fmtN(tot.error)}</div>
          <div class="small"><a href="#organizer?status=error">view</a></div></div>
        <div class="card"><div class="k">R2 storage</div><div class="v">${fmtBytes(s.storage.used)}</div>
          <div class="bar ${sp > .95 ? 'bad' : sp > .8 ? 'warn' : ''}"><i style="width:${Math.min(100, sp * 100)}%"></i></div>
          <div class="small muted">of ${fmtBytes(s.storage.budget)} budget${tot.ok ? ` · avg ${fmtBytes(s.storage.used / tot.ok)}` : ''}</div></div>
        ${s.lowres ? `<div class="card"><div class="k">Low resolution</div><div class="v warn">${fmtN(s.lowres)}</div>
          <div class="small"><a href="#organizer?shape=lowres">select &amp; re-process</a></div></div>` : ''}
        <div class="card"><div class="k">Faves / comments</div><div class="v">${fmtN(s.metrics?.fresh)}</div>
          <div class="bar"><i style="width:${s.metrics?.total ? (s.metrics.fresh / s.metrics.total) * 100 : 0}%"></i></div>
          <div class="small muted">of ${fmtN(s.metrics?.total)} stored · ${s.listingHasCounts === '1' ? 'refreshed daily with the listing' : s.listingHasCounts === '0' ? 'refreshed per photo, weekly' : 'waiting for next listing'}</div></div>
        ${tot.fetch || s.settings.fetch_mode === 'fetcher' ? `<div class="card"><div class="k">Waiting for photo fetcher</div><div class="v ${tot.fetch ? 'warn' : ''}">${fmtN(tot.fetch)}</div>
          <div class="small muted">full-size downloads Flickr won't give Cloudflare — TSP Uploader → Photos → Start</div></div>` : ''}
        <div class="card"><div class="k">Image downloads</div><div class="v">${s.cdn.rate}/min</div>
          <div class="small ${s.cdn.pausedUntil > s.now ? 'warn' : 'muted'}">${s.cdn.pausedUntil > s.now
            ? `paused by Flickr (429) until ${new Date(s.cdn.pausedUntil * 1000).toLocaleTimeString()}`
            : 'adapts automatically to Flickr limits'}</div></div>
        <div class="card"><div class="k">Flickr API (this hour)</div><div class="v">${fmtN(s.api.calls)}</div>
          <div class="bar ${ap > .95 ? 'warn' : ''}"><i style="width:${Math.min(100, ap * 100)}%"></i></div>
          <div class="small muted">of ${fmtN(s.api.budget)} budget</div></div>
      </div>
      ${tot.fetch ? `<div class="callout" style="margin-top:14px">
        <strong>${fmtN(tot.fetch)} photo(s) need the photo fetcher.</strong> Flickr is refusing full-size downloads to Cloudflare's shared servers,
        so your Mac downloads and resizes them instead: open the <strong>TSP Uploader</strong> app → <strong>Photos</strong> tab → <strong>Start</strong>.
        <div class="small muted" style="margin-top:6px">No app on this Mac? <a href="#media">Download it from the Aerial tab</a>. Terminal alternative:
          <code>cd ~/"Claude Agent/tonyshi-photos" &amp;&amp; npm run fetch</code></div>
      </div>` : ''}
      <div class="row" style="margin-top:16px">
        <label class="small" title="Skip the Worker's own full-size downloads (Flickr blocks them anyway) and send every new photo to the fetcher">
          <input type="checkbox" id="fetchMode" ${s.settings.fetch_mode === 'fetcher' ? 'checked' : ''}> Always use the photo fetcher for full-size images</label>
      </div>
      <div class="row" style="margin-top:16px">
        <button id="runNow" class="primary">Run sync now</button>
        <button id="pause">${s.paused ? 'Resume sync' : 'Pause sync'}</button>
        ${tot.error ? '<button id="retry">Retry errors</button>' : ''}
        ${tot.deleted ? `<button id="purge" class="danger">Purge ${fmtN(tot.deleted)} deleted</button>` : ''}
        <span class="spacer"></span>
        ${s.paused ? '<span class="pill warn">sync paused</span>' : '<span class="pill ok">sync active · checks Flickr daily</span>'}
        ${s.accounts.length ? '<a class="btn" href="/admin/flickr/connect">+ Connect another account</a>' : ''}
      </div>
      ${s.accounts.length ? `<h2>Flickr accounts</h2>
      <div class="tblwrap"><table>
        <tr><th>Account</th><th>Flickr</th><th>Catalog</th><th>Stored</th><th>Queued</th><th>Errors</th><th>Public</th><th>Sizes</th><th>State</th><th></th></tr>
        ${s.accounts.map(a => {
          const c = a.counts, cat = c.ok + c.pending + c.meta + (c.fetch || 0) + c.error;
          const match = a.flickr_count != null && a.last_full_sync && cat === a.flickr_count;
          return `<tr>
          <td><strong>${esc(a.realname || a.username)}</strong><div class="small muted">${esc(a.username)} · ${esc(a.nsid)}</div>
            <div class="small muted" title="The Flickr API key this account was connected with">${a.app_key ? `key …${esc(a.app_key.slice(-4))}` : 'key: the one in Settings'}</div>
            ${a.enabled ? '' : '<span class="pill warn">paused</span>'}</td>
          <td>${fmtN(a.flickr_count)}</td>
          <td>${fmtN(cat)} ${a.last_full_sync ? (match ? '<span class="pill ok">matches</span>' : cat < a.flickr_count ? `<span class="pill" title="Flickr's count includes private / friends / family photos, which aren't synced">${fmtN(a.flickr_count - cat)} private / not synced</span>` : `<span class="pill warn">+${fmtN(cat - a.flickr_count)}</span>`) : ''}</td>
          <td>${fmtN(c.ok)}</td><td>${fmtN(c.pending + c.meta + (c.fetch || 0))}</td>
          <td>${c.error ? `<a class="err" href="#organizer?account=${a.id}&status=error">${fmtN(c.error)}</a>` : 0}</td>
          <td>${fmtN(c.public)}</td>
          <td class="small"><button class="linkbtn" data-sizes="${a.id}" title="Image sizes and quality for this account">${a.long_edge || a.base_edge || a.quality
            ? `${a.long_edge ? fmtK(a.long_edge) : '·'} / ${a.base_edge ? fmtK(a.base_edge) : '·'} · q${a.quality || '·'}` : 'default'} ✎</button></td>
          <td><div>${esc(a.phase_detail)}</div><div class="small muted">full listing ${ago(a.last_full_sync)} · albums ${ago(a.last_album_sync)} · changes ${ago(a.last_recent_check)}</div>
            ${a.last_error ? `<div class="small err">${esc(a.last_error)}</div>` : ''}</td>
          <td><div class="row">
            <button data-acc="${a.id}" data-act="resync" title="Re-list everything (detects deletions)">Resync</button>
            <button data-acc="${a.id}" data-act="${a.enabled ? 'pause' : 'resume'}">${a.enabled ? 'Pause' : 'Resume'}</button>
            ${a.last_error && /not marked deleted/.test(a.last_error) ? `<button class="danger" data-acc="${a.id}" data-act="apply-deletions">Confirm deletions</button>` : ''}
            ${a.last_error && /oauth|signature|token|invalid auth|login|401|98\b|100\b/i.test(a.last_error) ? `<a class="btn primary" href="/admin/flickr/connect" title="Log in to Flickr as ${esc(a.username)} in this browser first">Reconnect</a>` : ''}
          </div></td></tr>`;
        }).join('')}
      </table></div>` : ''}
      <h2>Activity</h2>
      <div class="log">${s.log.map(l => `<div class="${l.level}">${new Date(l.ts * 1000).toLocaleString()} ${l.account_id ? `[#${l.account_id}] ` : ''}${esc(l.msg)}</div>`).join('') || '<span class="muted">Nothing yet.</span>'}</div>`;

    $('#fetchMode').onchange = run(async e => {
      await api('/settings', { method: 'POST', body: { fetch_mode: e.target.checked ? 'fetcher' : 'auto' } });
      toast(e.target.checked ? 'New full-size downloads go to the photo fetcher' : 'Worker tries first, fetcher handles what Flickr blocks');
    });
    $('#runNow').onclick = run(async () => { await api('/sync/run', { method: 'POST' }); toast('Sync tick started'); setTimeout(run(draw), 4000); });
    $('#pause').onclick = run(async () => { await api('/settings', { method: 'POST', body: { paused: !s.paused } }); draw(); });
    if ($('#retry')) $('#retry').onclick = run(async () => { const r = await api('/maintenance/retry-errors', { method: 'POST' }); toast(`Re-queued ${r.retried}`); draw(); });
    if ($('#purge')) $('#purge').onclick = run(async () => {
      if (!confirm('Delete the stored images and catalog rows for photos that are gone from Flickr?')) return;
      const r = await api('/maintenance/purge-deleted', { method: 'POST' }); toast(`Purged ${r.purged}`); draw();
    });
    view.querySelectorAll('[data-sizes]').forEach(b => b.onclick = () => accountSizes(s.accounts.find(a => a.id === +b.dataset.sizes), draw));
    view.querySelectorAll('[data-acc]').forEach(b => b.onclick = run(async () => {
      if (b.dataset.act === 'apply-deletions' && !confirm('Mark the photos no longer on Flickr as deleted?')) return;
      const r = await api(`/accounts/${b.dataset.acc}/${b.dataset.act}`, { method: 'POST' });
      if (r.ok === false) toast(r.message || 'Not now', true);
      else toast(b.dataset.act === 'albums' ? 'Album sync started — collections update within a minute, album photos over the next while' : 'Done');
      draw();
    }));
  };
  await run(draw)();
  timer = setInterval(() => { if (!document.hidden) run(draw)(); }, 10000);
}

// ---------------- organizer ----------------
const state = { selected: new Set(), items: [], total: 0, last: -1, loading: false, done: false, params: null };
let observer = null;

function flickrThumb(p, size = 'q') {
  return p.server && p.secret ? `https://live.staticflickr.com/${p.server}/${p.id}_${p.secret}_${size}.jpg` : '';
}
function thumbSrc(p) { return p.status === 'ok' || p.status === 'meta' ? `/api/admin/img/${p.id}/t?v=${p.synced_at || 0}` : flickrThumb(p); }

async function organizer(params) {
  state.selected.clear(); state.items = []; state.last = -1; state.done = false; state.params = params;
  if (params.get('shape') === 'pano' && !params.get('ratio')) {
    const st = await api('/status').catch(() => null);
    if (st) params.set('ratio', st.settings.pano_ratio || '2.2');
  }
  observer?.disconnect();
  const al = await albums(true).catch(() => []);
  const cols = (await api('/collections').catch(() => ({ collections: [] }))).collections;
  const stags = (await api('/tags').catch(() => ({ tags: [] }))).tags;
  siteTagsCache = stags;
  const accs = (await api('/status').catch(() => ({ accounts: [] }))).accounts;
  const p = k => params.get(k) || '';
  const opt = (pairs, cur) => pairs.map(([v, l]) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const local = al.filter(a => a.source === 'local'), fl = al.filter(a => a.source === 'flickr');
  view.innerHTML = `
    <div class="filters row">
      <input type="search" id="q" placeholder="Search title, tags, place, ID" value="${esc(p('q'))}">
      <select id="account">${opt([['', 'All accounts'], ...accs.map(a => [String(a.id), a.username])], p('account'))}</select>
      <select id="album">${opt([['', 'All albums'], ['__none__', 'Not in any album'], ['__nolocal__', 'Not in a site album']], p('album'))}
        ${local.length ? `<optgroup label="Site albums">${opt(local.map(a => [a.id, `${a.title} (${a.n})`]), p('album'))}</optgroup>` : ''}
        ${fl.length ? `<optgroup label="Flickr albums">${opt(fl.map(a => [a.id, `${a.title} (${a.n})`]), p('album'))}</optgroup>` : ''}
      </select>
      ${cols.length ? `<select id="collection">${opt([['', 'All collections'], ...cols.map(c => [c.id, `${c.parent_id ? '— ' : ''}${c.title} (${c.n})`])], p('collection'))}</select>` : ''}
      <select id="status">${opt([['', 'Any status'], ['ok', 'Stored'], ['incomplete', 'Not stored yet'], ['fetch', 'Waiting for fetcher'], ['error', 'Errors'], ['hidden', 'Hidden from site'], ['deleted', 'Deleted on Flickr']], p('status'))}</select>
      <input id="tag" class="tagfilter" placeholder="Any tag — type to search" data-value="${esc(p('tag') || (p('notag') ? '__no' + p('notag') : p('tagsrc') === 'ai' ? '__ai' : ''))}"
        data-label="${esc(p('tag') ? (stags.find(t => t.slug === p('tag'))?.label || p('tag')) : p('notag') ? `⚠ no ${p('notag')} tag` : p('tagsrc') === 'ai' ? '✦ tagged by Claude' : '')}"
        value="${esc(p('tag') ? (stags.find(t => t.slug === p('tag'))?.label || p('tag')) : p('notag') ? `⚠ no ${p('notag')} tag` : p('tagsrc') === 'ai' ? '✦ tagged by Claude' : '')}">
      <select id="shape">${opt([['', 'Any shape'], ['pano', 'Panoramas (very wide/tall)'], ['lowres', 'Low resolution (re-process)']], p('shape'))}</select>
      <select id="vis">${opt([['', 'Any visibility'], ['public', 'Public on Flickr'], ['private', 'Private / friends / family']], p('vis'))}</select>
      <select id="rating" title="Your star rating">${opt([['', 'Any rating'], ['unrated', 'Not rated'], ['1', '★ only (rejects)'], ['2+', '★★ and up'], ['3+', '★★★ and up'], ['4+', '★★★★ and up'], ['5', '★★★★★']], p('rating'))}</select>
      <select id="sort">${opt([['upload', 'Newest upload'], ['upload_asc', 'Oldest upload'], ['taken', 'Newest taken'], ['taken_asc', 'Oldest taken'], ['title', 'Title'], ['album', 'Album order'], ['popular', 'Most popular on Flickr'], ['faves', 'Most faves'], ['views', 'Most views'], ['comments', 'Most comments'], ['rating', 'Your rating']], p('sort') || 'upload')}</select>
      <span class="spacer"></span>
      <span id="count" class="muted"></span>
      <button id="selAll" title="Select every photo matching these filters">Select all</button>
    </div>
    <p class="small muted" style="margin:0 0 8px">Click to select · Shift-click for a range · Double-click (or “i”) for details · Keys <b>1–5</b> rate the selected photos, <b>0</b> clears</p>
    <div class="grid" id="grid"></div>
    <div class="sentinel" id="sentinel"></div>
    <div class="selbar" id="selbar" hidden></div>
    <aside class="seltags" id="seltags" hidden></aside>`;

  const apply = () => {
    const q = new URLSearchParams();
    for (const id of ['q', 'account', 'album', 'collection', 'status', 'shape', 'vis', 'rating', 'sort']) { const v = $('#' + id)?.value; if (v) q.set(id, v); }
    const tv = $('#tag').dataset.value || '';
    if (tv === '__ai') q.set('tagsrc', 'ai'); else if (tv.startsWith('__no')) q.set('notag', tv.slice(4)); else if (tv) q.set('tag', tv);
    history.replaceState(null, '', '#organizer' + (q.toString() ? '?' + q : ''));
    organizer(q);
  };
  tagSearch($('#tag'), { tags: stags, specials: [['', 'Any tag'], ['__ai', '✦ tagged by Claude'], ['__nocontent', '⚠ no content tag'], ['__nolocation', '⚠ no location tag']],
    onPick: (v, label) => { $('#tag').dataset.value = v; $('#tag').dataset.label = v ? label : ''; $('#tag').value = v ? label : ''; apply(); } });
  ['account', 'album', 'collection', 'status', 'shape', 'vis', 'rating', 'sort'].forEach(id => { if ($('#' + id)) $('#' + id).onchange = apply; });
  let deb; $('#q').oninput = () => { clearTimeout(deb); deb = setTimeout(apply, 350); };
  $('#selAll').onclick = run(async () => {
    const { ids } = await api('/photos/ids?' + new URLSearchParams(state.params));
    ids.forEach(id => state.selected.add(id));
    paintSel(); toast(`Selected ${fmtN(ids.length)}`);
  });

  observer = new IntersectionObserver(es => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: '800px' });
  observer.observe($('#sentinel'));
  $('#grid').addEventListener('click', onTileClick);
  $('#grid').addEventListener('dblclick', e => { const t = e.target.closest('.tile'); if (t) openPhoto(t.dataset.id); });
  await loadMore();
}

function tileHtml(p, i) {
  const b = [];
  if (p.status === 'pending' || p.status === 'meta') b.push('<span class="b warn">queued</span>');
  if (p.status === 'fetch') b.push('<span class="b warn" title="Waiting for the photo fetcher">fetcher</span>');
  if (p.status === 'error') b.push(`<span class="b bad" title="${esc(p.error)}">error</span>`);
  if (p.status === 'deleted') b.push('<span class="b bad">deleted</span>');
  if (!p.is_public) b.push('<span class="b" title="Not public on Flickr">private</span>');
  if (p.hidden) b.push('<span class="b">hidden</span>');
  if (p.media === 'video') b.push('<span class="b">video</span>');
  if (['popular', 'faves', 'views', 'comments'].includes(state.params.get('sort'))) {
    b.unshift(`<span class="b" title="faves · comments · views">${state.params.get('sort') === 'popular' ? `★ ${(p.pop_score ?? 0).toFixed(1)} · ` : ''}♥ ${fmtN(p.faves)} · 💬 ${fmtN(p.comments)} · 👁 ${fmtN(p.views)}</span>`);
  }
  return `<div class="tile ${state.selected.has(p.id) ? 'sel' : ''} ${p.hidden ? 'hiddenp' : ''}" data-id="${p.id}" data-i="${i}" title="${esc(p.title)}">
    <img loading="lazy" src="${thumbSrc(p)}" data-fb="${flickrThumb(p)}" alt="">
    <button class="info" data-info="${p.id}" title="Details">i</button>
    ${p.rating ? `<span class="stars r${p.rating}" title="Your rating">${'★'.repeat(p.rating)}</span>` : ''}
    <div class="badges">${b.join('')}</div></div>`;
}

async function loadMore() {
  const grid = $('#grid');
  if (state.loading || state.done || !grid) return;
  state.loading = true;
  try {
    const q = new URLSearchParams(state.params);
    q.set('offset', state.items.length); q.set('limit', 300);
    const r = await api('/photos?' + q);
    const start = state.items.length;
    state.items.push(...r.photos);
    if (state.items.length >= r.total || !r.photos.length) state.done = true;
    $('#count').textContent = `${fmtN(r.total)} photos`;
    if (!state.items.length) { grid.innerHTML = '<p class="muted">No photos match.</p>'; return; }
    grid.insertAdjacentHTML('beforeend', r.photos.map((p, i) => tileHtml(p, start + i)).join(''));
    grid.querySelectorAll('img[data-fb]').forEach(img => {
      const fb = img.dataset.fb;
      img.removeAttribute('data-fb');
      img.onerror = () => { img.onerror = null; if (fb && img.src !== fb) img.src = fb; };
    });
  } catch (e) { toast(e.message, true); }
  finally { state.loading = false; }
}

function onTileClick(e) {
  const info = e.target.closest('[data-info]');
  if (info) { openPhoto(info.dataset.info); return; }
  const t = e.target.closest('.tile');
  if (!t) return;
  const i = +t.dataset.i;
  if (e.shiftKey && state.last >= 0) {
    const [a, b] = [Math.min(state.last, i), Math.max(state.last, i)];
    for (let k = a; k <= b; k++) state.selected.add(state.items[k].id);
  } else if (state.selected.has(t.dataset.id)) state.selected.delete(t.dataset.id);
  else state.selected.add(t.dataset.id);
  state.last = i;
  paintSel();
}

// ---------------- organizer: your star rating (selection bar, keys 1–5 / 0) ----------------
async function rateSelected(v) {
  const ids = [...state.selected];
  if (!ids.length) return;
  await api('/photos/bulk', { method: 'POST', body: { ids, rating: v } });
  for (const p of state.items) if (state.selected.has(p.id)) p.rating = v;
  document.querySelectorAll('#grid .tile.sel').forEach(el => {
    el.querySelector('.stars')?.remove();
    if (v) el.querySelector('.info').insertAdjacentHTML('afterend', `<span class="stars r${v}" title="Your rating">${'★'.repeat(v)}</span>`);
  });
  toast(v ? `Rated ${fmtN(ids.length)} photo${ids.length === 1 ? '' : 's'} ${'★'.repeat(v)}` : `Rating cleared on ${fmtN(ids.length)}`);
}
document.addEventListener('keydown', e => {
  if (!location.hash.startsWith('#organizer') || !state.selected.size || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  if (/^[0-5]$/.test(e.key)) { e.preventDefault(); run(() => rateSelected(+e.key))(); }
});

// ---------------- organizer: tags of the selected photos (to review Claude's tagging) ----------------
let sideSeq = 0, sideTimer = null, sideOpen = true, sidePin = null; // sidePin = tag id clicked to keep its photos highlighted
function sideTags() {
  clearTimeout(sideTimer);
  sideTimer = setTimeout(run(drawSideTags), 220);
}
async function drawSideTags() {
  const box = $('#seltags');
  if (!box) return;
  const ids = [...state.selected];
  document.body.classList.toggle('withside', !!ids.length && sideOpen);
  box.hidden = !ids.length;
  if (!ids.length) { sidePin = null; return; }
  if (!sideOpen) { box.innerHTML = `<button class="side-tab" id="sideOpen" title="Show the tags of the selection">Tags ‹</button>`; $('#sideOpen').onclick = () => { sideOpen = true; drawSideTags(); }; return; }
  const my = ++sideSeq;
  box.classList.add('busy');
  const d = await api('/tags/summary', { method: 'POST', body: { ids } });
  if (my !== sideSeq) return;
  box.classList.remove('busy');
  const N = d.total, byId = new Map(d.tags.map(t => [t.id, t]));
  const aiTotal = d.tags.reduce((a, t) => a + t.ai, 0);
  const pathOf = t => { const p = []; for (let x = (siteTagsCache || []).find(y => y.id === t.parent_id), n = 0; x && n < 8; x = (siteTagsCache || []).find(y => y.id === x.parent_id), n++) p.unshift(x.label); return p.join(' › '); };
  const src = t => [t.ai && `✦ Claude ${t.ai}`, t.geo && `📍 geotag ${t.geo}`, t.flickr && `⚙ Flickr-tag rule ${t.flickr}`, t.manual && `✓ you ${t.manual}`].filter(Boolean).join(' · ');
  const chip = t => {
    const pct = Math.round(t.n / N * 100), all = t.n === N;
    const mark = t.ai === t.n ? '✦' : t.manual === t.n ? '✓' : t.geo === t.n ? '📍' : t.ai ? '✦·' : '';
    return `<div class="stc${all ? ' all' : ''}${t.ai ? ' ai' : ''}${t.id === sidePin ? ' pin' : ''}" style="--p:${pct}%" data-tag="${t.id}" title="${esc((pathOf(t) ? pathOf(t) + ' › ' : '') + t.label)}\n${t.n} of ${N} photos\n${esc(src(t))}">
      <span class="stl">${mark ? `<i>${mark}</i>` : ''}${esc(t.label)}</span>
      <span class="stn">${all ? (N > 1 ? 'all' : '') : `${t.n}/${N}`}</span>
      <span class="sta">${!all ? `<button class="mini" data-addall="${esc(t.slug)}" title="Add to all ${N}">+all</button>` : ''}${t.ai ? `<button class="mini" data-ok="${esc(t.slug)}" title="Looks right — confirm Claude's tag">✓</button>` : ''}<button class="mini danger" data-rm="${esc(t.slug)}" title="Remove from these ${N} photo(s)">×</button></span>
    </div>`;
  };
  const group = (kind, title, gap) => {
    const list = d.tags.filter(t => t.kind === kind);
    return `<h4>${title} ${gap ? `<span class="gap" title="Selected photos with no ${kind} tag">⚠ ${fmtN(gap)} without</span>` : ''}</h4>
      <div class="stlist">${list.map(chip).join('') || '<span class="small muted">none</span>'}</div>`;
  };
  box.innerHTML = `
    <div class="row"><strong>${fmtN(N)} selected</strong><span class="spacer"></span><button class="mini" id="sideClose" title="Hide this panel">›</button></div>
    <p class="small muted" style="margin:4px 0 10px">Solid = every selected photo has it. Grey bar = how many of them do. Hover a tag to see which photos — click it to keep them highlighted.</p>
    <div id="pinbar"></div>
    ${aiTotal ? `<button id="okAll" class="primary small">✓ Claude's tags look right (${fmtN(aiTotal)})</button>` : ''}
    ${group('content', 'Content', d.no_content)}
    ${group('location', 'Location', d.no_location)}
    <h4>Add to all</h4>
    <input id="sideAdd" class="tagfilter" style="width:100%" placeholder="Type a tag…" data-value="" data-label="">
    <p class="small muted legend">✦ Claude · ✦· partly Claude · 📍 geotag · ✓ you (or confirmed) · no mark = Flickr-tag rule / mixed</p>`;
  const hl = (ids0) => {
    const on = ids0 ? new Set(ids0) : null;
    document.querySelectorAll('#grid .tile.sel').forEach(el => {
      el.classList.toggle('hlon', !!on && on.has(el.dataset.id));
      el.classList.toggle('hloff', !!on && !on.has(el.dataset.id));
    });
  };
  const pinned = () => byId.get(sidePin) || null;
  const rest = () => hl(pinned()?.photos || null);
  const drawPin = () => {
    const t = pinned();
    if (!t) { sidePin = null; $('#pinbar').innerHTML = ''; return; }
    const on = new Set(t.photos || []), shown = [...document.querySelectorAll('#grid .tile.sel')].filter(el => on.has(el.dataset.id)).length;
    $('#pinbar').innerHTML = `<div class="pinbar"><div><b>${esc(t.label)}</b> on ${fmtN(t.n)} of ${fmtN(N)} selected
        ${t.photos && shown < t.n ? `<span class="small muted">(${fmtN(t.n - shown)} not loaded in the grid — scroll down)</span>` : ''}</div>
      <div class="row">${t.photos ? `<button class="mini" data-only>Select only these ${fmtN(t.n)}</button>${t.n < N ? `<button class="mini" data-others>Select the other ${fmtN(N - t.n)}</button>` : ''}` : ''}
        <span class="spacer"></span><button class="mini" data-unpin title="Stop highlighting">×</button></div></div>`;
  };
  box.querySelectorAll('.stc').forEach(el => {
    el.onmouseenter = () => { const t = byId.get(+el.dataset.tag); if (t.photos) hl(t.photos); };
    el.onmouseleave = rest;
  });
  drawPin(); rest();
  const bulk = async (body, msg) => { await api('/photos/bulk', { method: 'POST', body: { ids, ...body } }); toast(msg); drawSideTags(); };
  box.onclick = run(async e => {
    const b = e.target.closest('button');
    const chipEl = !b && e.target.closest('.stc');
    if (chipEl) { // click a tag: keep its photos highlighted and jump to the first one
      const id = +chipEl.dataset.tag;
      sidePin = sidePin === id ? null : id;
      box.querySelectorAll('.stc').forEach(x => x.classList.toggle('pin', +x.dataset.tag === sidePin));
      drawPin(); rest();
      if (sidePin) document.querySelector('#grid .tile.hlon')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!b) return;
    if (b.hasAttribute('data-unpin')) { sidePin = null; drawPin(); rest(); box.querySelectorAll('.stc.pin').forEach(x => x.classList.remove('pin')); return; }
    if (b.hasAttribute('data-only') || b.hasAttribute('data-others')) {
      const on = new Set(pinned().photos);
      state.selected = new Set(b.hasAttribute('data-only') ? [...on] : ids.filter(id => !on.has(id)));
      if (b.hasAttribute('data-others')) sidePin = null;
      state.last = -1; paintSel(); return;
    }
    if (b.id === 'sideClose') { sideOpen = false; sidePin = null; hl(null); return drawSideTags(); }
    if (b.dataset.addall) return bulk({ addTags: [b.dataset.addall] }, `Added to all ${fmtN(N)}`);
    if (b.dataset.rm) {
      if (N > 20 && !confirm(`Remove “${b.dataset.rm}” from ${fmtN(N)} photos?`)) return;
      return bulk({ removeTags: [b.dataset.rm] }, `Removed from ${fmtN(N)}`);
    }
    if (b.dataset.ok || b.id === 'okAll') {
      const r = await api('/tags/confirm', { method: 'POST', body: { ids, slugs: b.dataset.ok ? [b.dataset.ok] : [] } });
      toast(`Confirmed ${fmtN(r.confirmed)} tag(s)`); drawSideTags();
    }
  });
  tagSearch($('#sideAdd'), { tags: siteTagsCache || [], onPick: slug => bulk({ addTags: [slug] }, `Added to all ${fmtN(N)}`).catch(e => toast(e.message, true)) });
}

function paintSel() {
  document.querySelectorAll('#grid .tile').forEach(t => t.classList.toggle('sel', state.selected.has(t.dataset.id)));
  sideTags();
  const bar = $('#selbar');
  if (!bar) return;
  const n = state.selected.size;
  bar.hidden = !n;
  if (!n) return;
  const local = (albumsCache || []).filter(a => a.source === 'local');
  const cur = state.params.get('album');
  const inLocal = cur && cur.startsWith('l:');
  bar.innerHTML = `<strong>${fmtN(n)} selected</strong>
    <select id="target"><option value="">Add to site album…</option>${local.map(a => `<option value="${esc(a.id)}">${esc(a.title)}</option>`).join('')}<option value="__new__">+ New album…</option></select>
    <button id="addTo" class="primary">Add</button>
    ${inLocal ? '<button id="removeFrom">Remove from this album</button>' : ''}
    <input id="tagPick" class="tagfilter" placeholder="Tag… (type to search)" data-value="" data-label="">
    <button id="tagAdd">Add tag</button><button id="tagRm">Remove tag</button>
    <span class="rate" title="Rate the selected photos (or press 1–5, 0 to clear)">${[1, 2, 3, 4, 5].map(k => `<button class="star" data-rate="${k}" title="${k} star${k > 1 ? 's' : ''}">★</button>`).join('')}<button class="mini" data-rate="0" title="Clear rating">✕</button></span>
    <button id="hide">Hide from site</button><button id="unhide">Unhide</button>
    <button id="reproc" title="Download and resize again with the current settings">Re-process</button>
    <button id="toReel" title="Add as photo slides between the videos on the Aerial page">Add to Aerial reel</button>
    <button id="toFetcher" title="Queue for the TSP Uploader app's Photos tab (downloads + resizes on your Mac)">Send to Mac fetcher</button>
    <button id="clear">Clear</button>`;
  const ids = () => [...state.selected];
  $('#addTo').onclick = run(async () => {
    let target = $('#target').value;
    if (!target) return toast('Pick an album', true);
    if (target === '__new__') {
      const title = prompt('New album title');
      if (!title) return;
      target = (await api('/albums', { method: 'POST', body: { title } })).id;
    }
    const r = await api(`/albums/${encodeURIComponent(target)}/photos`, { method: 'POST', body: { ids: ids(), action: 'add' } });
    await albums(true);
    toast(`Album now has ${fmtN(r.count)} photos`);
    paintSel();
  });
  if ($('#removeFrom')) $('#removeFrom').onclick = run(async () => {
    await api(`/albums/${encodeURIComponent(cur)}/photos`, { method: 'POST', body: { ids: ids(), action: 'remove' } });
    toast('Removed'); organizer(state.params);
  });
  bar.querySelectorAll('[data-rate]').forEach(b => b.onclick = run(() => rateSelected(+b.dataset.rate)));
  $('#hide').onclick = run(async () => { await api('/photos/bulk', { method: 'POST', body: { ids: ids(), hidden: true } }); toast('Hidden from site'); organizer(state.params); });
  $('#unhide').onclick = run(async () => { await api('/photos/bulk', { method: 'POST', body: { ids: ids(), hidden: false } }); toast('Visible on site'); organizer(state.params); });
  $('#reproc').onclick = run(async () => {
    if (!confirm(`Re-process ${fmtN(n)} photo(s)? They're downloaded from Flickr again and resized with the current settings (panoramas get their larger size). Uses ~3 Flickr API calls and 2 image transformations each.`)) return;
    const r = await api('/photos/bulk', { method: 'POST', body: { ids: ids(), reprocess: true } });
    toast(`Queued ${fmtN(r.queued)} — watch the Dashboard`); organizer(state.params);
  });
  const tagBulk = remove => run(async () => {
    const slug = $('#tagPick').dataset.value; if (!slug) return toast('Pick a tag first', true);
    await api('/photos/bulk', { method: 'POST', body: { ids: ids(), [remove ? 'removeTags' : 'addTags']: [slug] } });
    toast(`${remove ? 'Removed' : 'Added'} “${slug}” ${remove ? 'from' : 'to'} ${fmtN(n)} photo(s)`);
  });
  tagSearch($('#tagPick'), { tags: siteTagsCache || [], onPick: (v, label) => { const t = $('#tagPick'); t.dataset.value = v; t.dataset.label = label; t.value = label; } });
  $('#tagAdd').onclick = tagBulk(false);
  $('#tagRm').onclick = tagBulk(true);
  $('#toReel').onclick = run(async () => {
    const r = await api('/media/photos', { method: 'POST', body: { ids: ids() } });
    toast(`Added ${r.added} photo slide(s) to the Aerial reel`);
  });
  $('#toFetcher').onclick = run(async () => {
    const r = await api('/photos/bulk', { method: 'POST', body: { ids: ids(), fetch: true } });
    toast(`${fmtN(r.queued)} queued — open TSP Uploader → Photos → Start`); organizer(state.params);
  });
  $('#clear').onclick = () => { state.selected.clear(); state.last = -1; paintSel(); };
}

// ---------------- photo drawer ----------------
const fmtK = px => (px % 1000 === 0 || px === 3840 || px === 2048 ? { 3840: '4K', 2048: '2K' }[px] || `${px / 1000}K` : `${px}`);
// per-account image sizes / quality, with a live storage estimate
async function accountSizes(a, after) {
  drawer.innerHTML = `
    <div class="row"><h2 style="margin:0">Sizes — ${esc(a.realname || a.username)}</h2><span class="spacer"></span><button id="dclose">Close</button></div>
    <p class="small muted">How big this account's photos are stored, and at what JPEG quality. Leave a box empty to use Settings.
      Panoramas keep their own sizing. Changing a size re-sizes existing photos automatically (bigger ones via the Mac app, smaller ones on the site);
      a quality change applies to photos stored from now on.</p>
    <form id="asz" class="form">
      <label>Showcase photos — long edge (px)</label><input name="long_edge" type="number" min="800" max="8000" step="10" value="${a.long_edge || ''}">
      <label>All other photos — long edge (px)</label><input name="base_edge" type="number" min="800" max="8000" step="10" value="${a.base_edge || ''}">
      <label>JPEG quality</label><input name="quality" type="number" min="30" max="100" value="${a.quality || ''}">
      <span></span><div class="row small"><button type="button" class="linkbtn" data-preset="3840,3840,75">Fine art: 4K · 75</button>
        <button type="button" class="linkbtn" data-preset="3000,3000,65">Commercial: 3K · 65</button>
        <button type="button" class="linkbtn" data-preset="3840,2048,75">4K showcase, 2K rest · 75</button>
        <button type="button" class="linkbtn" data-preset=",,">Use Settings</button></div>
      <span></span><div id="aszEst" class="callout small">Estimating…</div>
      <span></span><div><button class="primary">Save</button></div>
    </form>`;
  drawer.hidden = false;
  $('#dclose').onclick = closeDrawer;
  const f = $('#asz');
  let t, seq = 0;
  const est = async () => {
    const my = ++seq, q = new URLSearchParams({ long: f.long_edge.value, base: f.base_edge.value, q: f.quality.value });
    const d = await api(`/accounts/${a.id}/sizes?${q}`);
    if (my !== seq) return;
    $('#aszEst').innerHTML = `<b>${d.want.long} / ${d.want.base} px, quality ${d.want.quality}</b> (empty boxes use Settings: ${d.global.long_edge} / ${d.global.base_edge} px, q${d.global.quality})<br>
      This account: about <b>${fmtBytes(d.estimate.bytes)}</b> for ${fmtN(d.estimate.photos)} photos (now ${fmtBytes(d.estimate.now)}).<br>
      All of R2 would be roughly <b>${fmtBytes(d.storage.used - d.estimate.now + d.estimate.bytes)}</b> of your ${fmtBytes(d.storage.budget)} budget
      ${d.storage.used - d.estimate.now + d.estimate.bytes > d.storage.budget ? '<span class="err">— over budget: downloads would stop there</span>' : ''}.
      <div class="muted">A rough estimate from what this account's stored photos weigh today; photos not downloaded yet are counted at the new size.</div>`;
  };
  f.oninput = () => { clearTimeout(t); t = setTimeout(run(est), 300); };
  f.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { const [l, ba, q] = b.dataset.preset.split(','); f.long_edge.value = l; f.base_edge.value = ba; f.quality.value = q; f.oninput(); });
  f.onsubmit = run(async e => {
    e.preventDefault();
    const r = await api(`/accounts/${a.id}/sizes`, { method: 'POST', body: { long_edge: f.long_edge.value || null, base_edge: f.base_edge.value || null, quality: f.quality.value || null } });
    toast(`Saved${r.queued ? ` — ${fmtN(r.queued)} photo(s) queued for the Mac app to re-size bigger` : ''}`);
    closeDrawer(); after?.();
  });
  run(est)();
}

function closeDrawer() { drawer.hidden = true; drawer.innerHTML = ''; }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

const openPhoto = run(async id => {
  const p = await api('/photos/' + id);
  const loc = p.location || {};
  const ex = p.exif?.items || [];
  const pick = (...labels) => { for (const l of labels) { const x = ex.find(e => e.label === l || e.tag === l); if (x) return x.clean || x.raw; } return null; };
  const camera = [pick('Make'), pick('Model')].filter(Boolean).join(' ') || p.exif?.camera;
  const lens = pick('Lens Model', 'Lens', 'LensModel');
  const shot = [pick('Exposure'), pick('Aperture') && 'f/' + pick('Aperture'), pick('ISO Speed', 'ISO') && 'ISO ' + pick('ISO Speed', 'ISO'), pick('Focal Length')].filter(Boolean).join(' · ');
  const vis = p.is_public ? 'Public' : [p.is_friend && 'Friends', p.is_family && 'Family'].filter(Boolean).join(' + ') || 'Private';
  const place = [loc.neighbourhood, loc.locality, loc.region, loc.country].filter(Boolean).join(', ');
  const stored = p.status === 'ok' || p.status === 'meta';
  drawer.innerHTML = `
    <div class="row"><strong>Photo ${esc(p.id)}</strong><span class="spacer"></span><button id="dclose">Close</button></div>
    <p><img class="preview" src="${stored ? `/api/admin/img/${p.id}/m` : flickrThumb(p, 'z')}" alt=""></p>
    <h3>${esc(p.title) || '<span class="muted">(untitled)</span>'}</h3>
    ${p.description ? `<div class="small" style="white-space:pre-wrap">${esc(p.description)}</div>` : ''}
    <dl>
      <dt>Status</dt><dd><span class="pill ${p.status === 'ok' ? 'ok' : p.status === 'error' || p.status === 'deleted' ? 'bad' : 'warn'}">${esc(p.status)}</span>
        ${p.hidden ? '<span class="pill">hidden from site</span>' : ''}${p.error ? `<div class="small err">${esc(p.error)}</div>` : ''}</dd>
      <dt>Flickr</dt><dd><a href="${esc(p.page_url)}" target="_blank" rel="noopener">open on Flickr ↗</a> · ${vis}</dd>
      <dt>Taken</dt><dd>${esc(p.date_taken) || '—'}</dd>
      <dt>Your rating</dt><dd class="rate1">${[1, 2, 3, 4, 5].map(k => `<button class="star${k <= (p.rating || 0) ? ' on' : ''}" data-r1="${k}" title="${k} star${k > 1 ? 's' : ''}">★</button>`).join('')}${p.rating ? '<button class="mini" data-r1="0" title="Clear">✕</button>' : ''}</dd>
      <dt>Uploaded</dt><dd>${date(p.date_upload)}</dd>
      <dt>Original</dt><dd>${p.o_width ? `${p.o_width} × ${p.o_height}` : '—'} ${esc(p.original_format || '')}</dd>
      <dt>Stored</dt><dd>${p.width ? `${p.width} × ${p.height} · ${fmtBytes(p.bytes)} <span class="muted">(from “${esc(p.source_size)}”)</span> · thumb ${p.thumb_w}×${p.thumb_h} ${fmtBytes(p.thumb_bytes)}` : 'not yet'}</dd>
      <dt>Camera</dt><dd>${esc(camera) || '—'}${lens ? `<div class="small">${esc(lens)}</div>` : ''}${shot ? `<div class="small muted">${esc(shot)}</div>` : ''}</dd>
      <dt>Location</dt><dd>${place ? esc(place) : '—'}${p.latitude != null ? `<div class="small"><a target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${p.latitude}&mlon=${p.longitude}#map=13/${p.latitude}/${p.longitude}">${p.latitude}, ${p.longitude}</a></div>` : ''}</dd>
      <dt>Site tags</dt><dd id="stagBox">${(p.siteTags || []).map(t => `<span class="pill stag ${t.kind}" title="${t.kind} · ${t.source === 'ai' ? 'tagged by Claude' : t.source === 'manual' ? 'added by you' : t.source === 'geo' ? 'from the geotag' : 'from Flickr tags'}">${esc(t.label)}${t.source === 'ai' ? ' ✦' : ''} <button class="x" data-rmtag="${esc(t.slug)}" title="Remove">×</button></span>`).join(' ') || '<span class="muted">none</span>'}
        <input id="stagAdd" class="tagfilter small" placeholder="+ add a tag…" data-value="" data-label=""></dd>
      <dt>Flickr tags</dt><dd>${(p.raw_tags || []).map(t => `<span class="pill">${esc(t)}</span>`).join(' ') || esc(p.tags) || '—'}</dd>
      ${p.getty?.length ? `<dt>Getty</dt><dd>${p.getty.map(g => `<a href="${esc(g.page_url || 'https://www.gettyimages.com/detail/' + g.asset_id)}" target="_blank" rel="noopener">${esc(g.asset_id)}</a> <span class="small muted">${esc(g.artist || '')} · ${esc(g.collection || '')}${g.in_portfolio === 0 ? ' · no longer in portfolio' : ''} · ${g.sales ? `${fmtN(g.sales)} sale${g.sales === 1 ? '' : 's'}, ${usd(g.royalty)}` : 'no sales yet'}${g.how === 'matcher' ? ' · matched by pixels' : g.how === 'filename' ? ' · by file name' : ''}</span>`).join('<br>')}</dd>` : ''}
      ${p.instagram?.length ? `<dt>Instagram</dt><dd>${p.instagram.map(g => `<a href="${esc(g.permalink)}" target="_blank" rel="noopener">${g.ts ? new Date(g.ts * 1000).toLocaleDateString() : 'post'}</a> <span class="small muted">♥ ${fmtN(g.like_count)} · 💬 ${fmtN(g.comments_count)}${g.status === 'auto' ? ' · auto-matched' : ''}</span>`).join('<br>')}</dd>` : ''}
      <dt>Albums</dt><dd>${(p.albums || []).map(a => `<a href="#organizer?album=${encodeURIComponent(a.id)}">${esc(a.title)}</a>${a.source === 'local' ? ' <span class="pill">site</span>' : ''}`).join(', ') || '—'}</dd>
      <dt>License</dt><dd>${esc(p.license)}</dd>
      <dt>On Flickr</dt><dd>👁 ${fmtN(p.views)} views · ♥ ${p.faves == null ? '—' : fmtN(p.faves)} faves · 💬 ${p.comments == null ? '—' : fmtN(p.comments)} comments
        <div class="small muted">counts updated ${ago(p.metrics_at)}</div></dd>
      <dt>Collections</dt><dd>${(p.collections || []).map(c => `<a href="#organizer?collection=${encodeURIComponent(c.id)}">${esc(c.title)}</a>`).join(', ') || '—'}</dd>
      <dt>Synced</dt><dd>${date(p.synced_at)}</dd>
    </dl>
    ${ex.length ? `<details><summary>All EXIF (${ex.length})</summary><table>${ex.map(e => `<tr><td class="small muted">${esc(e.label)}</td><td class="small">${esc(e.clean || e.raw)}</td></tr>`).join('')}</table></details>` : ''}`;
  drawer.hidden = false;
  $('#dclose').onclick = closeDrawer;
  if (!siteTagsCache) siteTagsCache = (await api('/tags').catch(() => ({ tags: [] }))).tags;
  drawer.querySelectorAll('[data-r1]').forEach(b => b.onclick = run(async () => {
    const v = +b.dataset.r1 === (p.rating || 0) ? 0 : +b.dataset.r1; // clicking the current rating clears it
    await api('/photos/bulk', { method: 'POST', body: { ids: [p.id], rating: v } });
    const it = state.items.find(x => x.id === p.id); if (it) it.rating = v;
    const tile = document.querySelector(`#grid .tile[data-id="${p.id}"]`);
    if (tile) { tile.querySelector('.stars')?.remove(); if (v) tile.querySelector('.info').insertAdjacentHTML('afterend', `<span class="stars r${v}">${'★'.repeat(v)}</span>`); }
    openPhoto(p.id);
  }));
  drawer.querySelectorAll('[data-rmtag]').forEach(b => b.onclick = run(async () => {
    await api('/photos/bulk', { method: 'POST', body: { ids: [p.id], removeTags: [b.dataset.rmtag] } }); openPhoto(p.id);
  }));
  tagSearch($('#stagAdd'), { tags: siteTagsCache || [], onPick: run(async slug => {
    await api('/photos/bulk', { method: 'POST', body: { ids: [p.id], addTags: [slug] } }); openPhoto(p.id);
  }) });
});

// ---------------- album builder ----------------
async function builderView(params) {
  let d, sel = +params.get('f') || 0, draft = null, pv = 0;
  const RANK = [['flickr', 'Flickr popularity'], ['getty', 'Getty licenses sold'], ['getty_earn', 'Getty earnings'], ['newest', 'Newest'], ['random', 'Random (new pick daily)']];
  const SHAPE = [['', 'any shape'], ['pano', 'panoramas'], ['horizontal', 'horizontal'], ['vertical', 'vertical'], ['square', 'square']];
  const BY = [['', 'None'], ['city', 'One per city'], ['state', 'One per state / region'], ['country', 'One per country']];
  const opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(cur ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const label = s => d.tags.find(t => t.slug === s)?.label || s;
  const kidsOf = id => d.folders.filter(f => (f.parent_id || 0) === (id || 0)).sort((a, b) => a.position - b.position || a.id - b.id);
  const ruleText = r => `${r.rank === 'random' ? `Random ${r.top}` : `Top ${r.top} ${{ getty: 'Getty licenses', getty_earn: 'Getty $', newest: 'newest' }[r.rank] || ''}`} · ${r.shape ? { pano: 'panoramas', horizontal: 'horizontal', vertical: 'vertical', square: 'square' }[r.shape] + (r.tags.length ? ' · ' : '') : ''}${r.tags.length ? r.tags.map(label).join(r.match === 'any' ? ' or ' : ' + ') : r.shape ? '' : 'all photos'}${r.exclude.length ? ' − ' + r.exclude.map(label).join(', ') : ''}${(r.accounts || []).length ? ' · only ' + r.accounts.map(id => d.accounts?.find(a => a.id === id)?.username || id).join(', ') : ''}${r.reject ? ` · no ${'★'.repeat(r.reject)}${r.reject > 1 ? ' or less' : ''}` : ''}`;
  const summary = f => (f.display === 'random' ? '🔀 ' : '') + summaryRules(f);
  const summaryRules = f => f.rules.length ? f.rules.map(ruleText).join(' ∪ ') : f.common ? `auto: ${ruleText(f.common)}` : 'empty';
  const titlePath = f => { const p = []; for (let x = f, n = 0; x && n < 12; x = d.folders.find(y => y.id === x.parent_id), n++) p.unshift(x.title); return p.join(' › '); };
  const pathOf = f => { const p = []; for (let x = f, n = 0; x && n < 12; x = d.folders.find(y => y.id === x.parent_id), n++) p.unshift(x.slug); return p.join('/'); };

  const load = async () => { d = await api('/folders'); };
  const tree = (pid = 0, depth = 0) => kidsOf(pid).map(f => `
    <div class="fbrow${f.id === sel ? ' on' : ''}${f.hidden ? ' hid' : ''}" data-sel="${f.id}" style="--d:${depth}">
      <span class="fbname">${kidsOf(f.id).length || f.auto ? '▾ ' : ''}${esc(f.title)}${f.auto ? ' <span class="pill">📍 auto</span>' : ''}${f.hidden ? ' <span class="pill">hidden</span>' : ''}</span>
      <span class="fbmeta small muted">${esc(summary(f))}</span>
      <span class="fbmv"><button class="mini" data-mv="${f.id}" data-dir="-1" title="Move up">↑</button><button class="mini" data-mv="${f.id}" data-dir="1" title="Move down">↓</button></span>
    </div>${tree(f.id, depth + 1)}`).join('');

  const tagSel = (cls, i) => `<input class="addtag ${cls}" data-i="${i}" placeholder="${cls === 't-exc' ? '+ exclude a tag…' : '+ type to add a tag…'}" autocomplete="off" spellcheck="false">`;
  const chips = (list, i, key) => list.map(s => `<span class="pill stag chip">${esc(label(s))}<button class="x" data-rm="${key}" data-i="${i}" data-s="${esc(s)}" title="Remove">×</button></span>`).join('');
  const ruleRow = (r, i) => `
    <div class="rule" data-i="${i}">
      <div class="row">
        <span>Top</span><input type="number" min="1" max="500" class="r-top" value="${r.top}" style="width:76px">
        <span>by</span><select class="r-rank">${opt(RANK, r.rank)}</select>
        <span>shape</span><select class="r-shape">${opt(SHAPE, r.shape || '')}</select>
        <span>from photos tagged</span><select class="r-match">${opt([['all', 'all of'], ['any', 'any of']], r.match)}</select>
        <span class="spacer"></span><button class="mini danger" data-delrule="${i}" title="Remove rule">✕</button>
      </div>
      <div class="row small">
        <span>Flickr accounts</span>${(d.accounts || []).map(a => `<label class="chk"><input type="checkbox" class="r-acc" value="${a.id}"${!(r.accounts || []).length || r.accounts.includes(a.id) ? ' checked' : ''}> ${esc(a.username || 'Account ' + a.id)}</label>`).join('')}
        <span style="margin-left:14px">leave out photos rated</span><select class="r-reject">${opt([[0, 'nothing — keep all'], [1, '★ (rejects)'], [2, '★★ or less'], [3, '★★★ or less'], [4, '★★★★ or less']], r.reject || 0)}</select>
        <span class="muted">(unrated photos always count)</span>
      </div>
      <div class="row chips">${chips(r.tags, i, 'tags') || `<span class="small muted">no tags needed (every photo${r.shape ? ' of that shape' : ''})</span>`} ${tagSel('t-inc', i)}</div>
      <div class="row chips"><span class="small muted">but not</span> ${chips(r.exclude, i, 'exclude')} ${tagSel('t-exc', i)}</div>
    </div>`;

  const editor = () => {
    if (!draft) return `<div class="callout">Pick a folder on the left, or create one. <br><span class="small muted">
      Example: Landscape › City › one sub-folder per city. Each folder shows the top photos of the tags you pick — by Flickr popularity or Getty licenses.</span></div>`;
    const f = d.folders.find(x => x.id === draft.id);
    const desc = new Set(); const walk = id => kidsOf(id).forEach(k => { desc.add(k.id); walk(k.id); }); walk(draft.id);
    const parents = [['', '(top level)'], ...d.folders.filter(x => x.id !== draft.id && !desc.has(x.id)).map(x => [x.id, titlePath(x)])];
    const common = !draft.rules.length && f?.common;
    return `
      <div class="row"><h2 style="margin:0">${esc(draft.title || 'Folder')}</h2><span class="spacer"></span>
        <a class="small" href="/photos/${esc(pathOf(f))}" target="_blank" rel="noopener">View on site ↗</a></div>
      <div class="fbform">
        <label>Name <input id="fTitle" value="${esc(draft.title)}"></label>
        <label>URL name <input id="fSlug" value="${esc(draft.slug)}"></label>
        <label>Inside <select id="fParent">${opt(parents, draft.parent_id || '')}</select></label>
      </div>
      <label class="chk"><input type="checkbox" id="fWithin"${draft.within_parent ? ' checked' : ''}> Only photos that also belong in the parent folder</label>

      <h3>Photos</h3>
      ${common ? `<div class="callout small">No rules yet, so it shows <b>${esc(ruleText(common))}</b> — the tag its sub-folders share.
        <button class="mini" id="useCommon">Customize</button></div>` : ''}
      <div id="rules">${draft.rules.map(ruleRow).join('')}</div>
      <button id="addRule">+ Add photos (top N from tags)</button>
      <p class="small muted">Rules add up: “Top 20 from City + New York City” plus “Top 10 from Night” shows both sets (no repeats).
        Getty rankings only include photos linked to a Getty asset (${fmtN(d.gettyLinked)} are).</p>

      <h3>Sub-folders</h3>
      <div class="row">${kidsOf(draft.id).map(k => `<a href="#builder?f=${k.id}" class="pill">${esc(k.title)}</a>`).join(' ') || '<span class="small muted">none yet</span>'}
        <button id="addKid">+ Add sub-folder</button></div>
      <div class="row" style="margin-top:10px">
        <span>Automatic sub-folders:</span><select id="aBy">${opt(BY, draft.auto?.by || '')}</select>
        <span class="aopt"${draft.auto ? '' : ' hidden'}>each with top <input type="number" id="aTop" min="1" max="500" value="${draft.auto?.top || 20}" style="width:70px">
          by <select id="aRank">${opt(RANK, draft.auto?.rank || 'flickr')}</select>,
          skip places with fewer than <input type="number" id="aMin" min="1" value="${draft.auto?.min || 3}" style="width:60px"> photos</span>
      </div>
      <h3>On the site</h3>
      <div class="row"><span>Show the photos</span><select id="fDisplay">${opt([['popular', 'most popular first'], ['random', 'shuffled — a different order for each visitor']], draft.display || 'popular')}</select></div>
      <p class="small muted">Shuffled keeps the same photos but every visitor (each browser session) sees them in its own order, so the site never looks the same twice. Place sub-folders follow this setting too.</p>
      <label class="chk"><input type="checkbox" id="fHidden"${draft.hidden ? ' checked' : ''}> Hidden from the site</label>
      <div class="row" style="margin-top:14px"><button class="primary" id="save">Save</button><span id="dirty" class="small muted"></span>
        <span class="spacer"></span><button class="danger" id="del">Delete folder</button></div>

      <h3>Preview <span id="pvInfo" class="small muted"></span></h3>
      <div id="pvPlaces" class="row"></div>
      <div id="pv" class="grid fbgrid"></div>`;
  };

  const preview = async () => {
    if (!draft) return;
    const my = ++pv;
    $('#pvInfo').textContent = 'loading…';
    const r = await api('/folders/preview', { method: 'POST', body: draft });
    if (my !== pv) return;
    $('#pvInfo').textContent = `${fmtN(r.photos.length)} shown · ${fmtN(r.fits)} photos fit this folder`;
    $('#pvPlaces').innerHTML = r.places.length ? `<span class="small muted">Place sub-folders:</span> ` + r.places.map(p => `<span class="pill">${esc(p.title)} <span class="muted">${p.n}</span></span>`).join(' ') : '';
    $('#pv').innerHTML = r.photos.map((p, i) => `<div class="tile" title="${esc(p.title)}"><img loading="lazy" src="/api/admin/img/${p.id}/t?v=${p.v || 0}" alt="">
      <div class="badges"><span class="b">#${i + 1}</span>${p.getty ? `<span class="b" title="Getty licenses sold · royalties">${p.getty} lic · $${fmtN(p.earned)}</span>` : ''}</div></div>`).join('');
  };
  let pt;
  const changed = () => { $('#dirty').textContent = 'unsaved changes'; clearTimeout(pt); pt = setTimeout(run(preview), 350); };

  const read = () => {
    draft.title = $('#fTitle').value; draft.slug = $('#fSlug').value;
    draft.parent_id = $('#fParent').value ? +$('#fParent').value : null;
    draft.within_parent = $('#fWithin').checked; draft.hidden = $('#fHidden').checked; draft.display = $('#fDisplay').value;
    view.querySelectorAll('.rule').forEach(el => {
      const r = draft.rules[+el.dataset.i];
      r.top = +el.querySelector('.r-top').value || 20; r.rank = el.querySelector('.r-rank').value; r.match = el.querySelector('.r-match').value; r.shape = el.querySelector('.r-shape').value;
      const accs = [...el.querySelectorAll('.r-acc')], on = accs.filter(c => c.checked).map(c => +c.value);
      r.accounts = on.length === accs.length ? [] : on; r.reject = +el.querySelector('.r-reject').value || 0;
    });
    const by = $('#aBy').value;
    draft.auto = by ? { by, top: +$('#aTop').value || 20, rank: $('#aRank').value, min: +$('#aMin').value || 3 } : null;
  };
  const redrawEditor = () => { $('#fbed').innerHTML = editor(); bindEditor(); };

  const bindEditor = () => {
    if (!draft) return;
    // tag picker: type to search all tags (name, URL name, parents), arrows + Enter or click to add
    const sug = $('#tagSug') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'tagSug', className: 'tagsug', hidden: true }));
    const nrm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, '');
    const tagPath = t => { const p = []; for (let x = d.tags.find(y => y.id === t.parent_id), n = 0; x && n < 8; x = d.tags.find(y => y.id === x.parent_id), n++) p.unshift(x.label); return p.join(' › '); };
    let sugFor = null, sugList = [], sugI = 0;
    const hideSug = () => { sug.hidden = true; sugFor = null; };
    const drawSug = () => {
      sug.innerHTML = sugList.length ? sugList.map((t, i) => `<div class="ts-i${i === sugI ? ' on' : ''}" data-slug="${esc(t.slug)}">
          <span class="ts-l">${t.kind === 'location' ? '📍 ' : ''}${esc(t.label)}</span><span class="ts-n">${fmtN(t.n)}</span>
          <span class="ts-p">${esc(tagPath(t) || (t.kind === 'location' ? 'place' : 'top level'))}</span></div>`).join('')
        : '<div class="ts-none">No tag matches</div>';
      sug.querySelector('.ts-i.on')?.scrollIntoView({ block: 'nearest' });
    };
    const showSug = inp => {
      const q = nrm(inp.value).trim(), qc = q.replace(/ /g, '');
      const r = draft.rules[+inp.dataset.i], have = new Set([...r.tags, ...r.exclude]);
      sugList = d.tags.filter(t => !have.has(t.slug)).map(t => {
        const l = nrm(t.label), lc = l.replace(/ /g, '');
        const s = !q ? 3 : lc.startsWith(qc) || t.slug.startsWith(qc) ? 0 : l.split(' ').some(w => w.startsWith(q)) ? 1 : lc.includes(qc) || t.slug.includes(qc) ? 2 : nrm(tagPath(t)).includes(q) ? 4 : -1;
        return { t, s };
      }).filter(x => x.s >= 0).sort((a, b) => a.s - b.s || b.t.n - a.t.n || a.t.label.localeCompare(b.t.label)).slice(0, 14).map(x => x.t);
      sugI = 0; sugFor = inp;
      const rc = inp.getBoundingClientRect();
      Object.assign(sug.style, { left: rc.left + 'px', top: rc.bottom + 4 + 'px', bottom: 'auto', minWidth: Math.max(rc.width, 280) + 'px' });
      sug.hidden = false; drawSug();
    };
    const pick = slug => {
      if (!sugFor || !slug) return;
      const i = sugFor.dataset.i, exc = sugFor.classList.contains('t-exc');
      read();
      const r = draft.rules[+i], key = exc ? 'exclude' : 'tags';
      if (!r[key].includes(slug)) r[key].push(slug);
      hideSug(); redrawEditor(); changed();
      view.querySelector(`.addtag.${exc ? 't-exc' : 't-inc'}[data-i="${i}"]`)?.focus();
    };
    sug.onmousedown = e => { const it = e.target.closest('.ts-i'); if (it) { e.preventDefault(); pick(it.dataset.slug); } };
    const fb = $('#fbed');
    // listeners are added once per editor element; they always call this (latest) render's handlers
    fb._h = {
      focusin: e => { if (e.target.classList.contains('addtag')) showSug(e.target); },
      focusout: e => { if (e.target.classList.contains('addtag')) setTimeout(() => { if (document.activeElement !== sugFor) hideSug(); }, 120); },
      keydown: e => {
        if (!e.target.classList.contains('addtag') || sug.hidden) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sugI = (sugI + (e.key === 'ArrowDown' ? 1 : -1) + sugList.length) % Math.max(1, sugList.length); drawSug(); }
        else if (e.key === 'Enter') { e.preventDefault(); pick(sugList[sugI]?.slug); }
        else if (e.key === 'Escape') { hideSug(); e.target.blur(); }
      },
    };
    if (!fb._tp) { fb._tp = 1; for (const ev of ['focusin', 'focusout', 'keydown']) fb.addEventListener(ev, e => fb._h[ev](e)); }
    $('#fbed').oninput = $('#fbed').onchange = e => {
      if (e.target.classList.contains('addtag')) { if (e.type === 'input') showSug(e.target); return; }
      if (e.target.id === 'aBy') view.querySelector('.aopt').hidden = !e.target.value;
      if (e.target.classList.contains('r-shape') && e.type === 'change') { read(); redrawEditor(); changed(); return; }
      if ((e.target.classList.contains('r-acc') || e.target.classList.contains('r-reject')) && e.type === 'change') { read(); changed(); return; }
      read(); changed();
    };
    $('#fbed').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.rm) { read(); const r = draft.rules[+b.dataset.i]; r[b.dataset.rm] = r[b.dataset.rm].filter(s => s !== b.dataset.s); redrawEditor(); changed(); }
      if (b.dataset.delrule) { read(); draft.rules.splice(+b.dataset.delrule, 1); redrawEditor(); changed(); }
    };
    $('#addRule').onclick = () => { read(); const prev = draft.rules.at(-1); draft.rules.push({ tags: [], match: 'all', exclude: [], top: 20, rank: 'flickr', shape: '', accounts: prev ? [...(prev.accounts || [])] : [], reject: prev?.reject || 0 }); redrawEditor(); changed(); };
    if ($('#useCommon')) $('#useCommon').onclick = () => { read(); const c = d.folders.find(x => x.id === draft.id).common; draft.rules.push({ ...c, common: undefined }); redrawEditor(); changed(); };
    $('#save').onclick = run(async () => {
      read();
      await api('/folders/' + draft.id, { method: 'PATCH', body: draft });
      toast('Saved'); await draw();
    });
    $('#del').onclick = run(async () => {
      if (!confirm(`Delete “${draft.title}”? Its sub-folders move up one level. Photos are not touched.`)) return;
      await api('/folders/' + draft.id, { method: 'DELETE' });
      sel = 0; location.hash = '#builder'; await draw();
    });
    $('#addKid').onclick = run(async () => {
      const title = prompt(`New sub-folder inside “${draft.title}”`); if (!title) return;
      const r = await api('/folders', { method: 'POST', body: { title, parent_id: draft.id } });
      sel = r.folder.id; history.replaceState(null, '', '#builder?f=' + sel); await draw();
    });
    run(preview)();
  };

  const draw = async () => {
    await load();
    const f = d.folders.find(x => x.id === sel);
    draft = f ? JSON.parse(JSON.stringify({ id: f.id, title: f.title, slug: f.slug, parent_id: f.parent_id, rules: f.rules, within_parent: !!f.within_parent, auto: f.auto, hidden: !!f.hidden, display: f.display || 'popular' })) : null;
    view.innerHTML = `
      <div class="fb">
        <section class="fbtree">
          <div class="row"><h2 style="margin:0">Album builder</h2><span class="spacer"></span><button class="primary" id="newTop">New folder</button></div>
          <p class="small muted">This is the menu under <b>Photos</b> on the site. Nest folders by choosing what they sit inside.</p>
          <div id="tree">${tree() || '<p class="muted">No folders yet.</p>'}</div>
        </section>
        <section id="fbed" class="fbed">${editor()}</section>
      </div>`;
    $('#newTop').onclick = run(async () => {
      const title = prompt('Folder name (e.g. Landscape)'); if (!title) return;
      const r = await api('/folders', { method: 'POST', body: { title } });
      sel = r.folder.id; history.replaceState(null, '', '#builder?f=' + sel); await draw();
    });
    $('#tree').onclick = run(async e => {
      const mv = e.target.closest('[data-mv]');
      if (mv) { await api(`/folders/${mv.dataset.mv}/move`, { method: 'POST', body: { dir: +mv.dataset.dir } }); return draw(); }
      const row = e.target.closest('[data-sel]');
      if (row) { sel = +row.dataset.sel; history.replaceState(null, '', '#builder?f=' + sel); draw(); }
    });
    bindEditor();
  };
  await run(draw)();
}

// ---------------- featured in (press / publications page) ----------------
async function featView() {
  const draw = async () => {
    const d = await api('/media/features');
    view.innerHTML = `
      <div class="row"><h2 style="margin:0">Press <span class="muted small">(the public “Press” page)</span></h2><span class="spacer"></span>
        <a class="btn" href="/featured" target="_blank" rel="noopener">View page ↗</a>
        <label class="btn primary">Upload images…<input type="file" id="fUp" accept="image/*" multiple hidden></label></div>
      <p class="muted small">Screenshots of sites, magazine and book covers where your work appears — shown on the site's <b>Featured</b> page as identical rounded tiles.
        For cropping, use <b>TSP Uploader → Featured</b> on your Mac (uploads here land as-is, scaled to 2000 px). Tall things like book covers: pick <i>Whole</i> — the cover sits in the tile on a blurred copy of itself, plain, or white.</p>
      <div class="callout small" style="margin:10px 0 16px"><b>${fmtN(d.shown)}</b> shown on the site ${d.shown < 24 ? '— around 24–28 makes a full collage' : d.shown > 28 ? '— more than the 24–28 you planned; untick some to tighten it' : '✓'}</div>
      <div id="fgrid" class="fgrid">${d.features.map((f, i) => `
        <div class="fcard${f.enabled ? '' : ' off'}" data-id="${f.id}">
          <div class="fimg fit-${esc(f.fit)}" style="--src:url('${esc(f.src)}')">${f.status === 'ready' ? `<img loading="lazy" src="${esc(f.src)}" alt="">` : '<span class="small muted">uploading…</span>'}</div>
          <input class="ft" placeholder="Title — e.g. Wall Street Journal" value="${esc(f.title)}">
          <input class="fc small" placeholder="Caption (optional)" value="${esc(f.caption || '')}">
          <input class="fu small" placeholder="Link to the article (optional)" value="${esc(f.url || '')}">
          <div class="row small">
            <label><input type="checkbox" class="fe"${f.enabled ? ' checked' : ''}> Show</label>
            <select class="ff small">${[['cover', 'Fill the tile'], ['blur', 'Whole · blurred backdrop'], ['plain', 'Whole · plain'], ['white', 'Whole · white']].map(([v, l]) => `<option value="${v}"${f.fit === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
            <span class="spacer"></span>
            <button class="mini" data-mv="-1" title="Earlier"${i ? '' : ' disabled'}>←</button><button class="mini" data-mv="1" title="Later"${i < d.features.length - 1 ? '' : ' disabled'}>→</button>
            <button class="mini danger" data-del title="Delete">✕</button>
          </div>
        </div>`).join('') || '<p class="muted">Nothing yet — add some from TSP Uploader → Featured, or Upload images.</p>'}</div>`;
    const ids = d.features.map(f => f.id);
    const save = run(async (card, body) => { await api('/media/features/' + card.dataset.id, { method: 'PATCH', body }); toast('Saved'); });
    $('#fgrid').onchange = e => {
      const card = e.target.closest('.fcard'); if (!card) return;
      if (e.target.classList.contains('ft')) save(card, { title: e.target.value });
      if (e.target.classList.contains('fc')) save(card, { caption: e.target.value });
      if (e.target.classList.contains('fu')) save(card, { url: e.target.value });
      if (e.target.classList.contains('fe')) { card.classList.toggle('off', !e.target.checked); save(card, { enabled: e.target.checked }).then(draw); }
      if (e.target.classList.contains('ff')) { const fi = card.querySelector('.fimg'); fi.className = 'fimg fit-' + e.target.value; save(card, { fit: e.target.value }); }
    };
    $('#fgrid').onclick = run(async e => {
      const b = e.target.closest('button'); if (!b) return;
      const card = b.closest('.fcard'), id = card.dataset.id;
      if (b.hasAttribute('data-del')) {
        if (!confirm('Delete this one from the Featured page?')) return;
        await api('/media/features/' + id, { method: 'DELETE' }); return draw();
      }
      if (b.dataset.mv) {
        const i = ids.indexOf(id), j = i + +b.dataset.mv;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        await api('/media/features/order', { method: 'POST', body: { ids } }); return draw();
      }
    });
    $('#fUp').onchange = run(async e => {
      const list = [...e.target.files];
      for (const [n, file] of list.entries()) {
        toast(`Uploading ${n + 1} of ${list.length}…`);
        const img = await createImageBitmap(file);
        const k = Math.min(1, 2000 / Math.max(img.width, img.height));
        const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
        const { id } = await api('/media/features', { method: 'POST', body: { title: file.name.replace(/\.[^.]+$/, ''), fit: Math.abs(c.width / c.height - 4 / 3) < 0.08 ? 'cover' : 'blur' } });
        const res = await fetch(`/api/admin/media/features/${id}/image?w=${c.width}&h=${c.height}`, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: blob });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      }
      toast(`Added ${list.length} — give them titles`); draw();
    });
  };
  await run(draw)();
}

// ---------------- instagram ----------------
async function igView(params) {
  let view0 = params.get('view') || 'review', offset = 0;
  const thumb = p => `/api/admin/img/${p.photo_id}/t?v=${p.v || 0}`;
  const igImg = id => `/api/admin/ig/img/${id}`;
  const draw = async () => {
    const st = await api('/ig/status');
    const c = st.counts;
    if (!st.connected) {
      view.innerHTML = `
        <h2>Instagram</h2>
        <div class="callout">
          <p style="margin-top:0"><b>Connect @tonyshiphoto</b> — paste an access token from Meta (one time).</p>
          <ol class="small">
            <li>@tonyshiphoto must be linked to a <b>Facebook Page</b> (Instagram app → Edit profile → Page, or Meta Business Suite).</li>
            <li>Open <a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noopener">Graph API Explorer</a>, pick your app, <i>User Token</i>, add permissions <code>instagram_basic</code>, <code>pages_show_list</code>, <code>pages_read_engagement</code>, <code>business_management</code> → <b>Generate Access Token</b> and allow the Page + Instagram account.</li>
            <li>Click the <b>ⓘ</b> next to the token → <b>Open in Access Token Tool</b> → <b>Extend Access Token</b>, and copy the long one.</li>
            <li>Paste it here. The site swaps it for the Page’s token, which doesn’t expire. (An <code>IGAA…</code> Instagram-login token or a system-user token works too.)</li>
          </ol>
          <div class="row"><input id="igTok" placeholder="EAA… or IGAA…" style="width:min(560px,100%)" autocomplete="off" spellcheck="false"><input id="igId" placeholder="Instagram account ID (optional)" style="width:230px" autocomplete="off"><button class="primary" id="igSave">Connect</button></div>
          ${st.error ? `<p class="err small">${esc(st.error)}</p>` : ''}
        </div>`;
      $('#igSave').onclick = run(async () => { const r = await api('/ig/token', { method: 'POST', body: { token: $('#igTok').value, ig_id: $('#igId').value } }); toast(`Connected @${r.username}${r.synced?.posts != null ? ` — ${fmtN(r.synced.posts)} posts` : ''}`); draw(); });
      return;
    }
    const tabs = [['review', `To review`, c.review], ['matched', 'Matched', c.auto + c.confirmed], ['unmatched', 'Not on the site', c.unmatched], ['unchecked', 'Not checked yet', c.unchecked], ['publish', '📤 Posting from Flickr', null]];
    view.innerHTML = `
      <div class="row"><h2 style="margin:0">Instagram <span class="muted">@${esc(st.username)}</span></h2><span class="spacer"></span>
        <span class="small muted">synced ${ago(st.lastSync)}</span><button id="igSync">Sync now</button><button id="igTokNew">Replace token</button></div>
      ${st.error ? `<div class="callout small err" style="margin-top:10px">${esc(st.error)}</div>` : ''}
      <div class="cards" style="margin:14px 0">
        <div class="card"><div class="k">Instagram images</div><div class="v">${fmtN(c.images)}</div><div class="small muted">${fmtN(c.posts)} posts (carousel slides count separately)</div></div>
        <div class="card"><div class="k">Linked to a site photo</div><div class="v">${fmtN(c.auto + c.confirmed)}</div><div class="small muted">${fmtN(c.confirmed)} confirmed by you · ${fmtN(st.photosLinked)} site photos</div></div>
        <div class="card"><div class="k">To review</div><div class="v ${c.review ? 'warn' : ''}">${fmtN(c.review)}</div><div class="small muted">near-duplicates / unsure</div></div>
        <div class="card"><div class="k">Not checked yet</div><div class="v">${fmtN(c.unchecked)}</div><div class="small muted">run <b>TSP Uploader → 📷 Instagram → Match</b> on the Mac Studio</div></div>
      </div>
      <div class="row">${tabs.map(([k, l, n]) => `<button class="${k === view0 ? 'primary' : ''}" data-v="${k}">${l}${n == null ? '' : ` <span class="pill">${fmtN(n)}</span>`}</button>`).join('')}</div>
      <div id="igList" class="iglist"><p class="muted">Loading…</p></div>
      <div class="row" style="margin-top:12px"><button id="igMore" hidden>More</button></div>`;
    view.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { view0 = b.dataset.v; offset = 0; history.replaceState(null, '', '#instagram?view=' + view0); draw(); });
    $('#igSync').onclick = run(async () => { const r = await api('/ig/sync', { method: 'POST' }); toast(`Synced ${fmtN(r.posts)} posts`); draw(); });
    $('#igTokNew').onclick = run(async () => { const t = prompt('New Instagram access token'); if (!t) return; await api('/ig/token', { method: 'POST', body: { token: t } }); toast('Token replaced'); draw(); });
    if (view0 === 'publish') await drawPublish(); else await loadList(false);
  };
  const row = m => {
    const date = m.ts ? new Date(m.ts * 1000).toLocaleDateString() : '';
    const cands = m.candidates.map(p => `
      <div class="igc ${p.status}">
        <img loading="lazy" src="${thumb(p)}" alt="" data-open="${esc(p.photo_id)}">
        <div class="small"><b>${esc(p.title || p.photo_id)}</b><div class="muted">${p.status === 'confirmed' ? '✓ confirmed' : p.status === 'auto' ? 'auto-matched' : 'candidate'}
          ${p.inliers != null ? ` · ${fmtN(p.inliers)} matching points` : ''}${p.cos ? ` · look-alike ${Math.round(p.cos * 100)}%` : ''}</div></div>
        <div class="row">${p.status !== 'confirmed' ? `<button class="mini primary" data-ok="${esc(p.photo_id)}">✓ This one</button>` : ''}
          <button class="mini" data-no="${esc(p.photo_id)}">✕ Not it</button></div>
      </div>`).join('');
    return `<div class="igrow" data-ig="${esc(m.id)}">
      <div class="igm"><a href="${esc(m.permalink || '#')}" target="_blank" rel="noopener"><img loading="lazy" src="${igImg(m.id)}" alt=""></a>
        <div class="small"><a href="${esc(m.permalink || '#')}" target="_blank" rel="noopener">${date}${m.position ? ` · slide ${m.position + 1}` : ''}</a>
          <span class="muted"> · ♥ ${fmtN(m.like_count)} · 💬 ${fmtN(m.comments_count)}</span>
          <div class="muted igcap">${esc((m.caption || '').slice(0, 140))}</div></div></div>
      <div class="igcs">${cands || `<span class="small muted">${m.matched_at ? 'No look-alike on the site.' : 'Not checked yet.'}</span>`}</div>
      <div class="igact"><button class="mini" data-pick title="Search the site’s photos and link one by hand">🔍 Link a photo…</button>${m.candidates.length && view0 !== 'matched' ? '<button class="mini" data-none>None of these</button>' : ''}${m.matched_at ? '<button class="mini" data-reset title="Forget the matcher’s guesses and your decisions for this image; it gets checked again next run">Re-check</button>' : ''}</div>
      <div class="igpick" hidden><div class="row"><input class="igq" type="search" placeholder="Search title, tags, place or photo ID…" autocomplete="off" spellcheck="false">
          <span class="small muted igqn"></span></div><div class="igres"></div></div>
    </div>`;
  };
  // ---- hand crop for Instagram: fixed shape, drag to move, slider / wheel to zoom ----
  const RATIOS = [['1:1', 1], ['4:5', 0.8], ['1.91:1', 1.91]];
  const ratioName = r => (RATIOS.reduce((a, b) => Math.abs(b[1] - r) < Math.abs(a[1] - r) ? b : a)[0]);
  const openCropper = (x, onSave) => {
    let dlg = $('#igCropDlg');
    if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'igCropDlg'; dlg.className = 'igcropdlg'; document.body.appendChild(dlg); }
    const prev = x.crop ? JSON.parse(x.crop) : null;
    const nat = x.pw && x.ph ? x.pw / x.ph : 1.5;
    let ratio = prev && x.pw ? RATIOS.find(r => r[0] === ratioName((prev.w * x.pw) / (prev.h * x.ph)))[1] : 1;
    dlg.innerHTML = `<div class="row"><b>Crop for Instagram</b><span class="small muted">${esc(x.title || x.photo_id)}</span><span class="spacer"></span>
        ${RATIOS.map(([n, r]) => `<button class="mini" data-r="${r}">${n}${n === '1:1' ? ' square' : n === '4:5' ? ' tall' : ' wide'}</button>`).join('')}</div>
      <div class="cropstage"><img alt=""><div class="cropbox"><i></i><i></i></div></div>
      <div class="row small"><label>Zoom <input type="range" class="cz" min="15" max="100" value="100" style="width:220px"></label>
        <span class="muted">Drag the frame to move it · scroll to zoom</span><span class="spacer"></span>
        <button class="mini" data-x>Cancel</button><button class="mini primary" data-ok>Save crop & queue</button></div>`;
    const img = dlg.querySelector('img'), boxEl = dlg.querySelector('.cropbox'), zoom = dlg.querySelector('.cz');
    let sw = 0, sh = 0, bx = 0, by = 0, bw = 0, bh = 0;
    const maxBox = () => (sw / sh > ratio ? [sh * ratio, sh] : [sw, sw / ratio]);
    const clamp = () => { bx = Math.min(Math.max(0, bx), sw - bw); by = Math.min(Math.max(0, by), sh - bh); };
    const paint = () => { clamp(); Object.assign(boxEl.style, { left: bx + 'px', top: by + 'px', width: bw + 'px', height: bh + 'px' });
      dlg.querySelectorAll('[data-r]').forEach(b => b.classList.toggle('primary', +b.dataset.r === ratio)); };
    const setSize = (pct, keepCenter = true) => {
      const [mw, mh] = maxBox(), cx = bx + bw / 2, cy = by + bh / 2;
      bw = mw * pct / 100; bh = mh * pct / 100;
      if (keepCenter) { bx = cx - bw / 2; by = cy - bh / 2; }
      zoom.value = Math.round(pct); paint();
    };
    const layout = (init) => {
      sw = img.clientWidth; sh = img.clientHeight;
      if (init && prev) { const [mw] = maxBox(); bw = prev.w * sw; bh = prev.h * sh; bx = prev.x * sw; by = prev.y * sh; zoom.value = Math.round(bw / mw * 100); paint(); }
      else { bx = sw / 2; by = sh / 2; bw = bh = 0; setSize(100); }
    };
    img.onload = () => layout(true);
    img.src = `/api/admin/img/${x.photo_id}/m`;
    dlg.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { ratio = +b.dataset.r; setSize(Math.min(+zoom.value, 100)); });
    zoom.oninput = () => setSize(+zoom.value);
    dlg.querySelector('.cropstage').onwheel = e => { e.preventDefault(); setSize(Math.min(100, Math.max(15, +zoom.value - Math.sign(e.deltaY) * 4))); };
    boxEl.onpointerdown = e => {
      e.preventDefault(); boxEl.setPointerCapture(e.pointerId);
      const sx = e.clientX - bx, sy = e.clientY - by;
      boxEl.onpointermove = ev => { bx = ev.clientX - sx; by = ev.clientY - sy; paint(); };
      boxEl.onpointerup = () => { boxEl.onpointermove = null; };
    };
    dlg.querySelector('[data-x]').onclick = () => dlg.close();
    dlg.querySelector('[data-ok]').onclick = run(async () => {
      await onSave({ x: bx / sw, y: by / sh, w: bw / sw, h: bh / sh });
      dlg.close(); toast('Cropped — queued for Instagram');
    });
    dlg.showModal();
  };
  // ---- posting to Instagram from the Flickr magic tag ----
  const PUB = { container: ['Posting…', 'warn'], crop: ['Waiting for your crop', 'warn'], queued: ['Queued', ''], held: ['Waiting for your OK', 'warn'], skipped: ['Already on Instagram', ''],
    error: ['Failed', 'err'], published: ['Posted', 'ok'], cancelled: ['Cancelled', ''] };
  const drawPublish = async (d) => {
    d = d || await api('/ig/publish');
    const st = d.settings, c = d.counts, box = $('#igList');
    $('#igMore').hidden = true;
    const ex = (st.prefix || 'tsp-ig-') + 'newyorkcity';
    box.innerHTML = `
      <div class="callout">
        <div class="row"><label><input type="checkbox" id="pOn"${st.on ? ' checked' : ''}> <b>Post to Instagram from Flickr</b></label>
          <span class="spacer"></span><span class="small muted">${fmtN(d.last24h)} posted in the last 24 h · ${fmtN(c.queued || 0)} queued</span>
          <button class="mini" id="pScan">Check Flickr photos now</button></div>
        <p class="small muted" style="margin:8px 0">A public photo that syncs from Flickr with the magic tag is posted to @${esc((await api('/ig/status')).username || '')} once — its Flickr description (or title if there is none) becomes the caption,
          and tags starting with the prefix become hashtags: <code>${esc(ex)}</code> → <code>#newyorkcity</code>. The post is linked to the photo right away.
          Tag a photo <code>${esc((st.prefix || 'tsp-ig-') + (st.manual || 'manual'))}</code> instead to have it wait here until you crop it (✂ Crop… — square, 4:5 or wide; handy for panoramas).
          When you switch this on, photos that already carry the tag wait here for your OK instead of posting.</p>
        <div class="row small">
          <label>Magic tag <input id="pTag" value="${esc(st.tag)}" style="width:120px"></label>
          <label>Hashtag prefix <input id="pPre" value="${esc(st.prefix)}" style="width:120px"></label>
          <label title="Prefix + this word, e.g. ${esc((st.prefix || 'tsp-ig-') + (st.manual || 'manual'))}, means: post it, but wait for me to crop it first">Manual-crop word <input id="pMan" value="${esc(st.manual || 'manual')}" style="width:90px"></label>
          <label>Too tall / too wide for Instagram <select id="pFit"><option value="pad"${st.fit !== 'crop' ? ' selected' : ''}>Whole photo, white bars</option><option value="crop"${st.fit === 'crop' ? ' selected' : ''}>Crop to fit</option></select></label>
          <label>Max posts / 24 h <input id="pDay" type="number" min="1" max="50" value="${st.daily}" style="width:64px"></label>
          <button class="mini primary" id="pSave">Save</button></div>
        <p class="small muted" style="margin:8px 0 0">Needs the Instagram token to include the <code>instagram_content_publish</code> permission.</p>
      </div>
      <div class="iglist" style="margin-top:12px">${d.posts.map(x => {
        const [label, cls] = PUB[x.status] || [x.status, ''];
        const acts = [
          ['crop', 'held', 'queued', 'error', 'skipped', 'cancelled'].includes(x.status) ? `<button class="mini${x.status === 'crop' ? ' primary' : ''}" data-crop="${esc(x.photo_id)}">✂ Crop…</button>` : '',
          ['held', 'skipped', 'error', 'cancelled', 'crop'].includes(x.status) ? `<button class="mini${x.status === 'crop' ? '' : ' primary'}" data-pub="${esc(x.photo_id)}" data-a="publish">${x.status === 'error' ? 'Retry' : x.status === 'skipped' ? 'Post anyway' : x.status === 'crop' ? 'Post uncropped' : 'Post it'}</button>` : '',
          x.crop && x.status !== 'published' ? `<button class="mini" data-pub="${esc(x.photo_id)}" data-a="nocrop">Undo crop</button>` : '',
          ['held', 'queued', 'error', 'skipped', 'crop'].includes(x.status) ? `<button class="mini" data-pub="${esc(x.photo_id)}" data-a="cancel">Don’t post</button>` : ''].join('');
        const cr = x.crop && JSON.parse(x.crop), crTxt = cr && x.pw ? ` <span class="pill">✂ ${ratioName((cr.w * x.pw) / (cr.h * x.ph))}</span>` : '';
        return `<div class="igrow">
          <div class="igm"><img loading="lazy" src="/api/admin/img/${esc(x.photo_id)}/t?v=${x.v || 0}" alt="" data-open="${esc(x.photo_id)}" style="cursor:zoom-in">
            <div class="small"><b>${esc(x.title || x.photo_id)}</b></div></div>
          <div class="small"><span class="pill ${cls}">${label}</span>${crTxt}${x.permalink ? ` <a href="${esc(x.permalink)}" target="_blank" rel="noopener">View on Instagram ↗</a>` : ''}
            ${x.note ? `<div class="${x.status === 'error' ? 'err' : 'muted'}" style="margin:4px 0">${esc(x.note)}</div>` : ''}
            <div class="igcapfull">${esc(x.preview || '')}</div></div>
          <div class="igact">${acts}</div></div>`;
      }).join('') || '<p class="muted">No photos with the magic tag yet.</p>'}</div>`;
    const save = async body => drawPublish(await api('/ig/publish/settings', { method: 'POST', body }));
    $('#pOn').onchange = run(async e => {
      if (e.target.checked && !confirm('Start posting to Instagram? New Flickr photos with the magic tag will be posted automatically.')) { e.target.checked = false; return; }
      await save({ on: e.target.checked }); toast(e.target.checked ? 'Posting is on' : 'Posting is off');
    });
    box.querySelectorAll('[data-crop]').forEach(b => b.onclick = () => {
      const x = d.posts.find(p => p.photo_id === b.dataset.crop);
      openCropper(x, async crop => drawPublish(await api('/ig/publish/' + x.photo_id, { method: 'POST', body: { action: 'crop', crop } })));
    });
    $('#pSave').onclick = run(async () => { await save({ tag: $('#pTag').value, prefix: $('#pPre').value, manual: $('#pMan').value, fit: $('#pFit').value, daily: $('#pDay').value }); toast('Saved'); });
    $('#pScan').onclick = run(async () => { const r = await api('/ig/publish/scan', { method: 'POST' }); toast(`${fmtN(r.found)} new tagged photo${r.found === 1 ? '' : 's'}`); drawPublish(r); });
    box.querySelectorAll('[data-pub]').forEach(b => b.onclick = run(async () => drawPublish(await api('/ig/publish/' + b.dataset.pub, { method: 'POST', body: { action: b.dataset.a } }))));
  };
  const loadList = async more => {
    const d = await api(`/ig/list?view=${view0}&offset=${offset}`);
    const box = $('#igList');
    if (!more) box.innerHTML = '';
    box.insertAdjacentHTML('beforeend', d.items.map(row).join('') || (more ? '' : `<p class="muted">${{ review: 'Nothing to review 🎉', matched: 'No matches yet.', unmatched: 'Every checked image found its photo.', unchecked: 'Everything has been checked.' }[view0]}</p>`));
    $('#igMore').hidden = d.items.length < 60;
    $('#igMore').onclick = run(async () => { offset += 60; await loadList(true); });
  };
  // manual link: search the site's photos inside the row, click one to link it
  const pickSearch = async (rowEl) => {
    const q = rowEl.querySelector('.igq').value.trim(), res = rowEl.querySelector('.igres'), seq = (rowEl._seq = (rowEl._seq || 0) + 1);
    const d = await api(`/photos?status=ok&sort=popular&limit=30${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    if (seq !== rowEl._seq) return; // a newer search already answered
    rowEl.querySelector('.igqn').textContent = `${fmtN(d.total)} photo${d.total === 1 ? '' : 's'}${d.total > 30 ? ' — showing the 30 most popular' : ''}`;
    res.innerHTML = d.photos.map(p => `<button class="igp" data-link="${esc(p.id)}" title="${esc(p.title || p.id)} — click to link">
        <img loading="lazy" src="/api/admin/img/${esc(p.id)}/t" alt=""><span class="small">${esc((p.title || p.id).slice(0, 40))}</span></button>`).join('')
      || '<p class="small muted">No photos match.</p>';
  };
  view.oninput = e => {
    const rowEl = e.target.classList.contains('igq') && e.target.closest('[data-ig]');
    if (!rowEl) return;
    clearTimeout(rowEl._t); rowEl._t = setTimeout(() => run(() => pickSearch(rowEl))(), 250);
  };
  view.onclick = run(async e => {
    const b = e.target.closest('button'), rowEl = e.target.closest('[data-ig]');
    if (e.target.dataset.open) return openPhoto(e.target.dataset.open);
    if (!b || !rowEl) return;
    const ig_id = rowEl.dataset.ig;
    if (b.hasAttribute('data-pick')) {
      const pk = rowEl.querySelector('.igpick');
      pk.hidden = !pk.hidden;
      if (!pk.hidden) { rowEl.querySelector('.igq').focus(); if (!rowEl.querySelector('.igres').childElementCount) await pickSearch(rowEl); }
      return;
    }
    if (b.dataset.link) {
      await api('/ig/decide', { method: 'POST', body: { ig_id, action: 'confirm', photo_id: b.dataset.link } });
      toast('Linked');
      rowEl.classList.add('done'); setTimeout(() => rowEl.remove(), 250);
      return;
    }
    const act = b.dataset.ok ? { action: 'confirm', photo_id: b.dataset.ok } : b.dataset.no ? { action: 'reject', photo_id: b.dataset.no }
      : b.hasAttribute('data-none') ? { action: 'none' } : b.hasAttribute('data-reset') ? { action: 'reset' } : null;
    if (!act) return;
    await api('/ig/decide', { method: 'POST', body: { ig_id, ...act } });
    rowEl.classList.add('done'); setTimeout(() => rowEl.remove(), 250);
  });
  await run(draw)();
}

// ---------------- albums ----------------
async function albumsView() {
  const draw = async () => {
    const al = await albums(true);
    const colData = await api('/collections').catch(() => ({ collections: [], albums: [] }));
    const featured = (await api('/status')).settings.featured_album;
    const local = al.filter(a => a.source === 'local'), fl = al.filter(a => a.source === 'flickr');
    const cover = a => a.cover_photo_id ? `<img src="/api/admin/img/${a.cover_photo_id}/t" style="width:56px;height:56px;object-fit:cover;border-radius:4px;background:var(--tile)" loading="lazy" alt="">` : '';
    view.innerHTML = `
      <div class="row"><h2 style="margin:0">Site albums</h2><span class="spacer"></span><button id="newAlbum" class="primary">New album</button></div>
      <p class="muted small">Your own albums for the site. Add photos from the Organizer (select → Add to site album).</p>
      <div class="tblwrap"><table><tr><th></th><th>Title</th><th>Photos</th><th>Updated</th><th></th></tr>
        ${local.map(a => `<tr><td>${cover(a)}</td><td><a href="#organizer?album=${encodeURIComponent(a.id)}&sort=album">${esc(a.title)}</a>
          ${featured === a.id ? ' <span class="pill ok">pinned to front page</span>' : ''}<div class="small muted">${esc(a.description)}</div></td>
          <td>${fmtN(a.n)}</td><td>${ago(a.updated_at)}</td>
          <td><div class="row"><button data-act="rename" data-id="${esc(a.id)}">Edit</button>
          <button data-act="pin" data-id="${esc(a.id)}">${featured === a.id ? 'Unpin' : 'Pin to front page'}</button>
          <button class="danger" data-act="delete" data-id="${esc(a.id)}">Delete</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="muted">None yet.</td></tr>'}
      </table></div>
      ${colData.collections.length ? `<h2>Flickr collections <span class="muted small">(mirrored, read-only)</span></h2>
      <div class="tblwrap"><table><tr><th>Collection</th><th>Albums</th><th>Photos</th></tr>
        ${colData.collections.map(c => `<tr><td>${c.parent_id ? '<span class="muted">↳</span> ' : ''}<a href="#organizer?collection=${encodeURIComponent(c.id)}&sort=popular">${esc(c.title)}</a>
          <div class="small muted">${esc(c.account_name)}</div></td>
          <td class="small">${colData.albums.filter(a => a.collection_id === c.id).map(a => `<a href="#organizer?album=${encodeURIComponent(a.album_id)}&sort=album">${esc(a.title)}</a>`).join(', ') || '—'}</td>
          <td>${fmtN(c.n)}</td></tr>`).join('')}
      </table></div>` : ''}
      <h2>Flickr albums <span class="muted small">(mirrored, read-only)</span></h2>
      <div class="tblwrap"><table><tr><th></th><th>Title</th><th>Account</th><th>Photos</th></tr>
        ${fl.map(a => `<tr><td>${cover(a)}</td><td><a href="#organizer?album=${encodeURIComponent(a.id)}&sort=album">${esc(a.title)}</a></td>
          <td>${esc(a.account_name)}</td><td>${fmtN(a.n)}${a.n !== a.photo_count ? ` <span class="small muted">(Flickr: ${fmtN(a.photo_count)})</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Synced after the first full listing.</td></tr>'}
      </table></div>`;
    $('#newAlbum').onclick = run(async () => {
      const title = prompt('Album title'); if (!title) return;
      await api('/albums', { method: 'POST', body: { title } }); draw();
    });
    view.querySelectorAll('[data-act]').forEach(b => b.onclick = run(async () => {
      const id = b.dataset.id, a = local.find(x => x.id === id);
      if (b.dataset.act === 'rename') {
        const title = prompt('Title', a.title); if (!title) return;
        const description = prompt('Description', a.description || '') ?? a.description;
        await api('/albums/' + encodeURIComponent(id), { method: 'PATCH', body: { title, description } });
      } else if (b.dataset.act === 'delete') {
        if (!confirm(`Delete album “${a.title}”? Photos stay in the catalog.`)) return;
        await api('/albums/' + encodeURIComponent(id), { method: 'DELETE' });
      } else if (b.dataset.act === 'pin') {
        await api('/settings', { method: 'POST', body: { featured_album: featured === id ? '' : id } });
      }
      draw();
    }));
  };
  await run(draw)();
}

// ---------------- tags ----------------
let siteTagsCache = null;
// tree-ordered [slug, "Parent › Child"] options for selects
// Type-to-search tag picker for an <input>: matches name, URL name and parent tags; ↑↓ + Enter or click.
// specials = [[value, label]] shown at the top when nothing is typed (e.g. "Any tag").
function tagSearch(input, { tags, specials = [], onPick }) {
  const box = document.getElementById('tagSug') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'tagSug', className: 'tagsug', hidden: true }));
  const nrm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, '');
  const byId = new Map(tags.map(t => [t.id, t]));
  const pathOf = t => { const p = []; for (let x = byId.get(t.parent_id), n = 0; x && n < 8; x = byId.get(x.parent_id), n++) p.unshift(x.label); return p.join(' › '); };
  let list = [], i = 0;
  const draw = () => {
    box.innerHTML = list.map((x, k) => x.special
      ? `<div class="ts-i ts-s${k === i ? ' on' : ''}" data-k="${k}"><span class="ts-l">${esc(x.label)}</span></div>`
      : `<div class="ts-i${k === i ? ' on' : ''}" data-k="${k}"><span class="ts-l">${x.t.kind === 'location' ? '📍 ' : ''}${esc(x.t.label)}</span>
          <span class="ts-n">${fmtN(x.t.count ?? x.t.n ?? 0)}</span><span class="ts-p">${esc(pathOf(x.t) || (x.t.kind === 'location' ? 'place' : 'top level'))}</span></div>`).join('')
      || '<div class="ts-none">No tag matches</div>';
    box.querySelector('.ts-i.on')?.scrollIntoView({ block: 'nearest' });
  };
  const choose = x => { if (!x) return; box.hidden = true; onPick(x.special ? x.value : x.t.slug, x.special ? x.label : x.t.label); };
  const show = () => {
    const typed = input.value !== (input.dataset.label || '');
    const q = typed ? nrm(input.value).trim() : '', qc = q.replace(/ /g, '');
    const hits = tags.map(t => {
      const l = nrm(t.label), lc = l.replace(/ /g, '');
      const s = !q ? 3 : lc.startsWith(qc) || t.slug.startsWith(qc) ? 0 : l.split(' ').some(w => w.startsWith(q)) ? 1 : lc.includes(qc) || t.slug.includes(qc) ? 2 : nrm(pathOf(t)).includes(q) ? 4 : -1;
      return { t, s };
    }).filter(x => x.s >= 0).sort((a, b) => a.s - b.s || (b.t.count ?? b.t.n ?? 0) - (a.t.count ?? a.t.n ?? 0) || a.t.label.localeCompare(b.t.label)).slice(0, 40);
    list = [...(q ? [] : specials.map(([value, label]) => ({ special: true, value, label }))), ...hits];
    i = 0;
    const r = input.getBoundingClientRect();
    const up = innerHeight - r.bottom < 280 && r.top > 280; // e.g. the selection bar at the bottom of the screen: open upward
    Object.assign(box.style, { left: Math.min(r.left, innerWidth - 330) + 'px', top: up ? 'auto' : r.bottom + 4 + 'px', bottom: up ? innerHeight - r.top + 4 + 'px' : 'auto', minWidth: Math.max(r.width, 300) + 'px' });
    box.onmousedown = e => { const it = e.target.closest('.ts-i'); if (it) { e.preventDefault(); choose(list[+it.dataset.k]); input.blur(); } };
    box._owner = input; box.hidden = false; draw();
  };
  input.autocomplete = 'off'; input.spellcheck = false;
  input.addEventListener('focus', () => { input.select(); show(); });
  input.addEventListener('input', show);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (box.hidden) show(); i = (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % Math.max(1, list.length); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(list[i]); input.blur(); }
    else if (e.key === 'Escape') { input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (box._owner === input) box.hidden = true; input.value = input.dataset.label || ''; }, 150));
}

function tagOptions(tags) {
  const kids = new Map();
  for (const t of tags) (kids.get(t.parent_id || 0) ?? kids.set(t.parent_id || 0, []).get(t.parent_id || 0)).push(t);
  const out = [];
  const walk = (pid, prefix, kind) => (kids.get(pid) || []).filter(t => !kind || t.kind === kind)
    .forEach(t => { out.push([t.slug, prefix + t.label]); walk(t.id, prefix + '\u00a0\u00a0', null); });
  walk(0, '', 'content'); walk(0, '📍 ', 'location');
  return out;
}

async function tagsView() {
  const draw = async () => {
    const d = await api('/tags');
    siteTagsCache = d.tags;
    const byParent = new Map();
    for (const t of d.tags) (byParent.get(t.parent_id || 0) ?? byParent.set(t.parent_id || 0, []).get(t.parent_id || 0)).push(t);
    const row = (t, depth) => `<div class="trow" style="padding-left:${depth * 22}px">
        <a href="#organizer?tag=${encodeURIComponent(t.slug)}" class="tname">${esc(t.label)}</a>
        <code class="small muted">tag-${esc(t.slug)}</code>
        <span class="small muted">${fmtN(t.count)} photos${t.ai ? ` · ${fmtN(t.ai)} by Claude` : ''}</span>
        <span class="spacer"></span>
        ${t.aliases.length ? `<span class="small muted" title="${esc(t.aliases.join(', '))}">${t.aliases.length} Flickr words</span>` : ''}
        <button class="linkbtn" data-edit="${t.id}">edit</button></div>
      ${(byParent.get(t.id) || []).map(c => row(c, depth + 1)).join('')}`;
    const tree = kind => (byParent.get(0) || []).filter(t => t.kind === kind).map(t => row(t, 0)).join('') || '<p class="muted small">None yet.</p>';
    const tt = d.totals;
    view.innerHTML = `
      <div class="row"><h2 style="margin:0">Tags</h2><span class="spacer"></span>
        <a class="btn" href="#organizer?notag=content">${fmtN(tt.no_content)} photos without a content tag</a>
        <a class="btn" href="#organizer?notag=location">${fmtN(tt.no_location)} without a location tag</a></div>
      <p class="small muted">Your own consistent scheme. New photos are tagged automatically: <strong>location</strong> from the Flickr geotag,
        <strong>content</strong> from Flickr tags — the scheme tag itself (add <code>tag-city</code> on Flickr) or any of its Flickr words (e.g. <em>cityscape</em>, <em>urban</em>).
        ✦ marks tags from Claude's one-time pass. Tags you remove by hand stay removed.</p>
      <div class="row" style="margin:10px 0 16px">
        <button id="tApply" class="primary">Re-apply rules to all photos</button>
        <a class="btn" href="/api/admin/tags/export" download="tonyshi-tags-export.json">Export for Claude</a>
        <label class="btn">Import Claude's results<input type="file" id="tImport" accept=".json" hidden></label>
        <span id="tMsg" class="small"></span>
      </div>
      <div class="tcols">
        <div class="card"><div class="row"><strong>Content</strong><span class="spacer"></span><button class="linkbtn" data-new="content">+ new tag</button></div>${tree('content')}</div>
        <div class="card"><div class="row"><strong>Location</strong><span class="spacer"></span><button class="linkbtn" data-new="location">+ new tag</button></div>
          <div class="small muted" style="margin:4px 0 8px">Created automatically from geotags (country › state › city).</div>${tree('location')}</div>
      </div>`;

    const applyAll = run(async () => {
      const msg = $('#tMsg');
      for (let off = 0; off !== null;) {
        const r = await api('/tags/apply', { method: 'POST', body: { offset: off } });
        msg.textContent = `Applying rules… ${fmtN(r.done)} / ${fmtN(r.total)}`;
        off = r.next;
      }
      msg.textContent = '✅ Rules applied to all photos'; msg.className = 'small okc';
      draw();
    });
    $('#tApply').onclick = applyAll;
    $('#tImport').onchange = run(async e => {
      const f = e.target.files[0]; if (!f) return;
      const data = JSON.parse(await f.text());
      const r = await api('/tags/import', { method: 'POST', body: data });
      $('#tMsg').textContent = `Imported: ${r.created} new tags, ${r.aliased} Flickr words mapped, ${fmtN(r.tagged)} photos tagged by Claude — applying rules…`;
      applyAll();
    });
    view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => tagEditor(d.tags, d.tags.find(t => t.id === +b.dataset.edit), draw));
    view.querySelectorAll('[data-new]').forEach(b => b.onclick = () => tagEditor(d.tags, { kind: b.dataset.new, aliases: [] }, draw));
  };
  await run(draw)();
}

function tagEditor(all, t, done) {
  const isNew = !t.id;
  const parents = all.filter(x => x.kind === t.kind && x.id !== t.id);
  drawer.innerHTML = `
    <div class="row"><strong>${isNew ? `New ${t.kind} tag` : `Edit “${esc(t.label)}”`}</strong><span class="spacer"></span><button id="teX">Close</button></div>
    <div class="form" style="grid-template-columns:110px 1fr;margin-top:12px">
      <label>Name</label><input id="teLabel" value="${esc(t.label || '')}" placeholder="e.g. Aerial">
      <label>Slug</label><div><input id="teSlug" value="${esc(t.slug || '')}" placeholder="auto from name"><div class="small muted">On Flickr, tag photos <code>tag-<span id="teSlugShow">${esc(t.slug || '…')}</span></code></div></div>
      <label>Inside</label><select id="teParent"><option value="">(top level)</option>${parents.map(x => `<option value="${x.id}" ${x.id === t.parent_id ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
      <label>Flickr words</label><div><textarea id="teAliases" rows="4" style="width:100%" placeholder="cityscape, urban, skyline">${esc(t.aliases.join(', '))}</textarea>
        <div class="small muted">Photos whose Flickr tags include any of these get this tag.</div></div>
    </div>
    <div class="row" style="margin-top:14px"><button id="teSave" class="primary">${isNew ? 'Create' : 'Save'}</button>
      ${isNew ? '' : '<button id="teDel" class="danger">Delete tag</button>'}<span id="teMsg" class="small"></span></div>
    <p class="small muted">After changing Flickr words, use <em>Re-apply rules to all photos</em> on the Tags page.</p>`;
  drawer.hidden = false;
  const slugify = s => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
  $('#teLabel').oninput = () => { if (isNew && !$('#teSlug').dataset.touched) $('#teSlug').value = slugify($('#teLabel').value); $('#teSlugShow').textContent = $('#teSlug').value || '…'; };
  $('#teSlug').oninput = () => { $('#teSlug').dataset.touched = '1'; $('#teSlugShow').textContent = slugify($('#teSlug').value) || '…'; };
  $('#teX').onclick = closeDrawer;
  $('#teSave').onclick = run(async () => {
    const body = { label: $('#teLabel').value, slug: $('#teSlug').value || $('#teLabel').value, parent_id: $('#teParent').value || null,
      aliases: $('#teAliases').value.split(/[,\n]/).map(x => x.trim()).filter(Boolean), kind: t.kind };
    await api(isNew ? '/tags' : '/tags/' + t.id, { method: isNew ? 'POST' : 'PATCH', body });
    toast(isNew ? 'Tag created' : 'Saved'); closeDrawer(); done();
  });
  if ($('#teDel')) $('#teDel').onclick = run(async () => {
    if (!confirm(`Delete “${t.label}”? It's removed from ${fmtN(t.count)} photos; its sub-tags move up a level.`)) return;
    await api('/tags/' + t.id, { method: 'DELETE' }); toast('Deleted'); closeDrawer(); done();
  });
}

// ---------------- popularity ----------------
const YEAR = 365.25 * 86400;
const DEFAULT_W = { F: 3, V: 2, C: 0.5, D: 0.7 };
function popScore(p, w, t) {
  const age = Math.max(0, (t - (p.date_upload || t)) / YEAR);
  return (w.F * (p.faves || 0) + w.V * (p.views || 0) / 100 + w.C * (p.comments || 0)) / Math.pow(1 + age, w.D);
}

// ---------------- Stats (Flickr, this site, Instagram, Getty — with memory beyond Flickr's 28 days) ----------------
async function statsView(params) {
  const st = { account: params?.get?.('account') || '', period: +(params?.get?.('period') || 30), series: 'views', moversBy: 'views', sort: 'views', by: 'year' };
  const thumb = p => `/api/admin/img/${p.id}/t?v=${p.v || 0}`;
  const k = n => n == null ? '–' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.abs(n) >= 1e4 ? Math.round(n / 1e3) + 'k' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
  const delta = (cur, prev) => !prev ? '' : `<span class="${cur >= prev ? 'up' : 'down'}">${cur >= prev ? '▲' : '▼'} ${Math.abs(Math.round((cur - prev) / prev * 100))}%</span>`;
  const qs = extra => new URLSearchParams({ ...(st.account ? { account: st.account } : {}), period: st.period, ...extra });
  // tiny SVG bar chart (no libraries)
  const bars = (rows, key, { h = 150, label = r => r.day } = {}) => {
    if (!rows.length) return '<p class="muted small">No data yet — it builds up day by day.</p>';
    const max = Math.max(1, ...rows.map(r => r[key] || 0)), W = 100 / rows.length;
    return `<svg class="sbars" viewBox="0 0 100 ${h}" preserveAspectRatio="none">${rows.map((r, i) => {
      const bh = Math.max(0.5, (r[key] || 0) / max * (h - 4));
      return `<rect x="${(i * W + W * 0.12).toFixed(3)}" y="${(h - bh).toFixed(2)}" width="${(W * 0.76).toFixed(3)}" height="${bh.toFixed(2)}"><title>${esc(label(r))}: ${fmtN(r[key] || 0)}</title></rect>`;
    }).join('')}</svg><div class="saxis small muted"><span>${esc(label(rows[0]))}</span><span>max ${fmtN(max)}</span><span>${esc(label(rows.at(-1)))}</span></div>`;
  };
  const hbar = (v, max) => `<span class="hbar"><i style="width:${Math.max(1, v / Math.max(1, max) * 100).toFixed(1)}%"></i></span>`;

  const draw = async () => {
    const o = await api('/stats/overview?' + qs());
    const t = o.totals, ip = o.inPeriod;
    const rate = t.views ? (t.faves * 1000 / t.views).toFixed(1) : '–';
    view.innerHTML = `
      <div class="row"><h2 style="margin:0">Stats</h2><span class="seg"><a href="#stats" class="on">Flickr</a><a href="#igstats">Instagram</a></span><span class="spacer"></span>
        <select id="sAcc">${[['', 'All accounts'], ...o.accounts.map(a => [String(a.id), a.username])].map(([v, l]) => `<option value="${esc(v)}"${v === st.account ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <select id="sPer">${[[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last 12 months']].map(([v, l]) => `<option value="${v}"${v === st.period ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      <p class="small muted" style="margin:6px 0 14px">${o.since ? `History since ${esc(o.since)} — every photo's counts are recorded daily, so this keeps growing (Flickr itself forgets after 28 days).` : 'History starts with the first daily snapshot (within a minute of deploying).'}
        Flickr's own daily stats: ${o.accounts.map(a => `${esc(a.username)} ${a.stats_ok === 1 ? '✓' : a.stats_ok === 0 ? '<span title="Flickr only gives stats to Pro accounts">— not Pro</span>' : '…'}`).join(' · ')}</p>
      <div class="cards">
        <div class="card"><div class="k">Views</div><div class="v">${k(t.views)}</div><div class="small muted">+${fmtN(ip.views)} in ${st.period} days ${delta(ip.views, ip.viewsPrev)}</div></div>
        <div class="card"><div class="k">Faves</div><div class="v">${k(t.faves)}</div><div class="small muted">+${fmtN(ip.faves)} in ${st.period} days ${delta(ip.faves, ip.favesPrev)}</div></div>
        <div class="card"><div class="k">Comments</div><div class="v">${k(t.comments)}</div><div class="small muted">+${fmtN(ip.comments)} in ${st.period} days</div></div>
        <div class="card"><div class="k">Fave rate</div><div class="v">${rate}</div><div class="small muted">faves per 1,000 views · ${fmtN(t.faved)} of ${fmtN(t.photos)} photos faved</div></div>
        <div class="card"><div class="k">In galleries</div><div class="v">${k(t.galleries)}</div><div class="small muted">curated by other people (looked up as photos are opened)</div></div>
        <div class="card"><div class="k">Views on your site</div><div class="v">${k(t.tsp)}</div><div class="small muted">+${fmtN(ip.tsp)} in ${st.period} days</div></div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="row"><strong>Daily ${o.dailySource === 'flickr' ? 'views (Flickr stats)' : 'gains'}</strong><span class="spacer"></span>
          ${o.dailySource === 'flickr' ? '' : ['views', 'faves', 'comments', 'tsp'].map(x => `<button class="mini${st.series === x ? ' primary' : ''}" data-series="${x}">${{ views: 'Views', faves: 'Faves', comments: 'Comments', tsp: 'Site views' }[x]}</button>`).join('')}</div>
        <div id="sChart">${bars(o.daily, o.dailySource === 'flickr' ? 'views' : st.series)}</div>
      </div>

      <div class="scols">
        <div class="card"><strong>Where Flickr views come from</strong> <span class="small muted">last ${st.period} days</span>
          ${o.domains.length ? `<table class="stbl">${o.domains.map(d => `<tr><td>${esc(d.domain)}</td><td>${hbar(d.views, o.domains[0].views)}</td><td class="num">${fmtN(d.views)}</td></tr>`).join('')}</table>`
            : '<p class="small muted">Comes from Flickr’s stats (Pro accounts), collected daily.</p>'}</div>
        <div class="card"><strong>Uploads by month</strong> <span class="small muted">bar = photos uploaded · hover for their average views</span>
          ${bars(o.uploads.slice(-48), 'n', { h: 110, label: r => `${r.m} — ${fmtN(r.n)} photos, avg ${fmtN(Math.round(r.av))} views, ${(+r.af).toFixed(1)} faves` })}</div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="row"><strong>Rising</strong> <span class="small muted">most gained in the last ${st.period} days</span><span class="spacer"></span>
          ${[['views', 'Views'], ['faves', 'Faves'], ['comments', 'Comments'], ['tsp', 'Site views']].map(([x, l]) => `<button class="mini${st.moversBy === x ? ' primary' : ''}" data-movers="${x}">${l}</button>`).join('')}</div>
        <div id="sMovers" class="smovers"><p class="muted small">Loading…</p></div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="row"><strong>Leaders</strong><span class="spacer"></span>
          ${[['views', 'Views'], ['faves', 'Faves'], ['comments', 'Comments'], ['rate', 'Fave rate (hidden gems)'], ['galleries', 'Galleries'], ['tsp', 'Site views']].map(([x, l]) => `<button class="mini${st.sort === x ? ' primary' : ''}" data-sort="${x}">${l}</button>`).join('')}</div>
        <div id="sLeaders"><p class="muted small">Loading…</p></div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="row"><strong>What works</strong> <span class="small muted">average views and fave rate per group</span><span class="spacer"></span>
          ${[['year', 'Year taken'], ['uploaded', 'Year uploaded'], ['camera', 'Camera'], ['country', 'Country'], ['city', 'City'], ['tag', 'Subject'], ['album', 'Album'], ['shape', 'Shape']].map(([x, l]) => `<button class="mini${st.by === x ? ' primary' : ''}" data-by="${x}">${l}</button>`).join('')}</div>
        <div id="sBreak"><p class="muted small">Loading…</p></div>
      </div>`;
    $('#sAcc').onchange = e => { st.account = e.target.value; run(draw)(); };
    $('#sPer').onchange = e => { st.period = +e.target.value; run(draw)(); };
    view.querySelectorAll('[data-series]').forEach(b => b.onclick = () => { st.series = b.dataset.series; $('#sChart').innerHTML = bars(o.daily, st.series); view.querySelectorAll('[data-series]').forEach(x => x.classList.toggle('primary', x === b)); });
    const tabs = (attr, key, fn) => view.querySelectorAll(`[data-${attr}]`).forEach(b => b.onclick = run(async () => { st[key] = b.dataset[attr]; view.querySelectorAll(`[data-${attr}]`).forEach(x => x.classList.toggle('primary', x === b)); await fn(); }));
    tabs('movers', 'moversBy', movers); tabs('sort', 'sort', leaders); tabs('by', 'by', breakdown);
    await Promise.all([movers(), leaders(), breakdown()]);
  };

  const movers = async () => {
    const d = await api('/stats/movers?' + qs({ by: st.moversBy }));
    $('#sMovers').innerHTML = d.photos.length ? d.photos.map(p => `<div class="smv" data-open="${esc(p.id)}" title="${esc(p.title || '')}">
        <img loading="lazy" src="${thumb(p)}" alt="" data-open="${esc(p.id)}"><b>+${fmtN(p.gain)}</b><span class="small muted">${p.fresh ? 'new upload' : ''}</span></div>`).join('')
      : '<p class="muted small">Nothing yet — gains show once there are two days of history.</p>';
  };
  const leaders = async () => {
    const d = await api('/stats/leaders?' + qs({ sort: st.sort }));
    const max = Math.max(1, ...d.photos.map(p => p.views || 0));
    $('#sLeaders').innerHTML = `<table class="stbl lead"><tr><th></th><th>Photo</th><th class="num">Views</th><th></th><th class="num">Faves</th><th class="num">Comments</th><th class="num" title="faves per 1,000 views">Rate</th><th class="num">Galleries</th><th class="num" title="Instagram likes">IG ♥</th><th class="num" title="Getty licenses sold">Getty</th><th class="num" title="Views on your site">Site</th></tr>
      ${d.photos.map((p, i) => `<tr><td class="small muted">${i + 1}</td><td><span class="lt"><img loading="lazy" src="${thumb(p)}" alt="" data-open="${esc(p.id)}"><span>${esc(p.title || p.id)}</span></span></td>
        <td class="num">${fmtN(p.views)}</td><td>${hbar(p.views || 0, max)}</td><td class="num">${fmtN(p.faves)}</td><td class="num">${fmtN(p.comments)}</td>
        <td class="num">${p.views ? (p.faves * 1000 / p.views).toFixed(1) : '–'}</td><td class="num">${p.galleries ?? '–'}</td><td class="num">${p.ig ? fmtN(p.ig) : '–'}</td>
        <td class="num">${p.getty ? fmtN(p.getty) : '–'}</td><td class="num">${fmtN(p.tsp)}</td></tr>`).join('')}</table>`;
  };
  const breakdown = async () => {
    const d = await api('/stats/breakdown?' + qs({ by: st.by }));
    const mv = Math.max(1, ...d.rows.map(r => r.av || 0)), mr = Math.max(1, ...d.rows.map(r => r.rate || 0));
    $('#sBreak').innerHTML = d.rows.length ? `<table class="stbl"><tr><th></th><th class="num">Photos</th><th class="num">Avg views</th><th></th><th class="num">Avg faves</th><th class="num" title="faves per 1,000 views">Fave rate</th><th></th><th class="num">Total views</th></tr>
      ${d.rows.map(r => `<tr><td>${esc(r.k)}</td><td class="num">${fmtN(r.n)}</td><td class="num">${fmtN(r.av)}</td><td>${hbar(r.av, mv)}</td><td class="num">${r.af}</td>
        <td class="num">${r.rate}</td><td>${hbar(r.rate, mr)}</td><td class="num">${fmtN(r.sv)}</td></tr>`).join('')}</table>`
      : '<p class="muted small">Nothing to show for this grouping yet.</p>';
  };
  view.onclick = e => { const id = e.target.dataset?.open; if (id) openPhoto(id); };
  await run(draw)();
}

// ---------------- Instagram stats ----------------
async function igStatsView(params) {
  const st = { period: +(params?.get?.('period') || 30), sort: 'likes' };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const k = n => n == null ? '–' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.abs(n) >= 1e4 ? Math.round(n / 1e3) + 'k' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
  const pic = p => p.photo_id ? `/api/admin/img/${p.photo_id}/t` : `/api/admin/ig/img/${p.first_id}`;
  const date = t => t ? new Date(t * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  const hbar = (v, max) => `<span class="hbar"><i style="width:${Math.max(1, v / Math.max(1e-9, max) * 100).toFixed(1)}%"></i></span>`;
  const draw = async () => {
    const d = await api(`/stats/instagram?period=${st.period}&tz=${encodeURIComponent(tz)}`);
    if (d.empty) { view.innerHTML = `${switcher('ig')}<div class="callout" style="margin-top:12px">No Instagram posts synced yet — connect Instagram in <a href="#instagram">Instagram</a>.</div>`; bindSwitch(); return; }
    const r = d.recent, change = r.prevLikes ? Math.round((r.likes - r.prevLikes) / r.prevLikes * 100) : null;
    const maxL = Math.max(1, ...d.timeline.map(p => p.likes));
    const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], H = ['12–3a', '3–6a', '6–9a', '9a–12', '12–3p', '3–6p', '6–9p', '9p–12'];
    const cell = (di, hi) => d.heat.find(c => c.d === di && c.h === hi);
    const maxS = Math.max(1, ...d.heat.map(c => c.score));
    view.innerHTML = `
      ${switcher('ig')}
      <p class="small muted" style="margin:6px 0 14px">@tonyshiphoto · ${fmtN(d.totals.posts)} posts, ${fmtN(d.totals.linked)} linked to site photos.
        ${d.since ? `Follower history since ${esc(d.since)} — recorded daily from now on.` : 'Follower history starts today.'} Times are in ${esc(tz)}.</p>
      <div class="row" style="margin-bottom:10px"><span class="spacer"></span>
        <select id="iPer">${[[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last 12 months']].map(([v, l]) => `<option value="${v}"${v === st.period ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="cards">
        <div class="card"><div class="k">Followers</div><div class="v">${k(d.followers)}</div><div class="small muted">${d.followersGain != null ? `${d.followersGain >= 0 ? '+' : ''}${fmtN(d.followersGain)} in ${st.period} days` : 'growth shows as days are recorded'}</div></div>
        <div class="card"><div class="k">Avg likes / post</div><div class="v">${k(r.likes)}</div><div class="small muted">last ${r.n} posts${change != null ? ` · <span class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '▲' : '▼'} ${Math.abs(change)}%</span> vs the 30 before` : ''} · median ${fmtN(Math.round(r.median))}</div></div>
        <div class="card"><div class="k">Avg comments / post</div><div class="v">${r.comments.toFixed(1)}</div><div class="small muted">last ${r.n} posts</div></div>
        <div class="card"><div class="k">Engagement rate</div><div class="v">${r.rate != null ? r.rate.toFixed(2) + '%' : '–'}</div><div class="small muted">(likes + comments) ÷ followers, recent posts · 1–3% is typical</div></div>
        <div class="card"><div class="k">Posted</div><div class="v">${fmtN(d.inPeriod.posts)}</div><div class="small muted">in ${st.period} days · ${fmtN(d.inPeriod.likes)} likes so far</div></div>
        <div class="card"><div class="k">All-time</div><div class="v">${k(d.totals.likes)}</div><div class="small muted">likes · ${fmtN(d.totals.comments)} comments</div></div>
      </div>

      <div class="card" style="margin-top:14px"><strong>Likes per post</strong> <span class="small muted">your last ${d.timeline.length} posts, oldest → newest — hover a bar</span>
        <svg class="sbars" viewBox="0 0 100 150" preserveAspectRatio="none">${d.timeline.map((p, i) => { const W = 100 / d.timeline.length, h = Math.max(.5, p.likes / maxL * 146);
          return `<rect x="${(i * W + W * .12).toFixed(3)}" y="${(150 - h).toFixed(2)}" width="${(W * .76).toFixed(3)}" height="${h.toFixed(2)}"><title>${date(p.ts)}: ${fmtN(p.likes)} likes, ${fmtN(p.comments)} comments</title></rect>`; }).join('')}</svg></div>

      <div class="scols">
        <div class="card"><strong>Best time to post</strong> <span class="small muted">how posts did vs. others of their time (1.0 = typical) · last 2 years</span>
          <table class="heat"><tr><th></th>${H.map(h => `<th>${h}</th>`).join('')}</tr>
          ${WD.map((w, di) => `<tr><th>${w}</th>${H.map((_, hi) => { const c = cell(di, hi); return c ? `<td style="--a:${(c.score / maxS).toFixed(2)}" title="${w} ${H[hi]}: ${c.score.toFixed(2)}× typical over ${c.n} post${c.n === 1 ? '' : 's'}">${c.score.toFixed(1)}</td>` : '<td class="none"></td>'; }).join('')}</tr>`).join('')}</table></div>
        <div class="card"><strong>Kind of post</strong>
          <table class="stbl"><tr><th></th><th class="num">Posts</th><th class="num">Avg likes</th><th class="num">Avg comments</th><th class="num" title="vs. posts around the same time">vs typical</th></tr>
          ${d.kinds.map(x => `<tr><td>${esc(x.k)}</td><td class="num">${fmtN(x.n)}</td><td class="num">${fmtN(x.avgLikes)}</td><td class="num">${x.avgComments}</td><td class="num">${x.rel}×</td></tr>`).join('')}</table>
          ${d.subjects.length ? `<strong style="display:block;margin-top:14px">Subjects that do well</strong><span class="small muted">site tags of the linked photos</span>
          <table class="stbl">${d.subjects.slice(0, 12).map(x => `<tr><td>${esc(x.k)}</td><td>${hbar(x.likes, d.subjects[0].likes)}</td><td class="num">${fmtN(x.likes)} avg</td><td class="num small muted">${x.n} posts</td></tr>`).join('')}</table>` : ''}</div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="row"><strong>Top posts</strong><span class="spacer"></span>
          ${[['likes', 'Likes'], ['comments', 'Comments'], ['rel', 'Beat their time'], ['recent', 'Newest']].map(([x, l]) => `<button class="mini${st.sort === x ? ' primary' : ''}" data-isort="${x}">${l}</button>`).join('')}</div>
        <div id="iTop" class="igtop"></div>
      </div>

      <div class="card" style="margin-top:14px"><strong>Rising</strong> <span class="small muted">likes gained in the last ${st.period} days</span>
        <div class="smovers">${d.rising.length ? d.rising.map(p => `<a class="smv" href="${esc(p.permalink || '#')}" target="_blank" rel="noopener"><img loading="lazy" src="${pic(p)}" alt=""><b>+${fmtN(p.gain)}</b><span class="small muted">${date(p.ts)}</span></a>`).join('') : '<p class="muted small">Shows once there are a couple of days of history.</p>'}</div></div>

      <div class="scols">
        <div class="card"><strong>Hashtags</strong> <span class="small muted">used on 3+ posts · how those posts did vs. typical</span>
          ${d.hashtags.length ? `<table class="stbl">${d.hashtags.slice(0, 25).map(t => `<tr><td>${esc(t.k)}</td><td>${hbar(t.rel, d.hashtags[0].rel)}</td><td class="num">${t.rel}×</td><td class="num small muted">${t.n} posts · ${fmtN(t.avgLikes)} avg ♥</td></tr>`).join('')}</table>` : '<p class="muted small">No hashtag used on 3+ posts.</p>'}</div>
        <div class="card"><strong>Post next</strong> <span class="small muted">your most-loved site photos (Flickr fave rate + popularity) that have never been on Instagram</span>
          <div class="smovers">${d.next.map(p => `<div class="smv" data-open="${esc(p.id)}" title="${esc(p.title || '')}"><img loading="lazy" src="/api/admin/img/${esc(p.id)}/t?v=${p.v || 0}" alt="" data-open="${esc(p.id)}">
            <span class="small muted">♥ ${fmtN(p.faves)} · 👁 ${k(p.views)}${p.getty ? ` · Getty ${p.getty}` : ''}</span></div>`).join('') || '<p class="muted small">Nothing to suggest.</p>'}</div></div>
      </div>`;
    const top = () => {
      const list = [...d.top].sort((a, b) => st.sort === 'recent' ? b.ts - a.ts : (b[st.sort] || 0) - (a[st.sort] || 0)).slice(0, 24);
      $('#iTop').innerHTML = list.map(p => `<a class="igt" href="${esc(p.permalink || '#')}" target="_blank" rel="noopener" title="${esc(p.caption || '')}">
        <img loading="lazy" src="${pic(p)}" alt=""><span><b>♥ ${fmtN(p.likes)}</b> · 💬 ${fmtN(p.comments)}${st.sort === 'rel' ? ` · ${p.rel}×` : ''}</span><span class="small muted">${date(p.ts)}${p.slides > 1 ? ` · ${p.slides} slides` : ''}</span></a>`).join('');
    };
    top();
    view.querySelectorAll('[data-isort]').forEach(b => b.onclick = () => { st.sort = b.dataset.isort; view.querySelectorAll('[data-isort]').forEach(x => x.classList.toggle('primary', x === b)); top(); });
    $('#iPer').onchange = e => { st.period = +e.target.value; run(draw)(); };
    bindSwitch();
  };
  view.onclick = e => { const id = e.target.dataset?.open; if (id) openPhoto(id); };
  await run(draw)();
}
// Flickr | Instagram switch at the top of both stats pages
function switcher(on) {
  return `<div class="row"><h2 style="margin:0">Stats</h2><span class="seg"><a href="#stats" class="${on === 'flickr' ? 'on' : ''}">Flickr</a><a href="#igstats" class="${on === 'ig' ? 'on' : ''}">Instagram</a></span></div>`;
}
function bindSwitch() {}

async function popularityView() {
  const data = await api('/popularity');
  const t = Math.floor(Date.now() / 1000);
  const saved = { ...data.weights };
  const w = { ...data.weights };
  const front = { ...data.front };
  let topN = front.n || 100, onlySite = true;
  const savedRank = new Map();
  const rankBy = weights => data.photos.filter(p => !onlySite || (p.is_public && !p.hidden))
    .map(p => ({ p, s: popScore(p, weights, t) })).sort((a, b) => b.s - a.s);
  const remember = () => { savedRank.clear(); rankBy(saved).forEach((x, i) => savedRank.set(x.p.id, i)); };
  remember();
  const missing = data.photos.filter(p => p.metrics_at == null).length;

  const slider = (k, label, max, step, hint) => `<label class="pslider">
      <span><strong>${label}</strong> <span class="muted small">${hint}</span></span>
      <input type="range" data-w="${k}" min="0" max="${max}" step="${step}" value="${w[k]}">
      <output id="o${k}">${w[k]}</output></label>`;

  view.innerHTML = `
    <h2>How popularity is scored</h2>
    <div class="card">
      <div class="formula">score = ( <b id="fF"></b> × faves + <b id="fV"></b> × views/100 + <b id="fC"></b> × comments ) ÷ ( 1 + years since upload )<sup id="fD"></sup></div>
      <ul class="small muted" style="margin:10px 0 0 18px;padding:0;line-height:1.6">
        <li><strong>Faves</strong> are the strongest signal — someone chose to save the photo.</li>
        <li><strong>Views</strong> count per 100 so they stay comparable with faves (a fave is typically worth ~50–100 views on Flickr).</li>
        <li><strong>Comments</strong> weigh least by default because many are spam or group-invite boilerplate.</li>
        <li><strong>Time discount</strong>: older uploads have had years longer to collect views and faves, so the total is divided by (1 + age)<sup>D</sup>.
          D = 0 is no discount; D = 1 roughly compares "per year"; higher favours recent work. Age is counted from the Flickr upload date, when counting started.</li>
      </ul>
      <div class="sliders">
        ${slider('F', 'Faves', 10, 0.5, 'weight per fave')}
        ${slider('V', 'Views', 10, 0.5, 'weight per 100 views')}
        ${slider('C', 'Comments', 5, 0.25, 'weight per comment')}
        ${slider('D', 'Time discount', 2, 0.05, 'exponent D')}
      </div>
      <div class="row" style="margin-top:12px">
        <button id="pSave" class="primary">Save weights</button>
        <button id="pReset">Reset to defaults</button>
        <span id="pMsg" class="small"></span>
        <span class="spacer"></span>
        <span class="small muted">Scores last saved ${ago(data.computedAt)}${missing ? ` · ${fmtN(missing)} photos still waiting for their counts` : ''}</span>
      </div>
    </div>

    <h2>Photo page</h2>
    <div class="card">
      <div class="row">
        <label><input type="radio" name="fmode" value="weekly" ${front.mode !== 'top' ? 'checked' : ''}> Weekly mix of all public photos</label>
        <label><input type="radio" name="fmode" value="top" ${front.mode === 'top' ? 'checked' : ''}> Only the most popular</label>
        <input id="fN" type="number" min="6" max="500" value="${front.n}" style="width:76px"> photos,
        <select id="fOrder">${[['daily', 're-shuffled daily'], ['shuffle', 're-shuffled weekly'], ['rank', 'in rank order']].map(([v, l]) => `<option value="${v}" ${front.order === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button id="fSave" class="primary">Save</button><span id="fMsg" class="small"></span>
        <span class="spacer"></span><a class="btn" href="/photos" target="_blank" rel="noopener">Open photo page ↗</a>
      </div>
      <p class="small muted" style="margin:8px 0 0">"Most popular" uses the saved weights above. Hidden photos and photos that aren't public on Flickr never appear.</p>
    </div>

    <div class="row" style="margin:22px 0 10px">
      <h2 style="margin:0">Ranking preview</h2>
      <select id="pTop">${[24, 50, 100, 200].map(n => `<option ${n === Math.min(topN, 200) ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label class="small"><input id="pSite" type="checkbox" checked> only photos that can appear on the site</label>
      <span class="spacer"></span><span class="small muted">Arrows show movement vs. the saved weights while you drag.</span>
    </div>
    <div class="pgrid" id="pGrid"></div>`;

  const draw = () => {
    for (const k of ['F', 'V', 'C']) $('#f' + k).textContent = w[k];
    $('#fD').textContent = w.D;
    const ranked = rankBy(w).slice(0, topN);
    $('#pGrid').innerHTML = ranked.map(({ p, s }, i) => {
      const was = savedRank.get(p.id);
      const mv = was === undefined ? '' : was > i ? `<span class="up">▲${was - i}</span>` : was < i ? `<span class="down">▼${i - was}</span>` : '';
      const age = Math.max(0, (t - (p.date_upload || t)) / YEAR);
      const tip = `${p.title || '(untitled)'}\n${w.F}×${p.faves || 0} faves + ${w.V}×${((p.views || 0) / 100).toFixed(1)} + ${w.C}×${p.comments || 0} comments = ${(w.F * (p.faves || 0) + w.V * (p.views || 0) / 100 + w.C * (p.comments || 0)).toFixed(1)}\n÷ (1 + ${age.toFixed(1)} yrs)^${w.D} = ${s.toFixed(2)}`;
      return `<div class="ptile" title="${esc(tip)}" data-id="${p.id}">
        <img loading="lazy" src="/api/admin/img/${p.id}/t" alt="">
        <div class="prank">#${i + 1} ${mv}</div>
        <div class="pmeta"><strong>★ ${s.toFixed(1)}</strong> · ♥ ${fmtN(p.faves)} · 👁 ${fmtN(p.views)} · 💬 ${fmtN(p.comments)} · ${age.toFixed(1)}y</div></div>`;
    }).join('') || '<p class="muted">No photos with counts yet.</p>';
  };
  view.querySelectorAll('[data-w]').forEach(r => r.oninput = () => { w[r.dataset.w] = +r.value; $('#o' + r.dataset.w).textContent = r.value; draw(); });
  $('#pTop').onchange = () => { topN = +$('#pTop').value; draw(); };
  $('#pSite').onchange = () => { onlySite = $('#pSite').checked; remember(); draw(); };
  $('#pGrid').ondblclick = e => { const tile = e.target.closest('.ptile'); if (tile) openPhoto(tile.dataset.id); };
  $('#pReset').onclick = () => {
    Object.assign(w, DEFAULT_W);
    view.querySelectorAll('[data-w]').forEach(r => { r.value = w[r.dataset.w]; $('#o' + r.dataset.w).textContent = r.value; });
    draw();
  };
  $('#pSave').onclick = run(async () => {
    $('#pMsg').textContent = 'Saving and re-scoring…'; $('#pMsg').className = 'small';
    const r = await api('/settings', { method: 'POST', body: { pop_faves: w.F, pop_views: w.V, pop_comments: w.C, pop_decay: w.D } });
    Object.assign(saved, w); remember(); draw();
    $('#pMsg').textContent = `✅ Saved — ${fmtN(r.rescored)} photos re-scored`; $('#pMsg').className = 'small okc';
  });
  $('#fSave').onclick = run(async () => {
    const mode = view.querySelector('input[name=fmode]:checked').value;
    await api('/settings', { method: 'POST', body: { front_mode: mode, front_top_n: +$('#fN').value, front_order: $('#fOrder').value } });
    const ord = { daily: 're-shuffled daily', shuffle: 're-shuffled weekly', rank: 'in rank order' }[$('#fOrder').value];
    $('#fMsg').textContent = mode === 'top' ? `✅ Photo page shows the top ${$('#fN').value}, ${ord}` : '✅ Photo page shows the weekly mix';
    $('#fMsg').className = 'small okc';
  });
  draw();
}

// ---------------- aerial clips ----------------
async function mediaView() {
  const draw = async () => {
    const { clips } = await api('/media');
    const ready = clips.filter(c => c.status === 'ready');
    const stuck = clips.filter(c => c.status !== 'ready');
    const mb = b => b ? (b / 1e6).toFixed(1) + ' MB' : '—';
    view.innerHTML = `
      <div class="row"><h2 style="margin:0">Aerial clips</h2><span class="spacer"></span>
        <a class="btn" href="/aerial" target="_blank" rel="noopener">View page ↗</a></div>
      <div class="card dl">
        <div class="row">
          <div><strong>TSP Uploader for Mac</strong>
            <div class="small muted"><strong>Video</strong>: pick clips, trim visually, compress + upload. <strong>Photos</strong>: download full-size Flickr images on your connection, resize locally, upload.</div></div>
          <span class="spacer"></span>
          <a class="btn primary" href="/admin/downloads/AerialUploader.zip" download>Download the app</a>
        </div>
        <details><summary>First-time setup</summary>
          <ol class="small" style="line-height:1.7;margin:6px 0 0">
            <li>Unzip and drag <strong>Aerial Uploader</strong> to Applications (or anywhere — e.g. your TSP tools folder).</li>
            <li>The first time, <strong>right-click → Open</strong> (it isn't from the App Store, so macOS asks once).
              If macOS says it's damaged, run <code>xattr -dr com.apple.quarantine "/Applications/Aerial Uploader.app"</code> in Terminal.</li>
            <li>It needs Node.js and ffmpeg — if they're missing it tells you, with a Copy command button for <code>brew install node ffmpeg</code>.</li>
            <li>Create an upload token in <a href="#settings">Settings → Upload tokens</a> and paste it when the app asks.</li>
          </ol></details>
      </div>
      <div class="row" style="margin:14px 0 8px">
        <p class="muted small" style="margin:0">Videos and photo slides play in this order, crossfading, on a loop. Hover a clip to preview it.
          Leave the headline empty to use the default for its kind.</p>
        <span class="spacer"></span><button id="addPhotos" class="primary">+ Add photos</button>
      </div>
      <div class="tblwrap"><table>
        <tr><th></th><th>Item</th><th>Length</th><th>Overlay message</th><th>On page</th><th></th></tr>
        ${ready.map((c, i) => `<tr data-id="${c.id}">
          <td>${c.kind === 'photo'
            ? `<img class="clipprev" src="/api/admin/img/${c.photo_id}/t" alt="" loading="lazy">`
            : `<video class="clipprev" muted loop playsinline preload="none" poster="${c.urls.poster}" src="${c.urls.mobile || c.urls.desktop}"></video>`}</td>
          <td><input class="ctitle" value="${esc(c.title)}" placeholder="(untitled)">
            <div class="small muted">${c.kind === 'photo' ? `📷 photo slide · <a href="#organizer?q=${c.photo_id}">${c.photo_id}</a>` : `🎬 ${esc(c.source_name)} · ${mb(c.desktop_bytes)} · mobile ${mb(c.mobile_bytes)}`} · added ${ago(c.created_at)}</div>
            ${c.kind === 'photo' && !c.photo_visible ? '<div class="small err">Not shown: this photo is private on Flickr, hidden, or not stored yet.</div>' : ''}</td>
          <td>${c.kind === 'photo'
            ? `<select class="cdur">${[4, 5, 6, 7, 8, 10, 12, 15].map(n => `<option value="${n}" ${Math.round(c.duration || 7) === n ? 'selected' : ''}>${n} s</option>`).join('')}</select>`
            : (c.duration ? c.duration.toFixed(1) + ' s' : '—')}</td>
          <td><select class="cov" title="Which message shows over this item">${[['auto', c.kind === 'photo' ? 'Auto (alternates brand / prints)' : 'Auto (licensing pitch)'], ['licensing', 'Licensing pitch'], ['brand', 'Brand visuals'], ['prints', 'Prints & wall art']]
              .map(([v, l]) => `<option value="${v}" ${(c.overlay || 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <input class="ccap" value="${esc(c.caption || '')}" placeholder="Headline (optional — default for the message)" style="margin-top:4px"></td>
          <td><label><input type="checkbox" class="cen" ${c.enabled ? 'checked' : ''}> show</label></td>
          <td><div class="row">
            <button class="cup" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
            <button class="cdown" ${i === ready.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
            <button class="danger cdel">Delete</button></div></td></tr>`).join('')
          || '<tr><td colspan="6" class="muted">Nothing yet — upload clips with the TSP Uploader, or add photos.</td></tr>'}
      </table></div>
      ${stuck.length ? `<h2>Unfinished uploads</h2><p class="small muted">Uploads that never completed. Re-run the upload, or delete them.</p>
        <div class="tblwrap"><table>${stuck.map(c => `<tr data-id="${c.id}"><td>${esc(c.title || c.source_name)}</td><td class="small muted">${ago(c.created_at)}</td>
          <td><button class="danger cdel">Delete</button></td></tr>`).join('')}</table></div>` : ''}`;

    view.querySelectorAll('video.clipprev').forEach(v => {
      v.onmouseenter = () => v.play().catch(() => {});
      v.onmouseleave = () => { v.pause(); };
    });
    const idOf = el => el.closest('tr').dataset.id;
    view.querySelectorAll('.ctitle').forEach(inp => inp.onchange = run(async () => {
      await api('/media/' + idOf(inp), { method: 'PATCH', body: { title: inp.value } }); toast('Saved');
    }));
    view.querySelectorAll('.ccap').forEach(inp => inp.onchange = run(async () => {
      await api('/media/' + idOf(inp), { method: 'PATCH', body: { caption: inp.value.trim() } }); toast(inp.value.trim() ? 'Headline saved' : 'Using the default headline');
    }));
    view.querySelectorAll('.cov').forEach(sel => sel.onchange = run(async () => {
      await api('/media/' + idOf(sel), { method: 'PATCH', body: { overlay: sel.value } }); toast('Overlay message saved');
    }));
    view.querySelectorAll('.cdur').forEach(sel => sel.onchange = run(async () => {
      await api('/media/' + idOf(sel), { method: 'PATCH', body: { duration: +sel.value } }); toast(`Shows for ${sel.value} s`);
    }));
    $('#addPhotos').onclick = () => photoPicker(draw);
    view.querySelectorAll('.cen').forEach(cb => cb.onchange = run(async () => {
      await api('/media/' + idOf(cb), { method: 'PATCH', body: { enabled: cb.checked } });
      toast(cb.checked ? 'Shown on the Aerial page' : 'Hidden from the Aerial page');
    }));
    const move = d => run(async e => {
      const ids = ready.map(c => c.id), k = ids.indexOf(idOf(e.target));
      [ids[k], ids[k + d]] = [ids[k + d], ids[k]];
      await api('/media/order', { method: 'POST', body: { ids } }); draw();
    });
    view.querySelectorAll('.cup').forEach(bt => bt.onclick = move(-1));
    view.querySelectorAll('.cdown').forEach(bt => bt.onclick = move(1));
    view.querySelectorAll('.cdel').forEach(bt => bt.onclick = run(async () => {
      if (!confirm('Remove this from the reel? (Video clips: their files are deleted too. Photos stay in your catalog.)')) return;
      await api('/media/' + idOf(bt), { method: 'DELETE' }); toast('Deleted'); draw();
    }));
  };
  await run(draw)();
}

// ---------------- photo picker for the Aerial reel ----------------
async function photoPicker(done) {
  const picked = new Set();
  drawer.innerHTML = `
    <div class="row"><strong>Add photos to the Aerial reel</strong><span class="spacer"></span><button id="ppClose">Close</button></div>
    <p class="small muted">Only public, stored photos can appear on the site. Tip: pick wide, striking shots — they fill the whole window.</p>
    <div class="row"><input id="ppQ" type="search" placeholder="Search title, tags, place" style="flex:1">
      <select id="ppSort"><option value="popular">Most popular</option><option value="upload">Newest</option></select></div>
    <div class="grid" id="ppGrid" style="margin-top:10px;grid-template-columns:repeat(auto-fill,minmax(110px,1fr))"></div>
    <div class="row" style="position:sticky;bottom:0;background:var(--panel);padding:10px 0"><span id="ppN" class="small muted">0 selected</span><span class="spacer"></span>
      <button id="ppAdd" class="primary" disabled>Add to reel</button></div>`;
  drawer.hidden = false;
  const load = run(async () => {
    const q = new URLSearchParams({ status: 'ok', vis: 'public', sort: $('#ppSort').value, limit: 120 });
    if ($('#ppQ').value.trim()) q.set('q', $('#ppQ').value.trim());
    const { photos } = await api('/photos?' + q);
    $('#ppGrid').innerHTML = photos.filter(p => !p.hidden).map(p => `<div class="tile ${picked.has(p.id) ? 'sel' : ''}" data-id="${p.id}" title="${esc(p.title)}">
      <img loading="lazy" src="/api/admin/img/${p.id}/t?v=${p.synced_at || 0}" alt=""></div>`).join('') || '<p class="muted">No matches.</p>';
  });
  let deb; $('#ppQ').oninput = () => { clearTimeout(deb); deb = setTimeout(load, 300); };
  $('#ppSort').onchange = load;
  $('#ppGrid').onclick = e => {
    const t = e.target.closest('.tile'); if (!t) return;
    picked.has(t.dataset.id) ? picked.delete(t.dataset.id) : picked.add(t.dataset.id);
    t.classList.toggle('sel'); $('#ppN').textContent = `${picked.size} selected`; $('#ppAdd').disabled = !picked.size;
  };
  $('#ppClose').onclick = closeDrawer;
  $('#ppAdd').onclick = run(async () => {
    const r = await api('/media/photos', { method: 'POST', body: { ids: [...picked] } });
    toast(`Added ${r.added} photo slide(s) at the end of the reel`); closeDrawer(); done?.();
  });
  await load();
}

// ---------------- Getty Images ----------------
const usd = n => '$' + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthName = ym => ym ? new Date(ym + '-15').toLocaleString(undefined, { month: 'short', year: 'numeric' }) : '—';

// ---------------- Getty ↔ site photos (matching review) ----------------
async function gettyMatchView(params) {
  let view0 = params?.get?.('view') || 'review', offset = 0, q = '';
  const thumb = p => `/api/admin/img/${p.photo_id}/t?v=${p.v || 0}`;
  const draw = async () => {
    const st = await api('/getty/match/status'), c = st.counts;
    if (!c.portfolio) {
      view.innerHTML = `<h2>Getty ↔ photos</h2><div class="callout">Import your portfolio first: <a href="#getty">Getty</a> → <b>Import portfolio</b> (DeepMeta → Portfolio → Export whole Portfolio).</div>`;
      return;
    }
    const tabs = [['review', 'To review', c.review], ['matched', 'Linked', c.matched], ['unmatched', 'Not on the site', c.unmatched], ['unchecked', 'Not checked yet', c.unchecked]];
    const by = st.confirmedBy;
    view.innerHTML = `
      <div class="row"><h2 style="margin:0">Getty ↔ photos</h2><span class="spacer"></span>
        <input id="gmQ" type="search" placeholder="Search title, keywords, file name, place, asset ID…" style="width:min(340px,100%)" value="${esc(q)}"></div>
      <div class="cards" style="margin:14px 0">
        <div class="card"><div class="k">Getty photos</div><div class="v">${fmtN(c.assets)}</div><div class="small muted">in your portfolio · ${fmtN(c.videos)} videos not matched · ${fmtN(c.sold)} have sold</div></div>
        <div class="card"><div class="k">Linked to a site photo</div><div class="v">${fmtN(c.matched)}</div><div class="small muted">${fmtN(by.filename || 0)} by file name · ${fmtN(by.you || 0)} by you · rest by the matcher</div></div>
        <div class="card"><div class="k">To review</div><div class="v ${c.review ? 'warn' : ''}">${fmtN(c.review)}</div><div class="small muted">near-duplicates / unsure</div></div>
        <div class="card"><div class="k">Not checked yet</div><div class="v">${fmtN(c.unchecked)}</div><div class="small muted">run <b>TSP Uploader → 📷 Matching → Match Getty</b> on the Mac Studio</div></div>
      </div>
      <div class="row">${tabs.map(([k, l, n]) => `<button class="${k === view0 ? 'primary' : ''}" data-v="${k}">${l} <span class="pill">${fmtN(n)}</span></button>`).join('')}</div>
      <div id="gmList" class="iglist"><p class="muted">Loading…</p></div>
      <div class="row" style="margin-top:12px"><button id="gmMore" hidden>More</button></div>`;
    view.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { view0 = b.dataset.v; offset = 0; history.replaceState(null, '', '#gettymatch?view=' + view0); draw(); });
    let t; $('#gmQ').oninput = e => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); offset = 0; run(() => load(false))(); }, 300); };
    await load(false);
  };
  const row = a => {
    const img = a.thumb_url ? `<img loading="lazy" src="${esc(a.thumb_url)}" alt="" referrerpolicy="no-referrer">` : '<div class="small muted" style="padding:30px 0;text-align:center">preview not fetched yet</div>';
    const cands = a.candidates.map(p => `
      <div class="igc ${p.status}">
        <img loading="lazy" src="${thumb(p)}" alt="" data-open="${esc(p.photo_id)}">
        <div class="small"><b>${esc(p.title || p.photo_id)}</b><div class="muted">${p.status === 'confirmed' ? `✓ ${p.how === 'filename' ? 'file name' : 'confirmed'}` : p.status === 'auto' ? 'auto-matched' : 'candidate'}
          ${p.inliers ? ` · ${fmtN(p.inliers)} matching points` : ''}${p.cos ? ` · look-alike ${Math.round(p.cos * 100)}%` : ''}</div></div>
        <div class="row">${p.status !== 'confirmed' ? `<button class="mini primary" data-ok="${esc(p.photo_id)}">✓ This one</button>` : ''}
          <button class="mini" data-no="${esc(p.photo_id)}">✕ Not it</button></div>
      </div>`).join('');
    return `<div class="igrow" data-ig="${esc(a.asset_id)}">
      <div class="igm"><a href="${esc(a.page_url || 'https://www.gettyimages.com/detail/' + a.asset_id)}" target="_blank" rel="noopener">${img}</a>
        <div class="small"><b>${esc(a.title || '')}</b> <span class="muted">· ${esc(a.asset_id)}${a.artist ? ` · ${esc(a.artist)}` : ''}</span>
          <div class="muted">${esc([a.city, a.state, a.country].filter(Boolean).join(', '))}${a.created_on ? ` · ${esc(a.created_on)}` : ''} · ${esc(a.collection || '')}${a.sales ? ` · ${fmtN(a.sales)} sale${a.sales === 1 ? '' : 's'}` : ''}</div>
          <div class="muted">${esc(a.object_name || '')}</div></div></div>
      <div class="igcs">${cands || `<span class="small muted">${a.matched_at ? 'No look-alike on the site.' : 'Not checked yet.'}</span>`}</div>
      <div class="igact"><button class="mini" data-pick>🔍 Link a photo…</button>${a.candidates.length && view0 !== 'matched' ? '<button class="mini" data-none>None of these</button>' : ''}${a.matched_at ? '<button class="mini" data-reset title="Forget the matcher’s guesses and your decisions for this asset; it gets checked again next run">Re-check</button>' : ''}</div>
      <div class="igpick" hidden><div class="row"><input class="igq" type="search" placeholder="Search title, tags, place or photo ID…" autocomplete="off" spellcheck="false" value="${esc((a.title || '').split(/\s+/).slice(0, 3).join(' '))}">
        <span class="small muted igqn"></span></div><div class="igres"></div></div>
    </div>`;
  };
  const load = async more => {
    const d = await api(`/getty/match/list?view=${view0}&offset=${offset}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    const box = $('#gmList');
    if (!more) box.innerHTML = '';
    box.insertAdjacentHTML('beforeend', d.items.map(row).join('') || (more ? '' : `<p class="muted">${{ review: 'Nothing to review 🎉', matched: 'Nothing linked yet.', unmatched: 'Every checked asset found its photo.', unchecked: 'Everything has been checked.' }[view0]}</p>`));
    $('#gmMore').hidden = d.items.length < 60;
    $('#gmMore').onclick = run(async () => { offset += 60; await load(true); });
  };
  const pickSearch = async rowEl => {
    const qq = rowEl.querySelector('.igq').value.trim(), res = rowEl.querySelector('.igres'), seq = (rowEl._seq = (rowEl._seq || 0) + 1);
    const d = await api(`/photos?status=ok&sort=popular&limit=30${qq ? `&q=${encodeURIComponent(qq)}` : ''}`);
    if (seq !== rowEl._seq) return;
    rowEl.querySelector('.igqn').textContent = `${fmtN(d.total)} photo${d.total === 1 ? '' : 's'}${d.total > 30 ? ' — showing the 30 most popular' : ''}`;
    res.innerHTML = d.photos.map(p => `<button class="igp" data-link="${esc(p.id)}" title="${esc(p.title || p.id)} — click to link">
        <img loading="lazy" src="/api/admin/img/${esc(p.id)}/t" alt=""><span class="small">${esc((p.title || p.id).slice(0, 40))}</span></button>`).join('') || '<p class="small muted">No photos match.</p>';
  };
  view.oninput = e => {
    const rowEl = e.target.classList.contains('igq') && e.target.closest('[data-ig]');
    if (!rowEl) return;
    clearTimeout(rowEl._t); rowEl._t = setTimeout(() => run(() => pickSearch(rowEl))(), 250);
  };
  view.onclick = run(async e => {
    const b = e.target.closest('button'), rowEl = e.target.closest('[data-ig]');
    if (e.target.dataset.open) return openPhoto(e.target.dataset.open);
    if (!b || !rowEl) return;
    const asset_id = rowEl.dataset.ig;
    if (b.hasAttribute('data-pick')) {
      const pk = rowEl.querySelector('.igpick'); pk.hidden = !pk.hidden;
      if (!pk.hidden) { rowEl.querySelector('.igq').focus(); if (!rowEl.querySelector('.igres').childElementCount) await pickSearch(rowEl); }
      return;
    }
    const act = b.dataset.link ? { action: 'confirm', photo_id: b.dataset.link } : b.dataset.ok ? { action: 'confirm', photo_id: b.dataset.ok }
      : b.dataset.no ? { action: 'reject', photo_id: b.dataset.no } : b.hasAttribute('data-none') ? { action: 'none' } : b.hasAttribute('data-reset') ? { action: 'reset' } : null;
    if (!act) return;
    await api('/getty/match/decide', { method: 'POST', body: { asset_id, ...act } });
    if (b.dataset.link) toast('Linked');
    rowEl.classList.add('done'); setTimeout(() => rowEl.remove(), 250);
  });
  await run(draw)();
}

async function gettyView() {
  const opts = { period: 'all', sort: 'royalty', limit: 100 };
  const draw = async () => {
    const s = await api('/getty/summary');
    const t = s.totals;
    const maxY = Math.max(1, ...s.years.map(y => y.royalty));
    const bd = (title, rows) => `<div class="card"><div class="k">${title}</div>
      ${rows.map(r => `<div class="row small" style="gap:6px"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.k || '—')}</span>
        <span class="muted">${fmtN(r.n)}</span><strong style="min-width:76px;text-align:right">${usd(r.royalty)}</strong></div>`).join('')}</div>`;
    view.innerHTML = `
      <div class="row"><h2 style="margin:0">Getty Images</h2><span class="spacer"></span>
        <span class="small muted">${s.imports.files ? `${fmtN(s.imports.files)} monthly statements · ${monthName(s.imports.first)} – ${monthName(s.imports.last)}` : 'No statements imported yet'}</span></div>

      <div class="card gdrop" id="gDrop" style="margin-top:12px">
        <div class="row">
          <div><strong>Import statements</strong>
            <div class="small muted">Drop the monthly export files here (Getty → Account Management → Royalties → Export, the .txt files) — or a whole folder.
              Re-importing a month replaces it, so dropping everything again is safe.</div></div>
          <span class="spacer"></span>
          <label class="btn">Choose files<input type="file" id="gFiles" multiple accept=".txt,.csv,.tsv" hidden></label>
          <label class="btn">Choose folder<input type="file" id="gDir" webkitdirectory hidden></label>
        </div>
        <div class="bar" id="gBar" hidden style="margin-top:12px"><i style="width:0"></i></div>
        <div class="small" id="gMsg" style="margin-top:6px"></div>
      </div>

      <div class="card gdrop" id="pDrop" style="margin-top:12px">
        <div class="row">
          <div><strong>Import portfolio</strong>
            <div class="small muted">Drop DeepMeta's <i>Portfolio → Export whole Portfolio</i> CSV here — every asset you have on Getty, sold or not.
              Drop the whole export every time: unchanged assets are skipped, new ones are added and queued for matching, missing ones are marked as gone (never deleted).</div>
            <div class="small" id="pInfo" style="margin-top:6px"></div></div>
          <span class="spacer"></span>
          <label class="btn">Choose CSV<input type="file" id="pFile" accept=".csv" hidden></label>
          <a class="btn" href="#gettymatch">Getty ↔ photos →</a>
        </div>
      </div>

      ${t.licenses ? `
      <div class="cards" style="margin-top:14px">
        <div class="card"><div class="k">Royalties (all time)</div><div class="v">${usd(t.royalty)}</div><div class="small muted">from ${usd(t.fees)} in license fees</div></div>
        <div class="card"><div class="k">Licenses</div><div class="v">${fmtN(t.licenses)}</div><div class="small muted">avg ${usd(t.royalty / t.licenses)} each</div></div>
        <div class="card"><div class="k">Assets that sold</div><div class="v">${fmtN(t.assets)}</div></div>
        <div class="card"><div class="k">Coverage</div><div class="v" style="font-size:18px">${monthName(t.first)} – ${monthName(t.last)}</div></div>
      </div>
      <h2>By year</h2>
      <div class="card ychart">${s.years.map(y => `<div class="yb" title="${y.y}: ${usd(y.royalty)} · ${fmtN(y.licenses)} licenses · ${fmtN(y.assets)} assets">
        <span class="yv">${usd(y.royalty).replace(/\.\d+$/, '')}</span><i style="height:${Math.max(2, y.royalty / maxY * 140)}px"></i><span class="yl">${y.y}</span></div>`).join('')}</div>
      <div class="cards" style="margin-top:14px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">
        ${bd('Collections', s.breakdown.collection)}${bd('License types', s.breakdown.product)}${bd('Where buyers are', s.breakdown.territory)}${bd('Sold through', s.breakdown.site)}
      </div>

      <div class="row" style="margin:24px 0 10px">
        <h2 style="margin:0">Most popular assets</h2>
        <select id="gPeriod">${[['all', 'All time'], ['5y', 'Last 5 years'], ['2y', 'Last 2 years'], ['12m', 'Last 12 months']].map(([v, l]) => `<option value="${v}" ${opts.period === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="gSort">${[['royalty', 'by royalties'], ['licenses', 'by number of licenses'], ['recent', 'most recently sold']].map(([v, l]) => `<option value="${v}" ${opts.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="gLimit">${[50, 100, 200, 500].map(n => `<option ${opts.limit === n ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <span class="spacer"></span>
        <span class="small muted" id="gPrev"></span>
      </div>
      <div id="gList"><p class="muted">Loading…</p></div>

` : '<p class="muted" style="margin-top:16px">Import your statements to see what sells.</p>'}`;

    const importFiles = run(async list => {
      const files = [...list].filter(f => /\.(txt|csv|tsv)$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
      if (!files.length) return toast('No statement files (.txt) found', true);
      const bar = $('#gBar'), msg = $('#gMsg');
      bar.hidden = false;
      let ok = 0, sales = 0; const errs = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        msg.textContent = `Importing ${i + 1} of ${files.length} — ${f.name}`;
        try { const r = await api('/getty/import', { method: 'POST', body: { file: f.name, text: await f.text() } }); ok++; sales += r.months.reduce((a, m) => a + m.rows, 0); }
        catch (e) { errs.push(e.message); }
        bar.querySelector('i').style.width = `${(i + 1) / files.length * 100}%`;
      }
      msg.innerHTML = `✅ Imported ${fmtN(ok)} statement(s), ${fmtN(sales)} sales${errs.length ? ` · <span class="err">${errs.length} skipped: ${esc(errs.slice(0, 3).join('; '))}</span>` : ''}`;
      setTimeout(draw, 800);
    });
    const showPortfolio = async () => {
      const st = await api('/getty/match/status').catch(() => null);
      if (!st) return;
      const c = st.counts, last = st.imports[0];
      $('#pInfo').innerHTML = c.portfolio ? `<b>${fmtN(c.portfolio)}</b> assets in your portfolio (${fmtN(c.videos)} videos${c.gone ? `, ${fmtN(c.gone)} gone since` : ''}) ·
        <b>${fmtN(c.matched)}</b> linked to a site photo · ${fmtN(c.review)} to review · ${fmtN(c.unchecked)} not checked yet
        ${last ? `<span class="muted"> · last import ${ago(last.at)}</span>` : ''}` : '<span class="muted">No portfolio imported yet.</span>';
    };
    const importPortfolio = run(async f => {
      if (!f) return;
      $('#pInfo').textContent = `Importing ${f.name}…`;
      const r = await api('/getty/portfolio/import', { method: 'POST', body: { file: f.name, text: await f.text() } });
      toast(`${fmtN(r.rows)} assets: ${fmtN(r.added)} new · ${fmtN(r.updated)} changed · ${fmtN(r.unchanged)} unchanged${r.gone ? ` · ${fmtN(r.gone)} gone` : ''}${r.back ? ` · ${fmtN(r.back)} back` : ''}`);
      if (r.note) toast(r.note, true);
      await showPortfolio();
    });
    $('#pFile').onchange = e => importPortfolio(e.target.files[0]);
    const pd = $('#pDrop');
    pd.ondragover = e => { e.preventDefault(); pd.classList.add('over'); };
    pd.ondragleave = () => pd.classList.remove('over');
    pd.ondrop = e => { e.preventDefault(); e.stopPropagation(); pd.classList.remove('over'); importPortfolio([...e.dataTransfer.files].find(f => /\.csv$/i.test(f.name))); };
    showPortfolio();
    $('#gFiles').onchange = e => importFiles(e.target.files);
    $('#gDir').onchange = e => importFiles(e.target.files);
    const drop = $('#gDrop');
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = async e => {
      e.preventDefault(); drop.classList.remove('over');
      // folders dropped in: walk them
      const out = [];
      const walk = async entry => {
        if (entry.isFile) out.push(await new Promise(r => entry.file(r)));
        else if (entry.isDirectory) {
          const rd = entry.createReader();
          for (;;) { const batch = await new Promise(r => rd.readEntries(r)); if (!batch.length) break; for (const x of batch) await walk(x); }
        }
      };
      const items = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
      if (items.length) { for (const it of items) await walk(it); importFiles(out); } else importFiles(e.dataTransfer.files);
    };
    if (!t.licenses) return;
    ['gPeriod', 'gSort', 'gLimit'].forEach(id => $('#' + id).onchange = () => {
      opts.period = $('#gPeriod').value; opts.sort = $('#gSort').value; opts.limit = +$('#gLimit').value; list();
    });
    list();
  };
  const list = run(async () => {
    const d = await api(`/getty/assets?period=${opts.period}&sort=${opts.sort}&limit=${opts.limit}`);
    const years = [...new Set(d.assets.flatMap(a => Object.keys(a.trend)))].sort();
    const ys = years.length ? years.slice(-10) : [];
    $('#gList').innerHTML = `<div class="tblwrap"><table class="gtable">
      <tr><th>#</th><th></th><th>Asset</th><th>Licenses</th><th>Royalties</th><th>Per license</th><th>Last sold</th><th title="Royalties per year, last ${ys.length} years">Trend</th></tr>
      ${d.assets.map((a, i) => {
        const tmax = Math.max(0.01, ...ys.map(y => a.trend[y] || 0));
        return `<tr>
        <td class="muted">${i + 1}</td>
        <td>${a.thumb ? (a.thumb_source === 'flickr'
            ? `<a href="#organizer?q=${a.flickr_id}"><img class="gthumb" src="${esc(a.thumb)}" ${a.thumb_fallback ? `data-fb="${esc(a.thumb_fallback)}"` : ''} loading="lazy" alt=""></a>
               <div class="small muted" title="Getty no longer shows this asset; image from the exact-linked Flickr photo">via Flickr</div>`
            : `<a href="${a.getty_url}" target="_blank" rel="noopener"><img class="gthumb" src="${esc(a.thumb)}" loading="lazy" alt=""></a>`)
          : '<div class="gthumb none">no preview</div>'}</td>
        <td><strong>${esc(a.title || '(untitled)')}</strong>
          ${a.caption ? `<div class="small" style="max-width:420px">${esc(a.caption)}</div>` : ''}
          <div class="small muted">${esc(a.alt_name || '')} · ${esc(a.collection || '')}</div>
          <div class="small"><a href="${a.getty_url}" target="_blank" rel="noopener">${a.asset_id} on Getty ↗</a>${
            a.flickr_match === 'manual' ? ` · <a href="#organizer?q=${a.flickr_id}">✓ linked by you</a> <button class="linkbtn" data-link="${a.asset_id}" data-title="${esc(a.title || '')}">change</button> <button class="linkbtn" data-unlink="${a.asset_id}">unlink</button>`
            : a.flickr_match === 'matched' ? ` · <a href="#organizer?q=${a.flickr_id}" title="Linked by the matcher or a file name — review in Getty ↔ photos">✓ matched photo</a>`
            : a.flickr_match === 'id' ? (a.flickr_id
              ? ` · <a href="#organizer?q=${a.flickr_id}" title="Getty recorded this Flickr photo ID — exact match">✓ your Flickr photo</a>`
              : ` · <a href="${a.flickr_url}" target="_blank" rel="noopener" title="Getty recorded this Flickr photo ID; it isn't in your synced catalog">Flickr ${a.flickr_url.split('=')[1]} ↗</a>`)
            : a.flickr_match === 'filename' ? ` · <a href="#organizer?q=${a.flickr_id}" title="Flickr photo whose title is still this file name">on Flickr (file name)</a>` : ''}${
            a.flickr_match !== 'id' && a.flickr_match !== 'manual' ? ` <button class="linkbtn" data-link="${a.asset_id}" data-title="${esc(a.title || '')}" title="Pick the Flickr photo this asset is">🔗 Link</button>` : ''}</div></td>
        <td>${fmtN(a.licenses)}</td>
        <td><strong>${usd(a.royalty)}</strong></td>
        <td class="muted">${usd(a.royalty / a.licenses)}</td>
        <td class="small">${esc(a.last_sale)}</td>
        <td><div class="spark">${ys.map(y => `<i title="${y}: ${usd(a.trend[y] || 0)}" style="height:${Math.max(1, (a.trend[y] || 0) / tmax * 26)}px"></i>`).join('')}</div></td></tr>`;
      }).join('')}</table></div>`;
    $('#gList').querySelectorAll('[data-link]').forEach(b => b.onclick = () => linkPicker(b.dataset.link, b.dataset.title, list));
    $('#gList').querySelectorAll('[data-unlink]').forEach(b => b.onclick = run(async () => {
      await api('/getty/link', { method: 'POST', body: { asset_id: b.dataset.unlink, photo_id: null } }); toast('Unlinked'); list();
    }));
    $('#gList').querySelectorAll('img.gthumb').forEach(img => {
      img.onerror = () => {
        const fb = img.dataset.fb;
        if (fb && img.src !== fb) { img.removeAttribute('data-fb'); img.src = fb; return; }
        img.onerror = null; img.replaceWith(Object.assign(document.createElement('div'), { className: 'gthumb none', textContent: 'no preview' }));
      };
    });
    if (!previewsRunning) loadPreviews();
  });
  // Getty's own thumbnails, fetched in the background (best sellers first) and kept for next time
  let previewsRunning = false;
  const loadPreviews = async () => {
    previewsRunning = true;
    const msg = $('#gPrev');
    try {
      for (let round = 0; round < 40 && document.body.contains(msg); round++) {
        const r = await api('/getty/previews?limit=40', { method: 'POST' });
        if (r.blocked) { msg.innerHTML = `<span class="err">Getty didn't hand out previews to the site (${esc(r.errorSample || 'refused')}). Links to Getty still work.</span>`; break; }
        if (r.fetched || r.missing) list();
        if (!r.remaining) { msg.textContent = ''; break; }
        msg.textContent = `Loading Getty previews… ${fmtN(r.remaining)} to go`;
      }
    } catch (e) { msg.textContent = e.message; }
    previewsRunning = false;
  };
  await run(draw)();
}

// small search window: type a keyword, pick the Flickr photo this Getty asset is
function linkPicker(assetId, title, done) {
  const wrap = document.createElement('div');
  wrap.className = 'lp-wrap';
  wrap.innerHTML = `<div class="lp" role="dialog" aria-label="Link to a Flickr photo">
      <div class="row"><strong>Link Getty ${esc(assetId)}</strong><span class="small muted" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">“${esc(title)}”</span><button class="x" id="lpX">×</button></div>
      <input id="lpQ" type="search" placeholder="Keyword, e.g. Flatiron" value="${esc(title.split(/[,–—-]/)[0].trim())}" autocomplete="off">
      <div class="lp-grid" id="lpGrid"><p class="muted small">Searching…</p></div>
      <div class="small muted">Click the photo that is this asset.</div></div>`;
  document.body.append(wrap);
  const close = () => wrap.remove();
  wrap.onclick = e => { if (e.target === wrap) close(); };
  wrap.querySelector('#lpX').onclick = close;
  document.addEventListener('keydown', function esc1(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc1); } });
  const q = wrap.querySelector('#lpQ'), grid = wrap.querySelector('#lpGrid');
  const search = async () => {
    const term = q.value.trim();
    if (term.length < 2) { grid.innerHTML = '<p class="muted small">Type at least 2 letters.</p>'; return; }
    try {
      const { photos, total } = await api(`/photos?q=${encodeURIComponent(term)}&sort=popular&limit=60`);
      grid.innerHTML = photos.map(p => `<button class="lp-it" data-id="${p.id}" title="${esc(p.title)} · ${p.id}">
          <img src="${p.status === 'ok' || p.status === 'meta' ? `/api/admin/img/${p.id}/t?v=${p.synced_at || 0}` : flickrThumb(p)}" data-fb="${flickrThumb(p)}" loading="lazy" alt="">
          <span>${esc(p.title || '(untitled)')}</span></button>`).join('')
        + (total > photos.length ? `<p class="muted small" style="grid-column:1/-1">${fmtN(total - photos.length)} more — try a more specific word.</p>` : '')
        || '<p class="muted small">No photos match.</p>';
      grid.querySelectorAll('img[data-fb]').forEach(img => { img.onerror = () => { img.onerror = null; if (img.dataset.fb) img.src = img.dataset.fb; }; });
      grid.querySelectorAll('.lp-it').forEach(b => b.onclick = run(async () => {
        await api('/getty/link', { method: 'POST', body: { asset_id: assetId, photo_id: b.dataset.id } });
        toast('Linked'); close(); done?.();
      }));
    } catch (e) { grid.innerHTML = `<p class="err small">${esc(e.message)}</p>`; }
  };
  let t; q.oninput = () => { clearTimeout(t); t = setTimeout(search, 300); };
  q.focus(); q.select();
  search();
}

// ---------------- settings ----------------
async function settings() {
  const s = await api('/status');
  const st = s.settings, c = s.config;
  const ck = (ok, label, hint) => `<div>${ok ? '✅' : '⚠️'} ${label}${ok ? '' : ` <span class="small muted">— ${hint}</span>`}</div>`;
  view.innerHTML = `
    <h2>Home page</h2>
    <div class="card row">
      <span>When someone opens <code>${esc(location.origin)}/</code> they see</span>
      <select id="homePage">
        <option value="photos" ${st.home_page !== 'aerial' ? 'selected' : ''}>Photos (the photo grid)</option>
        <option value="aerial" ${st.home_page === 'aerial' ? 'selected' : ''}>Aerial (the video)</option>
      </select>
      <span id="homeMsg" class="small"></span>
      <span class="spacer"></span><a class="btn" href="/" target="_blank" rel="noopener">Open home ↗</a>
    </div>

    <h2>1 · Flickr API key</h2>
    ${c.apiKey && c.apiSecretSaved ? `
      <div class="card" id="keyStatus">
        <div><strong>✅ Saved</strong> <span class="small muted">${date(c.apiKeySavedAt)}</span></div>
        <dl class="kv">
          <dt>API key</dt><dd><code>${esc(c.apiKey)}</code></dd>
          <dt>API secret</dt><dd>•••••••••••••••• <span class="small muted">(stored encrypted, never shown)</span></dd>
          <dt>Callback URL</dt><dd><code>${esc(c.callbackUrl)}</code> <span class="small muted">— must match your Flickr app</span></dd>
        </dl>
        <button id="replaceKey">Replace key</button>
      </div>` : `
      <p class="muted small">Create an app at <a href="https://www.flickr.com/services/apps/create/" target="_blank" rel="noopener">flickr.com/services/apps/create</a>
        (non-commercial key) and set its callback URL to <code>${esc(c.callbackUrl)}</code>. One key covers all your Flickr accounts.</p>`}
    <form id="fk" class="form" ${c.apiKey && c.apiSecretSaved ? 'hidden' : ''}>
      <label for="key">API key</label><input id="key" autocomplete="off" spellcheck="false" placeholder="32 hex characters">
      <label for="secret">API secret</label><input id="secret" autocomplete="off" spellcheck="false" placeholder="16 hex characters">
      <span></span><div class="row"><button class="primary" id="saveKey">Save key</button><span id="keyMsg" class="small"></span></div>
    </form>

    <h2>2 · Connect Flickr accounts</h2>
    ${!(c.apiKey && c.apiSecretSaved) ? '<p class="muted">Save the API key first.</p>' : `
      <div class="card">
        ${s.accounts.length ? s.accounts.map(a => `<div style="margin-bottom:6px">✅ <strong>${esc(a.realname || a.username)}</strong>
            <span class="small muted">${esc(a.username)} · ${a.flickr_count != null ? fmtN(a.flickr_count) + ' items on Flickr' : 'counting…'} · ${esc(a.phase_detail)}</span></div>`).join('')
          : '<div><strong>⚠️ No accounts connected yet.</strong> The sync has nothing to pull until you connect one.</div>'}
        <div class="row" style="margin-top:10px">
          <a class="btn primary" href="/admin/flickr/connect">${s.accounts.length ? '+ Connect another account' : 'Connect a Flickr account'}</a>
          <span class="small muted">You'll approve read-only access on Flickr. For another account, sign into it on flickr.com first.</span>
        </div>
      </div>`}
    <h2>Inquiry form</h2>
    <div class="card">
      <div style="margin-bottom:10px">${c.inquiry.ready ? '✅ <strong>Ready</strong> — the form on <a href="/inquiry" target="_blank" rel="noopener">/inquiry</a> is live.'
        : '⚠️ <strong>Not set up yet</strong> — visitors see the anti-bot box fail until these are filled in.'}</div>
      <details ${c.inquiry.ready ? '' : 'open'}><summary>Where to get these</summary>
        <ol class="small" style="line-height:1.7;margin:6px 0 10px">
          <li><strong>Turnstile</strong>: Cloudflare dashboard → <strong>Turnstile</strong> → <strong>Add widget</strong>. Name it "tonyshi.photos inquiry",
            add hostnames <code>tonyshi.photos</code> and <code>www.tonyshi.photos</code>, mode <strong>Managed</strong>. Copy the <strong>Site Key</strong> and <strong>Secret Key</strong> (both start with 0x).</li>
          <li><strong>Resend</strong>: resend.com → <strong>API Keys</strong> → <strong>Create API key</strong>, permission <strong>Sending access</strong>, domain <code>tonyshi.photos</code>
            (already verified for your VPN portal emails). Copy the key (starts with re_).</li>
          <li><strong>Send to</strong>: the inbox where inquiries should land. Replies go straight to the visitor (Reply-To is set).</li>
        </ol></details>
      <form id="fi" class="form">
        <label>Turnstile site key</label><input id="tsKey" autocomplete="off" spellcheck="false" value="${esc(c.inquiry.siteKey)}" placeholder="0x…">
        <label>Turnstile secret key</label><input id="tsSecret" autocomplete="off" spellcheck="false" placeholder="${c.inquiry.secret ? 'saved — enter to replace' : '0x…'}">
        <label>Resend API key</label><input id="rsKey" autocomplete="off" spellcheck="false" placeholder="${c.inquiry.resend ? 'saved — enter to replace' : 're_…'}">
        <label>Send inquiries to</label><input id="inqTo" type="email" value="${esc(c.inquiry.to)}" placeholder="you@example.com">
        <label>From</label><input id="inqFrom" value="${esc(c.inquiry.from)}">
        <span></span><div class="row"><button class="primary">Save</button><button type="button" id="inqTest">Send test email</button><span id="inqMsg" class="small"></span></div>
      </form>
    </div>

    <h2>Upload tokens</h2>
    <p class="muted small">For the <code>aerial</code> Mac uploader. A token can only manage Aerial clips — nothing else in this admin.</p>
    <div id="tokens" class="card"></div>
    <h2>Processing</h2>
    <p class="small muted" style="margin-top:-6px">These are the defaults. Each Flickr account can override sizes and quality:</p>
    <div class="tblwrap" style="margin-bottom:12px"><table>
      <tr><th>Account</th><th>Showcase photos</th><th>All other photos</th><th>JPEG quality</th><th></th></tr>
      ${s.accounts.map(a => {
        const cell = (v, d, unit) => v ? `<b>${fmtN(v)}${unit}</b>` : `<span class="muted">${fmtN(+d)}${unit} (default)</span>`;
        return `<tr><td><strong>${esc(a.realname || a.username)}</strong><div class="small muted">${esc(a.username)}</div></td>
          <td>${cell(a.long_edge, st.long_edge, ' px')}</td><td>${cell(a.base_edge, st.base_edge || 2048, ' px')}</td><td>${cell(a.quality, st.quality, '')}</td>
          <td><button data-asz="${a.id}">Edit</button></td></tr>`;
      }).join('') || '<tr><td colspan="5" class="muted">No accounts connected.</td></tr>'}
    </table></div>
    <form id="fp" class="form">
      <label class="muted small" style="grid-column:1/-1;margin:0">Defaults (used by any account without its own value):</label>
      <label>Showcase size — long edge (px)</label><input name="long_edge" type="number" value="${esc(st.long_edge)}" title="Photos in your album-builder folders, the Aerial reel and the front page's top N">
      <label>Everything else — long edge (px)</label><input name="base_edge" type="number" value="${esc(st.base_edge || 2048)}">
      <label>Master JPEG quality</label><input name="quality" type="number" value="${esc(st.quality)}">
      <label>Aerial reel photos: cover a screen this wide (px)</label><input name="reel_edge" type="number" value="${esc(st.reel_edge || 6000)}">
      <label>Aerial reel photos: JPEG quality</label><input name="reel_quality" type="number" value="${esc(st.reel_quality || 60)}">
      <label>Thumbnail long edge (px)</label><input name="thumb_edge" type="number" value="${esc(st.thumb_edge)}">
      <label>Thumbnail WebP quality</label><input name="thumb_quality" type="number" value="${esc(st.thumb_quality)}">
      <label>Panorama from aspect</label><input name="pano_ratio" type="number" step="0.1" value="${esc(st.pano_ratio)}">
      <label>Panorama master short edge (px)</label><input name="pano_short" type="number" value="${esc(st.pano_short)}">
      <label>Panorama master long edge max (px)</label><input name="pano_long_max" type="number" value="${esc(st.pano_long_max)}">
      <label>Panorama thumbnail short edge (px)</label><input name="pano_thumb_short" type="number" value="${esc(st.pano_thumb_short)}">
      <label>Flickr API calls / hour</label><input name="api_budget" type="number" value="${esc(st.api_budget)}">
      <label>R2 storage budget (GB)</label><input name="storage_budget_gb" type="number" step="0.5" value="${esc(st.storage_budget_gb)}">
      <label>Front page photo count</label><input name="featured_count" type="number" value="${esc(st.featured_count)}">
      <label>Hotlink protection</label><select name="hotlink_protect" data-text title="Other sites can't embed your photos (a 403 instead of the image). Direct links, email, link previews and this site always work."><option value="1"${st.hotlink_protect !== '0' ? ' selected' : ''}>On — photos only show on this site</option><option value="0"${st.hotlink_protect === '0' ? ' selected' : ''}>Off</option></select>
      <label>…but allow these sites</label><input name="hotlink_allow" data-text value="${esc(st.hotlink_allow || '')}" title="Comma-separated parts of host names, e.g. google, bing.com — search engines are in by default so image search keeps working">
      <label>Getty page for the footer icon</label><input name="getty_profile_url" data-text value="${esc(st.getty_profile_url || '')}" placeholder="https://www.gettyimages.com/… (empty = photographer search for your portfolio's name)" title="Where the Getty icon in the site footer goes. Must be a gettyimages link.">
      <span></span><div><button class="primary">Save</button> <span class="small muted">Size/quality changes apply to newly processed photos — use “Upgrade existing photos” below for the rest.</span></div>
    </form>
    <h2>Photo sizes</h2>
    <div class="card" id="upsize"><span class="muted">Checking…</span></div>
    <h2>Environment</h2>
    <div class="card">
      ${ck(c.encryptionKey, 'ENCRYPTION_KEY secret', 'npx wrangler secret put ENCRYPTION_KEY')}
      ${ck(c.bucket, 'R2 bucket binding', 'check wrangler.toml')}
      ${ck(c.images, 'Images binding', 'check wrangler.toml')}
      ${ck(c.inquiry.ready, 'Inquiry form (Turnstile + Resend)', 'fill in the Inquiry form section above')}
    </div>`;
  $('#homePage').onchange = async () => {
    const msg = $('#homeMsg');
    msg.textContent = 'Saving…'; msg.className = 'small';
    try {
      await api('/settings', { method: 'POST', body: { home_page: $('#homePage').value } });
      msg.textContent = `✅ Home page is now ${$('#homePage').value === 'aerial' ? 'Aerial' : 'Photos'}`; msg.className = 'small okc';
    } catch (e) { msg.textContent = e.message; msg.className = 'small err'; }
  };
  if ($('#replaceKey')) $('#replaceKey').onclick = () => { $('#fk').hidden = false; $('#key').focus(); };
  $('#fk').onsubmit = async e => {
    e.preventDefault();
    const msg = $('#keyMsg'), key = $('#key').value.trim(), secret = $('#secret').value.trim();
    const say = (t, bad) => { msg.textContent = t; msg.className = 'small ' + (bad ? 'err' : 'okc'); };
    if (!/^[0-9a-f]{32}$/i.test(key)) return say('API key should be 32 letters/digits (0-9, a-f).', true);
    if (!/^[0-9a-f]{16}$/i.test(secret)) return say('API secret should be 16 letters/digits (0-9, a-f).', true);
    $('#saveKey').disabled = true; say('Saving…');
    try {
      await api('/settings', { method: 'POST', body: { flickr_api_key: key, flickr_api_secret: secret } });
      say('✅ Saved');
      toast('Flickr key saved — next, connect your Flickr account');
      setTimeout(settings, 600);
    } catch (err) { say(err.message, true); }
    finally { $('#saveKey').disabled = false; }
  };
  $('#fi').onsubmit = async e => {
    e.preventDefault();
    const msg = $('#inqMsg'), body = { turnstile_site_key: $('#tsKey').value.trim(), inquiry_to: $('#inqTo').value.trim(), inquiry_from: $('#inqFrom').value.trim() };
    if ($('#tsSecret').value.trim()) body.turnstile_secret = $('#tsSecret').value.trim();
    if ($('#rsKey').value.trim()) body.resend_api_key = $('#rsKey').value.trim();
    msg.textContent = 'Saving…'; msg.className = 'small';
    try { await api('/settings', { method: 'POST', body }); toast('Inquiry settings saved'); settings(); }
    catch (err) { msg.textContent = err.message; msg.className = 'small err'; }
  };
  $('#inqTest').onclick = async () => {
    const msg = $('#inqMsg'); msg.textContent = 'Sending…'; msg.className = 'small';
    try { const r = await api('/inquiry/test', { method: 'POST' }); msg.textContent = `✅ Sent to ${r.to} — check your inbox`; msg.className = 'small okc'; }
    catch (err) { msg.textContent = err.message; msg.className = 'small err'; }
  };
  const drawTokens = async () => {
    const { tokens } = await api('/tokens');
    const box = $('#tokens');
    box.innerHTML = `${tokens.filter(t => !t.revoked_at).map(t => `<div class="row" style="margin-bottom:6px">
        <code>${esc(t.prefix)}…</code> <strong>${esc(t.name)}</strong>
        <span class="small muted">created ${ago(t.created_at)} · last used ${ago(t.last_used_at)}</span>
        <span class="spacer"></span><button class="danger" data-revoke="${t.id}">Revoke</button></div>`).join('')
        || '<div class="muted small" style="margin-bottom:8px">No tokens yet.</div>'}
      <div class="row"><input id="tname" placeholder="Name, e.g. MacBook Air" style="width:220px"><button id="tnew" class="primary">Create token</button></div>
      <div id="tshow"></div>`;
    $('#tnew').onclick = run(async () => {
      const { token } = await api('/tokens', { method: 'POST', body: { name: $('#tname').value } });
      await drawTokens();
      $('#tshow').innerHTML = `<div class="callout" style="margin-top:12px">
        <strong>Copy this token now — it won't be shown again.</strong>
        <div class="row" style="margin:8px 0"><code id="tval" style="word-break:break-all">${esc(token)}</code><button id="tcopy">Copy</button></div>
        <div class="small">On your Mac run <code>aerial login</code> and paste it when asked.</div></div>`;
      $('#tcopy').onclick = () => navigator.clipboard.writeText(token).then(() => toast('Copied'));
    });
    box.querySelectorAll('[data-revoke]').forEach(bt => bt.onclick = run(async () => {
      if (!confirm('Revoke this token? The Mac using it will stop being able to upload.')) return;
      await api('/tokens/' + bt.dataset.revoke, { method: 'DELETE' }); drawTokens();
    }));
  };
  run(drawTokens)();
  view.querySelectorAll('[data-asz]').forEach(b => b.onclick = () => accountSizes(s.accounts.find(a => a.id === +b.dataset.asz), () => settings()));
  const upsize = async (recheck) => {
    const u = await api('/photos/sizes', recheck ? { method: 'POST', body: {} } : {});
    $('#upsize').innerHTML = `
      <p style="margin-top:0">Photos visitors actually open — in your <b>Album builder</b> folders (incl. city sub-folders), on the <b>Aerial reel</b>
        and the front page's top N — are kept at <b>${fmtN(u.big)} px</b>. Everything else is stored at <b>${fmtN(u.base)} px</b>, which keeps R2 under the free 10 GB.
        Panoramas keep their own sizing. This updates by itself as you change folders.</p>
      <div class="cards">
        <div class="card"><div class="k">Showcase photos</div><div class="v">${fmtN(u.showcase)}</div><div class="small muted">${fmtN(u.showcase_done)} already at ${fmtN(u.big)} px</div></div>
        <div class="card"><div class="k">Waiting for the Mac app</div><div class="v">${fmtN(u.waiting_mac)}</div><div class="small muted">big size needs the original — TSP Uploader → Photos → Start</div></div>
        <div class="card"><div class="k">Being shrunk</div><div class="v">${fmtN(u.to_shrink)}</div><div class="small muted">bigger than needed — the site does these (no download)</div></div>
      </div>
      <div class="row" style="margin-top:10px"><span class="spacer"></span><button id="upGo">Recheck now</button></div>`;
    $('#upGo').onclick = run(() => upsize(true));
  };
  run(upsize)();
  $('#fp').onsubmit = run(async e => {
    e.preventDefault();
    const body = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, e.target.elements[k]?.hasAttribute('data-text') ? v : Number(v)]));
    await api('/settings', { method: 'POST', body });
    toast('Saved'); run(upsize)();
  });
}

route();
})();
