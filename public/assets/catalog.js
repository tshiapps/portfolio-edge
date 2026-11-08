// Catalog: Browse (your collections and albums, both Flickr accounts merged), Search (words + filters + sorting)
// Map (every located photo, clustered) and Camera Roll (by month taken). One page; the address bar keeps the view so links can be shared:
//   /catalog/<collection>/<sub-collection>/<album>   /catalog/search?q=…&make=…   /catalog/map
(() => {
  const { esc, n } = window.TSP;
  const $ = s => document.querySelector(s);
  const views = { browse: $('#vBrowse'), search: $('#vSearch'), map: $('#vMap'), roll: $('#vRoll') };
  const bgrid = new window.TSP.Grid($('#bgrid')), sgrid = new window.TSP.Grid($('#sgrid'));
  const api = p => fetch(p).then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))));
  const path = () => decodeURIComponent(location.pathname).replace(/^\/catalog\/?/, '').replace(/\/+$/, '');
  const tabOf = p => (p === 'search' ? 'search' : p === 'map' ? 'map' : p === 'roll' ? 'roll' : 'browse');
  const go = (href, replace) => { if (href !== location.pathname + location.search) history[replace ? 'replaceState' : 'pushState'](null, '', href); route(); };
  window.addEventListener('popstate', () => route());
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href^="/catalog"]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button || a.target) return;
    e.preventDefault(); go(a.getAttribute('href')); window.scrollTo({ top: 0 });
  });

  let tree = null;
  const loadTree = () => tree || (tree = api('/api/catalog/tree').then(d => { $('#catTotal').textContent = `${d.total.toLocaleString()} photographs`; return d; }));
  loadTree().catch(() => {});

  // what the Share button says about the page you're on
  let shareCtx = null;
  $('#pageShare').onclick = e => {
    const tab = tabOf(path()), c = shareCtx;
    const [title, text] = tab === 'roll' ? ['Camera Roll — Tony Shi', 'Every photograph by Tony Shi, month by month']
      : tab === 'map' ? ['Map — Tony Shi', 'Tony Shi’s photographs on a map']
      : tab === 'search' ? (form.q.value.trim() ? [`“${form.q.value.trim()}” — Tony Shi`, `Photographs by Tony Shi: “${form.q.value.trim()}”`] : ['Search — Tony Shi', 'Search every photograph by Tony Shi'])
      : c?.album ? [`${c.title} — Tony Shi`, `Check out the “${c.title}” album by Tony Shi`]
      : c?.title ? [`${c.title} — Tony Shi`, `Check out “${c.title}” — photographs by Tony Shi`]
      : ['Catalog — Tony Shi Photography', 'Browse the catalog of Tony Shi’s photography'];
    window.TSP.share(e.currentTarget, { url: location.pathname + location.search.replace(/([?&])p=\d+&?/, '$1').replace(/[?&]$/, ''), title, text, image: c?.cover ? `/img/${c.cover}/m` : null });
  };
  async function route() {
    const p = path(), tab = tabOf(p);
    for (const [k, v] of Object.entries(views)) v.hidden = k !== tab;
    document.querySelectorAll('.cat-tabs a').forEach(a => a.toggleAttribute('aria-current', a.dataset.tab === tab));
    if (tab === 'browse') await browse(p);
    else if (tab === 'search') await search(true);
    else if (tab === 'roll') await roll();
    else await map();
  }

  // ---------- browse ----------
  const albumIcon = '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="14" height="14" rx="1.5"/><path d="M7 3h13.5v13.5"/></svg>';
  const folderIcon = '<svg viewBox="0 0 24 24"><path d="M3 7.5V19h18V9H11.5L9.5 6.5H3z"/></svg>';
  const cover = (id, v) => id ? `<img loading="lazy" decoding="async" src="/img/${esc(id)}/t?v=${v || 0}" alt="" draggable="false">` : '';
  async function browse(p) {
    const d = await loadTree();
    let node = { title: 'Catalog', kids: d.tree, albums: [], path: '' }, album = null;
    const trail = [{ title: 'Catalog', path: '' }];
    for (const part of p ? p.split('/') : []) {
      const k = node.kids.find(x => x.path.split('/').pop() === part);
      if (k) { node = k; trail.push({ title: k.title, path: k.path }); continue; }
      const a = node.albums.find(x => x.path.split('/').pop() === part);
      if (a) { album = a; trail.push({ title: a.title, path: a.path }); break; }
      node = null; break;
    }
    $('#trail').innerHTML = trail.map((t, i) => i === trail.length - 1 ? `<span aria-current="page">${esc(t.title)}</span>` : `<a href="/catalog${t.path ? '/' + esc(t.path) : ''}">${esc(t.title)}</a>`).join('');
    document.title = `${trail.length > 1 ? trail.at(-1).title + ' — ' : ''}Catalog · Tony Shi Photography`;
    shareCtx = album ? { album: true, title: album.title, cover: album.cover } : node && node.path ? { title: node.title, cover: node.covers?.[0]?.[0] } : null;
    if (!node) { $('#cards').innerHTML = '<p class="empty">This collection doesn’t exist (any more).</p>'; bgrid.set([]); return; }
    if (album) {
      $('#cards').innerHTML = `<p class="cat-count">${album.n.toLocaleString()} photo${album.n === 1 ? '' : 's'}</p>`;
      bgrid.grid.classList.add('loading');
      const a = await api(`/api/catalog/album?id=${encodeURIComponent(album.id)}`).catch(() => ({ photos: [] }));
      bgrid.set(a.photos);
      requestAnimationFrame(() => bgrid.grid.classList.remove('loading'));
      return;
    }
    bgrid.set([]);
    const plural = (k, w) => `${k.toLocaleString()} ${w}${k === 1 ? '' : 's'}`;
    // albums look like a little stack of prints; collections like a 2×2 contact sheet of what's inside
    const albumCard = (x, i) => `<a class="cat-card is-album" href="/catalog/${esc(x.path)}" style="--i:${i}" title="${esc(x.title)} — album, ${plural(x.n, 'photo')}">
      <span class="cc-img"><span class="cc-stack">${cover(x.cover, x.v)}</span><span class="cc-badge">${albumIcon}${n(x.n)}</span></span>
      <span class="cc-t">${esc(x.title)}</span></a>`;
    const colCard = (x, i) => `<a class="cat-card is-col" href="/catalog/${esc(x.path)}" style="--i:${i}" title="${esc(x.title)} — collection">
      <span class="cc-img"><span class="cc-mosaic m${Math.min(4, x.covers.length)}">${x.covers.map(([id, v]) => cover(id, v)).join('')}</span><span class="cc-badge">${folderIcon}${n(x.n)}</span></span>
      <span class="cc-t">${esc(x.title)}</span>
      <span class="cc-n">${[x.kids.length ? plural(x.kids.length, 'collection') : '', x.albums.length ? plural(x.albums.length, 'album') : ''].filter(Boolean).join(' · ')}</span></a>`;
    const cards = nd => { let i = 0; return `<div class="cat-grid">${nd.kids.map(k => colCard(k, i++)).join('')}${nd.albums.map(a => albumCard(a, i++)).join('')}</div>`; };
    if (!p) {
      // the top: one row per Flickr account
      $('#cards').innerHTML = node.kids.map(acc => `<section class="cat-acc">
        <h2 class="cat-h"><a href="/catalog/${esc(acc.path)}">${esc(acc.title)}</a><span>${plural(acc.n, 'photo')} · ${[acc.kids.length ? plural(acc.kids.length, 'collection') : '', acc.albums.length ? plural(acc.albums.length, 'album') : ''].filter(Boolean).join(' · ')}</span></h2>
        ${cards(acc)}</section>`).join('');
      return;
    }
    $('#cards').innerHTML = cards(node);
  }

  // ---------- search ----------
  const form = $('#sForm');
  let facets = null, sOffset = 0, sTotal = 0, sBusy = false, sSeq = 0;
  async function fillFacets() {
    if (facets) return;
    facets = await api('/api/catalog/facets').catch(() => ({ makes: [], cameras: [], years: [], countries: [] }));
    const opt = (v, l) => `<option value="${esc(v)}">${esc(l)}</option>`;
    form.make.insertAdjacentHTML('beforeend', facets.makes.map(m => opt(m.k, `${m.k} (${m.n.toLocaleString()})`)).join(''));
    const years = facets.years.map(y => y.k);
    form.from.insertAdjacentHTML('beforeend', years.map(y => opt(y, y)).join(''));
    form.to.insertAdjacentHTML('beforeend', [...years].reverse().map(y => opt(y, y)).join(''));
    form.country.insertAdjacentHTML('beforeend', facets.countries.map(c => opt(c.k, `${c.k} (${c.n.toLocaleString()})`)).join(''));
    if (facets.getty) form.getty.options[1].textContent = `On Getty Images (${facets.getty.toLocaleString()})`;
  }
  const fillModels = () => {
    const mk = form.make.value, cur = form.camera.value;
    form.camera.innerHTML = '<option value="">Any model</option>' + (facets?.cameras || []).filter(c => !mk || c.m === mk)
      .map(c => `<option value="${esc(c.k)}">${esc(c.k)} (${c.n.toLocaleString()})</option>`).join('');
    form.camera.value = [...form.camera.options].some(o => o.value === cur) ? cur : '';
  };
  const params = () => { const q = new URLSearchParams(); for (const el of form.elements) if (el.name && el.value && !(el.name === 'sort' && el.value === 'popular')) q.set(el.name, el.value); return q; };
  async function search(fromUrl) {
    await fillFacets();
    if (fromUrl) {
      const q = new URLSearchParams(location.search);
      for (const el of form.elements) if (el.name) el.value = q.get(el.name) || (el.name === 'sort' ? 'popular' : '');
      fillModels(); form.camera.value = q.get('camera') || '';
      document.title = 'Search · Catalog · Tony Shi Photography';
    }
    const q = params(), my = ++sSeq;
    sOffset = 0;
    sgrid.grid.classList.add('loading');
    const kw = (form.q.value || '').trim();
    if (kw && kw.length < 2) return; // one letter matches everything — wait for more
    const d = await api(`/api/catalog/search?${q}`).catch(() => ({ total: 0, photos: [], failed: true }));
    if (my !== sSeq) return;
    if (d.failed) { $('#sCount').textContent = 'Search is busy — try again in a moment.'; sgrid.grid.classList.remove('loading'); return; }
    sTotal = d.total; sOffset = d.photos.length;
    $('#sCount').textContent = `${d.total.toLocaleString()} photo${d.total === 1 ? '' : 's'}`;
    sgrid.set(d.photos);
    requestAnimationFrame(() => sgrid.grid.classList.remove('loading'));
  }
  async function more() {
    if (sBusy || sOffset >= sTotal || views.search.hidden) return;
    sBusy = true;
    const q = params(); q.set('offset', sOffset);
    const d = await api(`/api/catalog/search?${q}`).catch(() => ({ photos: [] }));
    sOffset += d.photos.length; if (!d.photos.length) sOffset = sTotal;
    sgrid.add(d.photos);
    sBusy = false;
  }
  new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) more(); }, { rootMargin: '800px' }).observe($('#sMore'));
  let st;
  const changed = () => { history.replaceState(null, '', `/catalog/search${params().toString() ? '?' + params() : ''}`); search(false); };
  form.addEventListener('input', e => { if (e.target.name === 'make') fillModels(); clearTimeout(st); st = setTimeout(changed, e.target.name === 'q' ? 550 : 0); });
  form.addEventListener('submit', e => { e.preventDefault(); clearTimeout(st); changed(); });
  $('#sClear').onclick = () => { form.reset(); fillModels(); changed(); };

  // ---------- map ----------
  let mapObj = null;
  async function map() {
    document.title = 'Map · Catalog · Tony Shi Photography';
    if (mapObj) { setTimeout(() => mapObj.invalidateSize(), 0); return; }
    if (!window.L) { $('#map').innerHTML = '<p class="empty">The map couldn’t load.</p>'; return; }
    const L = window.L;
    mapObj = L.map('map', { worldCopyJump: true, minZoom: 2, zoomControl: true, attributionControl: true }).setView([30, 0], 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(mapObj);
    const d = await api('/api/catalog/geo').catch(() => ({ points: [] }));
    const pts = d.points.map(([id, lat, lon, v, w, h, title]) => ({ id, lat, lon, v, w, h, title }));
    $('#mCount').textContent = `All ${pts.length.toLocaleString()} located photographs are on the map — the numbers are how many are grouped there; zoom in to spread them out.`;
    // clusters show the most popular photo inside them, with the count
    const clusters = L.markerClusterGroup({
      showCoverageOnHover: false, maxClusterRadius: z => (z < 4 ? 44 : z < 8 ? 38 : 30), spiderfyOnMaxZoom: true, chunkedLoading: true,
      iconCreateFunction: c => {
        const ms = c.getAllChildMarkers(), top = ms.reduce((a, m) => (m.options.rank < a.options.rank ? m : a), ms[0]).options.p;
        return L.divIcon({ className: 'mk mk-c', iconSize: [52, 52],
          html: `<span style="background-image:url('/img/${top.id}/t?v=${top.v}')"></span><b>${n(c.getChildCount())}</b>` });
      },
    });
    pts.forEach((p, i) => {
      const m = L.marker([p.lat, p.lon], { rank: i, p, icon: L.divIcon({ className: 'mk', iconSize: [40, 40], html: `<span style="background-image:url('/img/${p.id}/t?v=${p.v}')"></span>` }) });
      m.on('click', () => {
        // the lightbox steps through what's on screen, most popular first
        const b = mapObj.getBounds();
        const list = pts.filter(q => b.contains([q.lat, q.lon]));
        const at = Math.max(0, list.indexOf(p));
        window.TSP.lightbox.open(list, at);
      });
      clusters.addLayer(m);
    });
    mapObj.addLayer(clusters);
  }


  // ---------- camera roll ----------
  // every photo by the month it was taken, newest first. The month list is one small request; each month's photos are
  // fetched only as it nears the screen (two at a time), as tiny 120 px squares — a month of 1,000 photos is ~3 MB.
  let rollReady = false;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  async function roll() {
    document.title = 'Camera Roll · Catalog · Tony Shi Photography';
    if (rollReady) return;
    rollReady = true;
    const body = $('#rollBody'), rail = $('#rollRail');
    const d = await api('/api/catalog/roll').catch(() => null);
    if (!d?.months?.length) { body.innerHTML = '<p class="empty">Nothing here yet.</p>'; return; }
    const years = new Map();
    for (const [m, c] of d.months) { const y = m === 'undated' ? 'Undated' : m.slice(0, 4); years.set(y, (years.get(y) || 0) + c); }
    const maxY = Math.max(...years.values());
    let lastY = null;
    body.innerHTML = d.months.map(([m, c]) => {
      const y = m === 'undated' ? 'Undated' : m.slice(0, 4), head = y !== lastY ? `<h2 class="roll-y" id="y-${y}">${y}<span>${n(years.get(y))} photos</span></h2>` : '';
      lastY = y;
      return `${head}<section class="roll-m" data-m="${m}" data-y="${y}" style="--n:${c}"><h3>${m === 'undated' ? 'Date unknown' : MONTHS[+m.slice(5) - 1]} <span>${n(c)}</span></h3><div class="roll-g"></div></section>`;
    }).join('');
    rail.innerHTML = [...years].map(([y, c]) => `<a href="#y-${y}" data-y="${y}"><span>${y === 'Undated' ? '?' : y}</span><i style="width:${Math.max(8, c / maxY * 100).toFixed(0)}%"></i></a>`).join('');
    rail.onclick = e => { const a = e.target.closest('a'); if (!a) return; e.preventDefault(); document.getElementById('y-' + a.dataset.y)?.scrollIntoView({ behavior: 'smooth' }); };
    let settle; addEventListener('scroll', () => { if (views.roll.hidden) return; clearTimeout(settle); settle = setTimeout(() => {
      body.querySelectorAll('.roll-m:not(.done)').forEach(s => { const r = s.getBoundingClientRect(); if (r.bottom > -900 && r.top < innerHeight + 900 && !queue.includes(s)) queue.push(s); }); pump(); }, 120); }, { passive: true });
    // reserve each month's height before its photos arrive, so the page doesn't jump while scrolling
    const size = () => {
      const w = body.clientWidth, tile = w < 520 ? 52 : 60, gap = 3, cols = Math.max(1, Math.floor((w + gap) / (tile + gap)));
      body.style.setProperty('--rt', tile + 'px');
      body.querySelectorAll('.roll-m:not(.done)').forEach(s => { s.querySelector('.roll-g').style.minHeight = Math.ceil(+s.style.getPropertyValue('--n') / cols) * (tile + gap) + 'px'; });
    };
    size(); addEventListener('resize', size);
    const lists = new Map(), queue = [], busy = new Set();
    const pump = () => {
      while (busy.size < 2 && queue.length) {
        // months the page scrolled past (e.g. jumping to a year) are dropped — only what's near the screen loads
        const near = x => { const r = x.getBoundingClientRect(); return r.bottom > -1200 && r.top < innerHeight + 1200; };
        queue.sort((a, b) => Math.abs(a.getBoundingClientRect().top) - Math.abs(b.getBoundingClientRect().top));
        const s = queue.shift(); if (s.classList.contains('done') || busy.has(s) || !near(s)) continue;
        busy.add(s);
        api(`/api/catalog/roll?m=${s.dataset.m}`).then(r => {
          const list = r.photos.map(p => ({ ...p, w: p.w || 1, h: p.h || 1 }));
          lists.set(s.dataset.m, list);
          s.querySelector('.roll-g').innerHTML = list.map((p, i) => `<a href="/img/${p.id}/m?v=${p.v || 0}" data-i="${i}" title="${esc(p.title || '')}${p.t ? ' · ' + esc(p.t.slice(0, 10)) : ''}" style="--d:${Math.min(i, 40) * 12}ms"><img loading="lazy" decoding="async" src="/img/${p.id}/s?v=${p.v || 0}" alt="" draggable="false"></a>`).join('');
          s.classList.add('done'); s.querySelector('.roll-g').style.minHeight = '';
        }).catch(() => { s.dataset.retry = 1; }).finally(() => { busy.delete(s); pump(); });
      }
    };
    const io = new IntersectionObserver(es => {
      for (const e of es) if (e.isIntersecting && !e.target.classList.contains('done') && !queue.includes(e.target)) queue.push(e.target);
      pump();
    }, { rootMargin: '900px 0px' });
    body.querySelectorAll('.roll-m').forEach(s => io.observe(s));
    body.onclick = e => {
      const a = e.target.closest('.roll-g a'); if (!a || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      window.TSP.lightbox.open(lists.get(a.closest('.roll-m').dataset.m), +a.dataset.i);
    };
    // the rail follows along: the year on screen is highlighted
    const yio = new IntersectionObserver(es => {
      const top = es.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!top) return;
      rail.querySelectorAll('a').forEach(a => a.classList.toggle('on', a.dataset.y === top.target.dataset.y));
    }, { rootMargin: '-30% 0px -60% 0px' });
    body.querySelectorAll('.roll-m').forEach(s => yio.observe(s));
  }

  route();
})();
