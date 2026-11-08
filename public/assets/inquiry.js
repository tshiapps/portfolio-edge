(() => {
  const form = document.getElementById('inq');
  const msg = document.getElementById('msg');
  const btn = form.querySelector('button');
  let widget = null, token = '';

  fetch('/api/config').then(r => r.json()).then(cfg => {
    if (!cfg.inquiryReady || !cfg.turnstileSiteKey) {
      btn.disabled = true;
      msg.className = 'formmsg'; msg.textContent = 'The inquiry form is being set up — please check back soon.';
      return;
    }
    const render = () => {
      if (!window.turnstile) return setTimeout(render, 200);
      widget = turnstile.render('#ts', {
        sitekey: cfg.turnstileSiteKey,
        callback: t => { token = t; },
        'expired-callback': () => { token = ''; },
      });
    };
    render();
  });

  // clicking a service starts the message about it
  document.querySelectorAll('.svc').forEach(card => card.addEventListener('click', e => {
    if (e.target.closest('a')) return; // the "See the reel" link just navigates
    document.querySelectorAll('.svc').forEach(c => c.classList.toggle('on', c === card));
    form.subject.value = card.dataset.subject;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => (form.name.value ? form.message : form.name).focus({ preventScroll: true }), 400);
  }));
  document.querySelectorAll('.svc').forEach(card => card.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('a')) { e.preventDefault(); card.click(); }
  }));

  // arriving from a link like /inquiry?subject=prints → that card preselected
  const want = new URLSearchParams(location.search).get('subject');
  if (want) {
    const card = [...document.querySelectorAll('.svc')].find(c => c.dataset.subject.toLowerCase().startsWith(want.toLowerCase()));
    if (card) { card.classList.add('on'); form.subject.value = card.dataset.subject; }
  }

  // arriving from a photo's "Inquire" button: /inquiry?photo=<id>&title=<title>
  const qs = new URLSearchParams(location.search);
  const photo = (qs.get('photo') || '').replace(/\D/g, '').slice(0, 12);
  const prev = document.getElementById('assetPrev');
  if (photo) {
    const title = (qs.get('title') || '').slice(0, 150);
    form.asset.value = `Photo #${photo}${title ? ` “${title}”` : ''}`;
    if (!form.subject.value) form.subject.value = 'About a photo';
    prev.querySelector('img').src = `/img/${photo}/t`;
    prev.querySelector('img').onerror = () => prev.querySelector('img').remove();
    prev.querySelector('.asset-t').textContent = title || `#${photo}`;
    prev.hidden = false;
    prev.querySelector('.asset-x').onclick = () => { prev.hidden = true; form.asset.value = ''; if (form.subject.value === 'About a photo') form.subject.value = ''; };
    setTimeout(() => { form.scrollIntoView({ behavior: 'smooth', block: 'start' }); form.name.focus({ preventScroll: true }); }, 300);
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    msg.className = 'formmsg'; msg.textContent = '';
    const data = Object.fromEntries(new FormData(form));
    if (!data.name || !data.email || !data.message) { msg.className = 'formmsg bad'; msg.textContent = 'Please fill in your name, email and message.'; return; }
    if (!token) { msg.className = 'formmsg bad'; msg.textContent = 'Please complete the anti-bot check.'; return; }
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const res = await fetch('/api/inquiry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...data, token }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'Could not send.');
      form.reset(); prev.hidden = true;
      msg.textContent = 'Thanks — your message is on its way.';
    } catch (err) {
      msg.className = 'formmsg bad'; msg.textContent = err.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Send';
      token = ''; if (widget !== null) turnstile.reset(widget);
    }
  });
})();
