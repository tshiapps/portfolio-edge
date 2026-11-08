// Photos menu: click "Photos" → an animated panel with the album-builder folders as cascading columns.
// The panel hangs from the right edge, so sub-folders open to the LEFT. Forgiving by design:
//  • moving the mouse out of the panel never closes it (only a click well away from it, Esc, or picking a folder)
//  • when you head diagonally toward an open sub-menu, the items you brush past don't steal it ("menu aim")
//  • the panel grows and shrinks smoothly as columns come and go
(() => {
  const link = document.querySelector('header.site nav a[href="/photos"]');
  const panel = document.getElementById('fmenu');
  if (!link || !panel) return;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hover = matchMedia('(hover: hover) and (pointer: fine)');
  const narrow = matchMedia('(max-width: 700px)');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const onPhotos = !!document.getElementById('grid');
  let tree = [], open = false, intent = null, intentDepth = -1;

  const cols = document.createElement('div');
  cols.className = 'fcols';
  panel.append(cols);

  const currentPath = () => decodeURIComponent(location.pathname).replace(/^\/photos\/?/, '').replace(/\/+$/, '');
  const go = path => {
    close();
    const href = path ? `/photos/${path}` : '/photos';
    if (onPhotos && window.TSP?.go) window.TSP.go(href); else location.href = href;
  };

  function column(items, depth, parent) {
    const cur = currentPath();
    const c = document.createElement('div');
    c.className = 'fcol' + (items.length > 12 ? ' many' : '');
    c.dataset.depth = depth;
    c.innerHTML = (parent ? `<div class="fhead"><button type="button" class="fback" aria-label="Back">‹</button>
        <a href="/photos/${esc(parent.path)}" data-path="${esc(parent.path)}" class="fall">All ${esc(parent.title)}</a></div>` : '')
      + `<ul>${items.map((f, i) => `<li style="--i:${Math.min(i, 24)}"><a href="${f.path ? '/photos/' + esc(f.path) : '/photos'}" data-path="${esc(f.path)}" data-k="${i}"
        class="${f.children?.length ? 'has' : ''}${f.path === cur || (f.path && cur.startsWith(f.path + '/')) ? ' cur' : ''}">${esc(f.title)}</a></li>`).join('')}</ul>`;
    c._items = items;
    return c;
  }

  // run a change to the columns while the panel's width glides from old to new
  function morph(change) {
    if (reduce.matches || narrow.matches || !open) { change(); return; }
    const w0 = cols.getBoundingClientRect().width;
    cols.style.width = '';
    change();
    const w1 = cols.getBoundingClientRect().width;
    if (Math.abs(w1 - w0) < 1) return;
    cols.style.width = w0 + 'px';
    cols.getBoundingClientRect(); // reflow
    cols.classList.add('morph');
    cols.style.width = w1 + 'px';
    clearTimeout(cols._mt);
    cols._mt = setTimeout(() => { cols.classList.remove('morph'); cols.style.width = ''; }, 380);
  }
  function setDepth() {
    const n = cols.children.length - 1;
    cols.style.setProperty('--depth', n);
  }
  // show the children of item k in column `depth`
  function expand(depth, k) {
    const col = cols.children[depth];
    const f = col?._items[k];
    if (!col) return false;
    const already = cols.children[depth + 1] && col.querySelector(`a[data-k="${k}"].on`);
    if (already) return true;
    let opened = false;
    morph(() => {
      while (cols.children.length > depth + 1) cols.lastChild.remove();
      col.querySelectorAll('a.on').forEach(a => a.classList.remove('on'));
      if (f?.children?.length) {
        col.querySelector(`a[data-k="${k}"]`)?.classList.add('on');
        cols.append(column(f.children, depth + 1, f));
        opened = true;
      }
      setDepth();
    });
    return opened;
  }

  function show() {
    cols.style.width = '';
    cols.replaceChildren(column([{ title: 'Featured', path: '' }, ...tree], 0, null));
    // re-open the branch of the folder being viewed
    const segs = currentPath().split('/').filter(Boolean);
    let p = '';
    for (let d = 0; d < segs.length && !narrow.matches; d++) {
      p = p ? `${p}/${segs[d]}` : segs[d];
      const k = cols.children[d]?._items.findIndex(f => f.path === p);
      if (k < 0 || !expand(d, k)) break;
    }
    setDepth();
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add('open'));
    link.setAttribute('aria-expanded', 'true');
    open = true;
  }
  function close() {
    if (!open) return;
    open = false;
    clearTimeout(intent);
    panel.classList.remove('open');
    link.setAttribute('aria-expanded', 'false');
    setTimeout(() => { if (!open) panel.hidden = true; }, 300);
  }

  // ----- menu aim: is the pointer travelling toward the open sub-menu (which sits to the LEFT)? -----
  const trail = [];
  document.addEventListener('mousemove', e => { trail.push([e.clientX, e.clientY, performance.now()]); if (trail.length > 4) trail.shift(); }, { passive: true });
  function headingToSub(depth) {
    const sub = cols.children[depth + 1];
    if (!sub || trail.length < 2 || performance.now() - trail[trail.length - 1][2] > 100) return false; // resting = not heading anywhere
    const [x0, y0] = trail[0], [x1, y1] = trail[trail.length - 1];
    if (x1 >= x0) return false;                       // not moving left
    const r = sub.getBoundingClientRect();
    // the triangle from where we were to the sub-menu's top-right and bottom-right corners
    const slope = (y, x) => (y - y0) / (x0 - x + 0.001);
    const up = slope(r.top - 40, r.right), down = slope(r.bottom + 40, r.right), mine = slope(y1, x1);
    return mine >= up && mine <= down;
  }

  cols.addEventListener('mouseover', e => {
    if (!hover.matches || narrow.matches) return;
    const colEl = e.target.closest('.fcol'); if (!colEl) return;
    const depth = +colEl.dataset.depth;
    const a = e.target.closest('a[data-k]');
    if (!a) {
      if (depth > intentDepth) { clearTimeout(intent); intentDepth = -1; } // reached the sub-menu: keep it
      return;
    }
    const k = +a.dataset.k;
    clearTimeout(intent);
    intentDepth = depth;
    // heading for the sub-menu → wait and see; otherwise switch quickly (but not instantly, so sweeps don't flicker)
    const wait = headingToSub(depth) ? 380 : 110;
    intent = setTimeout(function check() {
      if (!a.isConnected || !a.matches(':hover')) return;                  // moved on; the next item decides
      if (headingToSub(depth)) { intent = setTimeout(check, 120); return; } // still drifting toward the sub-menu
      intentDepth = -1;
      expand(depth, k);
    }, wait);
  });
  cols.addEventListener('mouseleave', () => { clearTimeout(intent); intentDepth = -1; });

  cols.addEventListener('click', e => {
    if (e.target.closest('.fback')) { morph(() => { cols.lastChild.remove(); setDepth(); }); return; }
    const a = e.target.closest('a[data-path]'); if (!a) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    // touch: first tap on a folder with sub-folders opens it; "All …" or a leaf opens the page
    if ((!hover.matches || narrow.matches) && a.dataset.k !== undefined && a.classList.contains('has')) {
      expand(+a.closest('.fcol').dataset.depth, +a.dataset.k); return;
    }
    go(a.dataset.path);
  });
  link.addEventListener('click', e => {
    if (!tree.length) return; // no folders yet: plain link
    e.preventDefault();
    open ? close() : show();
  });
  // only a click clearly away from the panel closes it (a near miss of ~40px doesn't)
  document.addEventListener('click', e => {
    if (!open || link.contains(e.target) || cols.contains(e.target)) return;
    const r = cols.getBoundingClientRect(), m = 40;
    if (e.clientX > r.left - m && e.clientX < r.right + m && e.clientY > r.top - m && e.clientY < r.bottom + m) return;
    close();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  fetch('/api/folders').then(r => r.json()).then(d => {
    tree = d.folders || [];
    window.TSP?.setTop?.(tree);
    if (!tree.length) return;
    link.setAttribute('aria-haspopup', 'true'); link.setAttribute('aria-expanded', 'false');
    link.classList.add('hasmenu');
  }).catch(() => {});
})();
