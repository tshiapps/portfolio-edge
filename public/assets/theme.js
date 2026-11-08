// Logo fallback: if the wordmark image can't load, the name in text (no inline handlers — the CSP forbids them)
(() => {
  const w = document.querySelector('.logo img.wordmark');
  if (!w) return;
  const fb = () => { const s = document.createElement('span'); s.className = 'word'; s.innerHTML = '<span class="name">TONY SHI</span><span class="sub">PHOTOGRAPHY</span>'; w.replaceWith(s); };
  if (w.complete && !w.naturalWidth) fb(); else w.addEventListener('error', fb);
})();

// Photos: no right-click "Save image as…", no dragging them out, no long-press save on phones.
// (A deterrent, not a lock: screenshots and developer tools can't be stopped by any website.)
(() => {
  const PHOTO = 'img, .lb-frame, .jgrid a, .reel, .feat';
  document.addEventListener('contextmenu', e => { if (e.target.closest?.(PHOTO) && !e.target.closest('.lb-bar, .lb-pop, .social, .logo')) e.preventDefault(); });
  document.addEventListener('dragstart', e => { if (e.target.tagName === 'IMG' || e.target.closest?.('.jgrid a, .lb-frame')) e.preventDefault(); });
})();

// Light/dark toggle: follows the device until the visitor picks; the choice is remembered on this device.
(() => {
  const root = document.documentElement;
  const btn = document.querySelector('.theme-toggle');
  if (!btn) return;
  const dark = () => root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const label = () => { const d = dark(); btn.title = d ? 'Switch to light' : 'Switch to dark'; btn.setAttribute('aria-label', btn.title); };
  btn.addEventListener('click', () => {
    const next = dark() ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch {}
    label();
  });
  label();
})();
