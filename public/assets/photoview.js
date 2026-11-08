// Shared photo viewing for every public page that shows photos (Portfolio, Catalog):
//  TSP.Grid      — Flickr-style justified grid (rows filled edge to edge, widths follow each photo's aspect),
//                  hover line with Flickr stats / place / Getty / views here, and the Inquire pill
//  TSP.lightbox  — the big view with the logo watermark, the info line, comments and map panels
(() => {
  window.TSP = window.TSP || {};
  const inquireUrl = p => `/inquiry?photo=${encodeURIComponent(p.id)}${p.title ? '&title=' + encodeURIComponent(p.title.slice(0, 150)) : ''}`;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // low-key icons (same family as the footer's Flickr / Instagram / YouTube marks)
  const SI = n => `<img class="si" src="${n === 'gettyimages' ? '/assets/getty.png' : `https://cdn.jsdelivr.net/npm/simple-icons@13/icons/${n}.svg`}" alt="">`;
  const I = {
    eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/></svg>',
    fav: '<svg viewBox="0 0 24 24"><path d="M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/></svg>',
    cmt: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
    gal: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="14" height="12" rx="1"/><path d="M7 4h14v12"/></svg>',
    pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.2"/></svg>',
    cam: '<svg viewBox="0 0 24 24"><path d="M4 8h3.5L9 6h6l1.5 2H20v11H4z"/><circle cx="12" cy="13" r="3.2"/></svg>',
    px: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>',
    mail: '<svg viewBox="0 0 24 24"><path d="M4 6h16v12H4z M4 7l8 6 8-6"/></svg>',
    share: '<svg viewBox="0 0 24 24"><path d="M12 15V3.5M7.5 8 12 3.5 16.5 8M5 12v8h14v-8"/></svg>',
    link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
    msg: '<svg viewBox="0 0 24 24"><path d="M12 4C7 4 3 7.2 3 11.2c0 2.2 1.2 4.2 3.2 5.5L5.5 20l3.7-2c.9.2 1.8.3 2.8.3 5 0 9-3.2 9-7.1S17 4 12 4z"/></svg>',
  };
  const n = v => v == null ? '–' : v >= 1e6 ? (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M' : v >= 1e3 ? (v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(v);
  Object.assign(window.TSP, { esc, SI, I, n, inquireUrl });


  // ---------- share ----------
  // Phones (and Safari on a Mac) get the system share sheet — iMessage, WhatsApp, Instagram, Telegram, AirDrop… whatever's installed.
  // Elsewhere a small menu with the usual places. Instagram has no way to share a link from the web, so that one copies it.
  let shareMenu = null;
  const isTouch = () => matchMedia('(pointer: coarse)').matches;
  async function share(btn, { url, title, text, image }) {
    url = new URL(url, location.origin).href;
    if (navigator.share && (isTouch() || /^((?!chrome|android|edg).)*safari/i.test(navigator.userAgent))) {
      try { await navigator.share({ title, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const u = encodeURIComponent(url), t = encodeURIComponent(text), both = encodeURIComponent(text + ' ' + url);
    const items = [
      ['copy', I.link, 'Copy link'],
      ['https://wa.me/?text=' + both, SI('whatsapp'), 'WhatsApp'],
      ['sms:&body=' + both, I.msg, 'Messages'],
      ['https://t.me/share/url?url=' + u + '&text=' + t, SI('telegram'), 'Telegram'],
      ['ig', SI('instagram'), 'Instagram'],
      ['https://x.com/intent/post?text=' + t + '&url=' + u, SI('x'), 'X'],
      ['https://www.facebook.com/sharer/sharer.php?u=' + u, SI('facebook'), 'Facebook'],
      ['https://www.threads.net/intent/post?text=' + both, SI('threads'), 'Threads'],
      ...(image ? [['https://www.pinterest.com/pin/create/button/?url=' + u + '&media=' + encodeURIComponent(new URL(image, location.origin).href) + '&description=' + t, SI('pinterest'), 'Pinterest']] : []),
      ['https://www.reddit.com/submit?url=' + u + '&title=' + encodeURIComponent(title), SI('reddit'), 'Reddit'],
      ['mailto:?subject=' + encodeURIComponent(title) + '&body=' + both, I.mail, 'Email'],
      ...(navigator.share ? [['native', I.share, 'More…']] : []),
    ];
    if (!shareMenu) {
      shareMenu = document.createElement('div'); shareMenu.className = 'share-menu'; shareMenu.hidden = true; document.body.append(shareMenu);
      document.addEventListener('click', e => { if (!shareMenu.hidden && !shareMenu.contains(e.target) && !e.target.closest('[data-share]')) shareMenu.hidden = true; }, true);
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && !shareMenu.hidden) { shareMenu.hidden = true; e.stopPropagation(); } }, true);
      addEventListener('scroll', () => { shareMenu.hidden = true; }, { passive: true });
    }
    if (!shareMenu.hidden && shareMenu.dataset.for === url) { shareMenu.hidden = true; return; } // same button again closes it
    shareMenu.dataset.for = url;
    shareMenu.innerHTML = `<div class="sm-h">Share</div>` + items.map(([h, ic, l]) => /^(copy|ig|native)$/.test(h)
      ? `<button type="button" data-act="${h}">${ic}<span>${l}</span></button>` : `<a href="${esc(h)}" target="_blank" rel="noopener">${ic}<span>${l}</span></a>`).join('');
    const copy = async () => { try { await navigator.clipboard.writeText(url); } catch { const i = document.createElement('input'); i.value = url; document.body.append(i); i.select(); document.execCommand('copy'); i.remove(); } };
    shareMenu.onclick = async e => {
      const b = e.target.closest('[data-act]');
      if (!b) { if (e.target.closest('a')) shareMenu.hidden = true; return; }
      if (b.dataset.act === 'native') { shareMenu.hidden = true; try { await navigator.share({ title, text, url }); } catch {} return; }
      await copy();
      b.querySelector('span').textContent = b.dataset.act === 'ig' ? 'Link copied — paste it in a DM or story' : 'Link copied';
      b.classList.add('done'); setTimeout(() => { shareMenu.hidden = true; }, 1400);
    };
    shareMenu.hidden = false;
    const r = btn.getBoundingClientRect(), mw = shareMenu.offsetWidth, mh = shareMenu.offsetHeight;
    shareMenu.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.right - mw)) + 'px';
    shareMenu.style.top = (r.bottom + mh + 8 < innerHeight ? r.bottom + 6 : Math.max(8, r.top - mh - 6)) + 'px';
  }
  window.TSP.share = share;
  const photoUrl = id => { const q = new URLSearchParams(location.search); q.set('p', id); return location.pathname + '?' + q; };

  // ---------- justified grid ----------
  const GAP = 6;
  const targetHeight = w => (w < 520 ? 170 : w < 900 ? 230 : w < 1500 ? 300 : 340);
  class Grid {
    constructor(grid, { onOpen } = {}) {
      this.grid = grid; this.photos = []; this.onOpen = onOpen || ((list, i) => window.TSP.lightbox.open(list, i));
      let rt, lastW = 0;
      new ResizeObserver(() => {
        if (grid.clientWidth === lastW) return;
        lastW = grid.clientWidth;
        clearTimeout(rt); rt = setTimeout(() => this.layout(), 80);
      }).observe(grid);
      grid.addEventListener('click', e => {
        const q = e.target.closest('.inq-btn');
        if (q) { e.preventDefault(); location.href = inquireUrl(this.photos[+q.dataset.inq]); return; }
        const a = e.target.closest('a[data-i]');
        if (!a || e.metaKey || e.ctrlKey) return;
        e.preventDefault(); this.onOpen(this.photos, +a.dataset.i);
      });
    }
    set(list) { this.photos = (list || []).filter(p => p.w && p.h).map(p => ({ ...p, ar: p.ar || p.w / p.h })); this.layout(); return this.photos; }
    add(list) { return this.set([...this.photos, ...(list || [])]); }
    layout() {
      const grid = this.grid, photos = this.photos;
      const W = grid.clientWidth;
      if (!W) return;
      if (!photos.length) { grid.replaceChildren(); return; }
      const H = targetHeight(W);
      const rows = [];
      let row = [], sum = 0;
      for (const p of photos) {
        row.push(p); sum += p.ar;
        const h = (W - GAP * (row.length - 1)) / sum;
        if (h <= H) { rows.push({ items: row, h, sum }); row = []; sum = 0; }
      }
      if (row.length) rows.push({ items: row, h: H, sum, last: true }); // last row keeps target height, left-aligned
      const frag = document.createDocumentFragment();
      let idx = 0;
      for (const r of rows) {
        const div = document.createElement('div');
        div.className = 'row';
        const h = Math.floor(r.h);
        let used = 0;
        r.items.forEach((p, i) => {
          let w = Math.floor(p.ar * r.h);
          if (!r.last && i === r.items.length - 1) w = W - used - GAP * (r.items.length - 1); // absorb rounding
          used += w;
          const a = document.createElement('a');
          a.href = `/img/${p.id}/m?v=${p.v || 0}`;
          a.style.width = w + 'px'; a.style.height = h + 'px';
          a.dataset.i = idx++;
          const img = new Image();
          img.loading = 'lazy'; img.decoding = 'async'; img.alt = p.title || ''; img.draggable = false;
          img.onload = () => img.classList.add('in');
          img.src = `/img/${p.id}/t?v=${p.v || 0}`; // version = when it was last stored, so replaced photos show at once
          const q = document.createElement('span');
          q.className = 'inq-btn'; q.dataset.inq = idx - 1; q.title = 'Inquire about this photo';
          q.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v12H4z M4 7l8 6 8-6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg><span>Inquire</span>';
          const m = document.createElement('span');
          m.className = 'tmeta';
          const st = p.s || [];
          m.innerHTML = (p.s ? `<span title="Flickr: views · faves · comments${st[3] ? ' · galleries' : ''}">${I.eye}${n(st[0])} ${I.fav}${n(st[1])} ${I.cmt}${n(st[2])}${st[3] ? ` ${I.gal}${n(st[3])}` : ''}</span>` : '')
            + (p.loc ? `<span>${I.pin}${esc(p.loc)}</span>` : '')
            + (p.gid ? `<span title="Available on Getty Images">${SI('gettyimages')}</span>` : '')
            + (st[4] ? `<span title="Views on tonyshi.photos">${I.eye}${n(st[4])} here</span>` : '');
          a.append(img, m, q);
          div.append(a);
        });
        frag.append(div);
      }
      grid.style.setProperty('--gap', GAP + 'px');
      grid.replaceChildren(frag);
    }
  }
  window.TSP.Grid = Grid;

  // ---------- lightbox ----------
  let lb = document.getElementById('lightbox');
  if (!lb) {
    lb = document.createElement('div'); lb.id = 'lightbox'; lb.className = 'lightbox'; lb.hidden = true;
    lb.innerHTML = '<button class="lb-close" aria-label="Close">×</button><button class="lb-prev" aria-label="Previous">‹</button><figure><img alt=""><div class="lb-pop" hidden></div><div class="lb-bar"></div></figure><button class="lb-next" aria-label="Next">›</button>';
    document.body.append(lb);
  }
  let photos = [];
  // the big view: the photo in a frame with the logo in its lower-right corner and a clear shield on top,
  // so "Save image as…" / long-press get nothing (the files themselves stay clean)
  {
    const im = lb.querySelector('figure > img'), fr = document.createElement('div');
    fr.className = 'lb-frame';
    im.replaceWith(fr);
    fr.append(im, Object.assign(document.createElement('img'), { className: 'lb-wm', src: '/assets/logo-wordmark.png', alt: '', draggable: false }),
      Object.assign(document.createElement('div'), { className: 'lb-shield' }));
  }
  const lbImg = lb.querySelector('.lb-frame > img'), lbBar = lb.querySelector('.lb-bar'), lbPop = lb.querySelector('.lb-pop');
  const details = new Map();
  const getDetail = id => details.get(id) || (details.set(id, fetch(`/api/photo/${id}`).then(r => (r.ok ? r.json() : null)).catch(() => null)), details.get(id));
  const viewed = new Set();
  let cur = -1;
  const dim = (a, b, u) => `${Math.round(a)}×${Math.round(b)}${u}`;
  const sep = '<i class="dot">·</i>';
  function renderBar(p, d) {
    const parts = [];
    const head = `<span class="lb-t">${esc(p.title || d?.title || '')}</span>`
      + (d && (d.camera || d.year) ? `<span class="lb-m">${I.cam}${esc([d.camera, d.year].filter(Boolean).join(' · '))}</span>` : '');
    if (d) {
      const f = d.flickr;
      parts.push(`<a class="g" href="${esc(f.url || '#')}" target="_blank" rel="noopener" title="On Flickr: views · faves · comments · galleries">${SI('flickr')}
        <span>${I.eye}${n(f.views)}</span><span>${I.fav}${n(f.faves)}</span></a>`
        + (f.comments ? `<button class="g" data-c="flickr" title="Read the Flickr comments">${I.cmt}${n(f.comments)}</button>` : `<span class="g">${I.cmt}0</span>`)
        + (f.galleries ? `<span class="g" title="In ${f.galleries} Flickr galleries curated by others">${I.gal}${n(f.galleries)}</span>` : ''));
      if (d.instagram.length) {
        const g = d.instagram[0], likes = d.instagram.reduce((a, x) => a + x.likes, 0), cm = d.instagram.reduce((a, x) => a + x.comments, 0);
        parts.push(`<a class="g" href="${esc(g.url)}" target="_blank" rel="noopener" title="On Instagram${d.instagram.length > 1 ? ` (${d.instagram.length} posts)` : ''}">${SI('instagram')}<span>${I.heart}${n(likes)}</span></a>`
          + (cm ? `<button class="g" data-c="ig" title="Read the Instagram comments">${I.cmt}${n(cm)}</button>` : ''));
      }
      if (d.getty) parts.push(`<a class="g" href="${esc(d.getty.url)}" target="_blank" rel="noopener" title="License this photo on Getty Images">${SI('gettyimages')}<span>Getty ↗</span></a>`);
      if (d.place?.label) parts.push(d.place.lat != null
        ? `<button class="g" data-map title="Show on a map">${I.pin}${esc(d.place.label)}</button>` : `<span class="g">${I.pin}${esc(d.place.label)}</span>`);
      if (d.size) {
        const s3 = d.size.print300, s1 = d.size.print150;
        parts.push(`<span class="g" title="${d.size.w.toLocaleString()} × ${d.size.h.toLocaleString()} px. Prints at full detail (300 ppi) up to ${dim(...s3.cm, ' cm')} / ${dim(...s3.in, '″')}; large-format (150 ppi, viewed from further away) up to ${dim(...s1.cm, ' cm')} / ${dim(...s1.in, '″')}.">${I.px}${d.size.mp} MP
          <span class="soft">print ${dim(...s3.cm, ' cm')}</span></span>`);
      }
      parts.push(d.license.url ? `<a class="g" href="${esc(d.license.url)}" target="_blank" rel="noopener" title="${esc(d.license.name)}">${esc(d.license.mark)} <span class="soft">${esc(d.license.name)}</span></a>`
        : `<span class="g" title="© ${d.year ? d.year + ' ' : ''}Tony Shi. All rights reserved.">©<span class="soft wide">All rights reserved</span></span>`);
      if (d.tsp.views) parts.push(`<span class="g" title="Views on tonyshi.photos">${I.eye}${n(d.tsp.views)}<span class="soft wide">here</span></span>`);
    }
    parts.push(`<a class="g inq" href="${esc(inquireUrl(p))}">${I.mail}Inquire</a>`);
    parts.push(`<button class="g" data-share title="Share this photo">${I.share}<span class="soft wide">Share</span></button>`);
    lbBar.innerHTML = `<div class="lb-l">${head}</div><div class="lb-r">${parts.join(sep)}</div>`;
  }
  const show = async i => {
    cur = (i + photos.length) % photos.length;
    const p = photos[cur], mine = cur;
    lbImg.src = `/img/${p.id}/m?v=${p.v || 0}`; lbImg.alt = p.title || '';
    lbPop.hidden = true;
    renderBar(p, null);
    lb.hidden = false; document.body.style.overflow = 'hidden';
    if (!viewed.has(p.id)) { viewed.add(p.id); try { navigator.sendBeacon?.(`/api/photo/${p.id}/view`) || fetch(`/api/photo/${p.id}/view`, { method: 'POST', keepalive: true }); } catch {} }
    const d = await getDetail(p.id);
    if (mine === cur && !lb.hidden) renderBar(p, d);
    [cur - 1, cur + 1].forEach(j => { const q = photos[(j + photos.length) % photos.length]; if (q) getDetail(q.id); }); // neighbours ready
  };
  const close = () => { if (new URLSearchParams(location.search).has('p')) { const q = new URLSearchParams(location.search); q.delete('p'); history.replaceState(null, '', location.pathname + (q.size ? '?' + q : '')); }
    lb.hidden = true; lbPop.hidden = true; lbImg.removeAttribute('src'); document.body.style.overflow = ''; };
  const when = t => t ? new Date(t * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  // comments live on the site: a panel like the map, with Flickr / Instagram tabs when both have some
  const ago = t => {
    if (!t) return '';
    const d = Date.now() / 1000 - t, u = [[31536000, 'y'], [2592000, 'mo'], [604800, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']];
    for (const [s, l] of u) if (d >= s) return Math.floor(d / s) + l;
    return 'now';
  };
  const avatar = c => c.icon ? `<img class="av" src="${esc(c.icon)}" alt="" loading="lazy" data-i="${esc((c.who || '?')[0].toUpperCase())}">`
    : `<span class="av">${esc((c.who || '?')[0].toUpperCase())}</span>`;
  const cmHtml = (c, reply) => `<div class="cm${reply ? ' rp' : ''}">${avatar(c)}<div class="cb"><div><b>${esc(c.who)}</b> <span class="soft" title="${esc(when(c.at))}">${ago(c.at)}</span>${c.likes ? ` <span class="soft">· ${I.heart}${n(c.likes)}</span>` : ''}</div>
    <div class="tx">${esc(c.text).replace(/\n/g, '<br>')}</div></div></div>${(c.replies || []).map(r => cmHtml(r, true)).join('')}`;
  const cmCache = new Map();
  async function popComments(src) {
    const p = photos[cur], d = await getDetail(p.id);
    const tabs = [d?.flickr?.comments ? ['flickr', d.flickr.comments] : null,
      d?.instagram?.reduce((a, x) => a + x.comments, 0) ? ['ig', d.instagram.reduce((a, x) => a + x.comments, 0)] : null].filter(Boolean);
    lbPop.hidden = false; lbPop.dataset.src = src + ':' + p.id;
    lbPop.innerHTML = `<div class="pop-h">${tabs.map(([k, c]) => `<button class="tab${k === src ? ' on' : ''}" data-tab="${k}">${SI(k === 'ig' ? 'instagram' : 'flickr')}${k === 'ig' ? 'Instagram' : 'Flickr'} <span class="soft">${n(c)}</span></button>`).join('')}
      <button class="pop-x" aria-label="Close">×</button></div><div class="pop-b"><div class="soft">Loading comments…</div></div>`;
    const key = p.id + ':' + src;
    if (!cmCache.has(key)) cmCache.set(key, fetch(`/api/photo/${p.id}/comments?src=${src}`).then(r => r.json()).catch(() => null));
    const c = await cmCache.get(key);
    if (lbPop.hidden || lbPop.dataset.src !== src + ':' + p.id) return; // closed, or switched tab / photo meanwhile
    const b = lbPop.querySelector('.pop-b');
    if (!c || !c.comments.length) { cmCache.delete(key); b.innerHTML = `<div class="soft">${c?.unavailable ? 'Comments can’t be loaded right now — try again in a bit.' : 'No comments yet.'}</div>`; return; }
    b.innerHTML = c.comments.map(x => cmHtml(x)).join('');
  }
  async function popMap() {
    const d = await getDetail(photos[cur].id), pl = d?.place;
    if (!pl || pl.lat == null) return;
    lbPop.dataset.src = 'map';
    // Flickr accuracy 1 (world) … 16 (street): precise → a pin; approximate → a circle over the area
    const acc = +pl.accuracy || 11, precise = acc >= 15;
    const span = precise ? 0.012 : Math.min(60, 360 / Math.pow(2, acc) * 1.6);
    const bbox = [pl.lon - span, pl.lat - span * 0.62, pl.lon + span, pl.lat + span * 0.62].map(x => x.toFixed(5)).join(',');
    lbPop.hidden = false;
    lbPop.innerHTML = `<div class="pop-h">${I.pin}${esc(pl.label || '')}<span class="soft">${precise ? '' : ' · approximate'}</span><button class="pop-x" aria-label="Close">×</button></div>
      <div class="map"><iframe title="Map" loading="lazy" src="https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik${precise ? `&marker=${pl.lat},${pl.lon}` : ''}"></iframe>${precise ? '' : '<i class="area"></i>'}</div>`;
  }
  lbBar.addEventListener('click', e => {
    const sh = e.target.closest('[data-share]');
    if (sh) { const p = photos[cur]; share(sh, { url: photoUrl(p.id), title: p.title ? `${p.title} — Tony Shi` : 'A photograph by Tony Shi',
      text: p.title ? `“${p.title}” — a photograph by Tony Shi` : 'Check out this photograph by Tony Shi', image: `/img/${p.id}/m` }); return; }
    const c = e.target.closest('[data-c]'), mp = e.target.closest('[data-map]');
    const open = !lbPop.hidden && lbPop.dataset.src;
    // the same button again closes the popover; another one switches to it
    if (c) { if (open === c.dataset.c + ':' + photos[cur].id) lbPop.hidden = true; else popComments(c.dataset.c); }
    if (mp) { if (open === 'map') lbPop.hidden = true; else popMap(); }
  });
  // a click anywhere outside the open popover closes it (and only it: the lightbox stays open; arrows / × still work)
  lb.addEventListener('click', e => {
    if (lbPop.hidden || lbPop.contains(e.target) || e.target.closest('[data-c], [data-map]')) return;
    lbPop.hidden = true;
    if (!e.target.closest('button, a')) e.stopPropagation();
  }, true);
  // a Flickr buddy icon that won't load → the commenter's initial
  lbPop.addEventListener('error', e => {
    const im = e.target;
    if (im.tagName !== 'IMG' || !im.classList.contains('av')) return;
    const s = document.createElement('span'); s.className = 'av'; s.textContent = im.dataset.i || '?'; im.replaceWith(s);
  }, true);
  lbPop.addEventListener('click', e => {
    if (e.target.closest('.pop-x')) lbPop.hidden = true;
    const t = e.target.closest('[data-tab]');
    if (t && !t.classList.contains('on')) popComments(t.dataset.tab);
  });
  lb.querySelector('.lb-close').onclick = close;
  lb.querySelector('.lb-prev').onclick = () => show(cur - 1);
  lb.querySelector('.lb-next').onclick = () => show(cur + 1);
  lb.addEventListener('click', e => { if (e.target === lb || e.target.tagName === 'FIGURE') close(); });
  document.addEventListener('keydown', e => {
    if (lb.hidden) return;
    if (e.key === 'Escape') { if (!lbPop.hidden) lbPop.hidden = true; else close(); }
    if (e.key === 'ArrowLeft') show(cur - 1);
    if (e.key === 'ArrowRight') show(cur + 1);
  });
  window.TSP.lightbox = { open: (list, i) => { photos = list; show(i); } };
  const deep = new URLSearchParams(location.search).get('p');
  if (/^\d{1,20}$/.test(deep || '')) getDetail(deep).then(d => { if (d) window.TSP.lightbox.open([{ id: d.id, title: d.title, w: d.size?.w || 3, h: d.size?.h || 2, v: 0 }], 0); });
})();
