// Featured: a tidy collage of where the work has appeared — every tile the same size, rounded, captioned.
(() => {
  const box = document.getElementById('feats');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lb = document.getElementById('flb'), lbImg = lb.querySelector('img'), lbCap = lb.querySelector('figcaption');
  let items = [];
  fetch('/api/features').then(r => r.json()).then(d => {
    items = d.features || [];
    document.getElementById('empty').hidden = items.length > 0;
    box.innerHTML = items.map((f, i) => `
      <figure class="feat fit-${esc(f.fit || 'cover')}" style="--i:${Math.min(i, 30)}">
        <${f.url ? `a href="${esc(f.url)}" target="_blank" rel="noopener"` : `button type="button" data-i="${i}"`} class="pic" aria-label="${esc(f.title || 'Featured')}">
          ${f.fit === 'blur' ? `<span class="bg" style="background-image:url('${esc(f.src)}')"></span>` : ''}<img src="${esc(f.src)}" alt=""${esc(f.title)}" loading="${i < 8 ? 'eager' : 'lazy'}" decoding="async">
          ${f.url ? '<span class="go" aria-hidden="true">↗</span>' : ''}
        </${f.url ? 'a' : 'button'}>
        ${f.title || f.caption ? `<figcaption>${f.title ? `<span class="t">${esc(f.title)}</span>` : ''}${f.caption ? `<span class="c">${esc(f.caption)}</span>` : ''}</figcaption>` : ''}
      </figure>`).join('');
    box.querySelectorAll('.pic img').forEach(im => { const on = () => im.classList.add('in'); if (im.complete && im.naturalWidth) on(); else im.addEventListener('load', on); });
  }).catch(() => { document.getElementById('empty').hidden = false; });
  box.addEventListener('click', e => {
    const b = e.target.closest('button[data-i]'); if (!b) return;
    const f = items[+b.dataset.i];
    lbImg.src = f.src; lbImg.alt = f.title || ''; lbCap.textContent = [f.title, f.caption].filter(Boolean).join(' — ');
    lb.hidden = false; document.body.style.overflow = 'hidden';
  });
  const close = () => { lb.hidden = true; lbImg.removeAttribute('src'); document.body.style.overflow = ''; };
  lb.addEventListener('click', e => { if (e.target === lb || e.target.closest('.lb-close') || e.target.tagName === 'FIGURE') close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !lb.hidden) close(); });
})();
