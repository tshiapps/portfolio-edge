// Aerial page: plays the reel — video clips and photo slides — as a silent, looping, full-window background.
// The next item loads underneath and crossfades in. The overlay text follows the item: the licensing pitch
// for footage, the "stunning visuals" message (or a custom caption) for photos.
(() => {
  const slides = document.getElementById('slides');
  const reel = document.getElementById('reel');
  const pitch = document.getElementById('pitch');
  const copies = {};
  pitch.querySelectorAll('[data-copy]').forEach(el => { copies[el.dataset.copy] = el; });
  const defaultH1 = Object.fromEntries(Object.entries(copies).map(([k, el]) => [k, el.querySelector('h1').innerHTML]));
  // which message an item shows: set per item in the admin, or automatic —
  // footage → licensing pitch; photo slides alternate brand message / prints
  const OVERLAY = { licensing: 'video', brand: 'photo', prints: 'prints' };
  let photoCount = 0;
  const copyFor = item => {
    if (OVERLAY[item.overlay]) return OVERLAY[item.overlay];
    if (item.kind !== 'photo') return 'video';
    return item._auto ??= (photoCount++ % 2 === 0 ? 'photo' : 'prints');
  };
  const FADE = 1.2, CLEAN_MS = 900;
  const small = Math.min(innerWidth, 1920) * (devicePixelRatio || 1) < 1400 || navigator.connection?.saveData;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let items = [], idx = 0, cur = null, next = null, timer = null, advancing = false;

  // ---- overlay text ----
  let pitchTimer = null, copyKind = 'video';
  const showPitch = delay => { if (!pitchTimer) pitchTimer = setTimeout(() => pitch.classList.add('show'), delay); };
  setTimeout(() => showPitch(0), CLEAN_MS + 4000); // autoplay blocked / slow network: don't hold the text back
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function setCopy(item, animate) {
    const kind = copyFor(item);
    const h1 = item.caption ? esc(item.caption) : defaultH1[kind];
    const apply = () => {
      for (const [k, el] of Object.entries(copies)) el.hidden = k !== kind;
      copies[kind].querySelector('h1').innerHTML = h1;
      copyKind = kind;
    };
    const target = copies[kind];
    if (!animate || (kind === copyKind && target.querySelector('h1').innerHTML === h1)) return apply();
    const shown = copies[copyKind];
    shown.classList.add('fading');
    setTimeout(() => { apply(); target.classList.add('fading'); requestAnimationFrame(() => requestAnimationFrame(() => target.classList.remove('fading'))); shown.classList.remove('fading'); }, 600);
  }

  // ---- slides ----
  function build(item) {
    let el;
    if (item.kind === 'photo') {
      el = new Image(); el.decoding = 'async'; el.alt = ''; el.src = item.src;
    } else {
      el = document.createElement('video');
      Object.assign(el, { muted: true, playsInline: true, preload: 'auto' });
      el.setAttribute('muted', ''); el.setAttribute('playsinline', '');
      el.src = (small && item.mobile) || item.desktop;
      if (items.length === 1) el.loop = true;
    }
    el.className = 'slide';
    slides.append(el);
    return { item, el };
  }

  function start(s) {
    clearTimeout(timer);
    setCopy(s.item, !!cur);
    if (s.item.kind === 'photo') {
      const d = Math.max(3, s.item.duration || 7);
      s.el.style.setProperty('--kb', `${d + FADE * 2}s`);
      // drift toward a different corner each time
      const o = ['30% 40%', '70% 40%', '40% 65%', '60% 60%'][idx % 4];
      s.el.style.setProperty('--kbo', o);
      s.el.classList.remove('kb'); void s.el.offsetWidth; s.el.classList.add('kb');
      if (items.length > 1) timer = setTimeout(advance, (d - FADE) * 1000);
      showPitch(CLEAN_MS);
    } else {
      s.el.currentTime = 0;
      s.el.play().then(() => showPitch(CLEAN_MS)).catch(() => {});
    }
    s.el.classList.add('on');
  }

  function prepareNext() {
    if (items.length < 2) return;
    const ni = (idx + 1) % items.length;
    next = build(items[ni]);
    next.i = ni;
  }

  function advance() {
    if (advancing || !next) return;
    advancing = true;
    const old = cur;
    cur = next; idx = cur.i; next = null;
    start(cur);
    old.el.classList.remove('on');
    setTimeout(() => {
      if (old.el.tagName === 'VIDEO') { old.el.pause(); old.el.removeAttribute('src'); old.el.load(); }
      old.el.remove();
      prepareNext();
      advancing = false;
    }, FADE * 1000);
  }

  // videos: start the crossfade a little before the end
  slides.addEventListener('timeupdate', e => {
    const v = e.target;
    if (cur && v === cur.el && v.duration && v.currentTime >= v.duration - FADE - 0.1) advance();
  }, true);

  fetch('/api/aerial').then(r => r.json()).then(d => {
    items = d.clips || [];
    if (!items.length) { showPitch(300); return; }
    const first = items[0];
    reel.style.backgroundImage = `url("${first.kind === 'photo' ? first.src : first.poster}")`;
    setCopy(first, false);
    if (still) { showPitch(400); return; } // reduced motion: a still + text, no movement
    cur = build(first); cur.i = 0;
    start(cur);
    prepareNext();
  }).catch(() => showPitch(300));

  document.addEventListener('visibilitychange', () => {
    if (!cur || cur.el.tagName !== 'VIDEO') return;
    if (document.hidden) cur.el.pause(); else cur.el.play().catch(() => {});
  });
})();
