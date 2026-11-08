// Portfolio: /photos shows the curated selection; /photos/<folder>/<sub-folder> a folder from the album builder.
// The grid and the lightbox come from photoview.js.
(() => {
  const { esc } = window.TSP;
  const grid = new window.TSP.Grid(document.getElementById('grid'));
  const crumbs = document.getElementById('crumbs');
  const empty = document.getElementById('empty');
  // "shuffled" folders: every visitor gets their own order, stable while they browse (per browser session)
  const sessionSeed = (() => {
    let s = '';
    try { s = sessionStorage.getItem('tspSeed') || ''; if (!s) { s = Math.random().toString(36).slice(2); sessionStorage.setItem('tspSeed', s); } }
    catch { s = Math.random().toString(36).slice(2); }
    return s;
  })();
  function shuffle(list, key) {
    let h = 1779033703;
    for (const c of sessionSeed + key) h = Math.imul(h ^ c.charCodeAt(0), 3432918353), h = (h << 13) | (h >>> 19);
    const rnd = () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    return list;
  }
  const folderPath = () => decodeURIComponent(location.pathname).replace(/^\/photos\/?/, '').replace(/\/+$/, '');
  let topFolders = [];
  let shareTitle = '';
  const shareBtn = document.getElementById('pageShare');
  if (shareBtn) shareBtn.onclick = e => window.TSP.share(e.currentTarget, shareTitle
    ? { url: location.pathname, title: `${shareTitle} — Tony Shi`, text: `Check out “${shareTitle}” — photographs by Tony Shi` }
    : { url: location.pathname, title: 'Tony Shi Photography', text: 'Check out Tony Shi’s photography' });
  function drawCrumbs(d) {
    if (!crumbs) return;
    const kids = d ? d.children : topFolders.map(f => ({ title: f.title, path: f.path }));
    if (!d && !kids.length) { crumbs.hidden = true; return; }
    crumbs.hidden = false;
    crumbs.innerHTML = (d ? `<nav class="trail" aria-label="Folder"><a href="/photos" data-nav>Portfolio</a>${d.crumbs.map((c, i) =>
      i === d.crumbs.length - 1 ? `<span aria-current="page">${esc(c.title)}</span>` : `<a href="/photos/${esc(c.path)}" data-nav>${esc(c.title)}</a>`).join('')}</nav>` : '')
      + (kids.length ? `<div class="subs">${kids.map((k, i) => `<a href="/photos/${esc(k.path)}" data-nav style="--i:${i}">${esc(k.title)}</a>`).join('')}</div>` : '');
  }

  let loadNo = 0;
  async function load() {
    const my = ++loadNo;
    const path = folderPath();
    grid.grid.classList.add('loading');
    empty.hidden = true;
    try {
      const d = await (await fetch(path ? `/api/folder?path=${encodeURIComponent(path)}` : '/api/featured')).json();
      if (my !== loadNo) return;
      let photos = (d.photos || []).filter(p => p.w && p.h);
      if (path && d.display === 'random') shuffle(photos, path);
      document.title = path && d.title ? `${d.title} — Tony Shi Photography` : 'Tony Shi Photography';
      shareTitle = path && d.title ? d.title : '';
      drawCrumbs(path ? (d.crumbs ? d : { crumbs: [{ title: 'Not found', path }], children: [] }) : null);
      empty.textContent = path ? (d.error ? 'This folder doesn’t exist (any more).' : 'Nothing here yet.') : 'New work is on its way.';
      empty.hidden = photos.length > 0;
      grid.set(photos);
      document.dispatchEvent(new CustomEvent('tsp:folder', { detail: { path } }));
    } catch {
      if (my === loadNo) { grid.set([]); empty.hidden = false; }
    } finally {
      if (my === loadNo) requestAnimationFrame(() => grid.grid.classList.remove('loading'));
    }
  }
  // in-page navigation between folders (no full reload)
  window.TSP = window.TSP || {};
  window.TSP.go = href => {
    if (href !== location.pathname) history.pushState(null, '', href);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    load();
  };
  window.TSP.setTop = list => { topFolders = list || []; if (!folderPath()) drawCrumbs(null); };
  window.addEventListener('popstate', load);
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-nav]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault(); window.TSP.go(a.getAttribute('href'));
  });
  load();
})();
