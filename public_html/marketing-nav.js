(function () {
  const header = document.querySelector('[data-marketing-nav], .site-header, .physical-nav, .arena-nav');
  if (!header) return;
  // This is inserted by the shared navigation script as a fallback for public
  // pages whose legacy <head> markup predates the final responsive menu layer.
  if (!document.querySelector('link[href*="navigation-final.css"]')) {
    const navigationStyles = document.createElement('link');
    navigationStyles.rel = 'stylesheet';
    navigationStyles.href = 'navigation-final.css?v=20260910-final';
    document.head.appendChild(navigationStyles);
  }
  // Enterprise starts with the legacy site-header class. Give every public
  // page the same structural nav class before replacing its markup.
  header.classList.add('shared-marketing-nav');
  header.setAttribute('data-marketing-nav', '');
  if (!document.querySelector('link[href*="toloka-public.css"]') && !document.body.classList.contains('arena-page') && !document.body.classList.contains('physical-page')) {
    const publicSkin = document.createElement('link');
    publicSkin.rel = 'stylesheet';
    publicSkin.href = 'toloka-public.css?v=20260903';
    document.head.appendChild(publicSkin);
    document.body.classList.add('toloka-benchmark');
  }
  const page = (location.pathname.split('/').pop() || 'landing.html').toLowerCase();
  const active = (name) => page === name ? ' class="active"' : '';
  header.innerHTML = `<a class="brand" href="landing.html" aria-label="Toloka home"><span class="brand-mark"><i></i><i></i></span><span>toloka</span></a><nav class="marketing-desktop" aria-label="Primary navigation"><a href="landing.html#solutions"${active('landing.html')}>Data Solutions</a><a href="enterprise.html"${active('enterprise.html')}>Enterprise</a><a href="physical-ai.html"${active('physical-ai.html')}>Physical AI</a><a href="arena.html"${active('arena.html')}>Arena <em>β</em></a><a href="landing.html#insights">Resource Hub</a><a href="landing.html#footer">Company</a></nav><div class="marketing-actions shared-marketing-actions"><a href="arena.html">Arena ↗</a><a href="login.html">Log in <span class="login-arrow" aria-hidden="true">↗</span></a><a class="marketing-cta" href="enterprise.html#contact">Talk to us ↗</a></div><button class="shared-marketing-menu" type="button" aria-label="Open navigation" aria-expanded="false"><span></span><span></span></button>`;
  const mobile = document.createElement('nav');
  mobile.className = 'shared-marketing-mobile';
  mobile.setAttribute('aria-label', 'Mobile navigation');
  mobile.innerHTML = `<a href="landing.html#solutions">Data Solutions</a><a href="enterprise.html">Enterprise</a><a href="physical-ai.html">Physical AI</a><a href="arena.html">Arena <em>β</em></a><a href="landing.html#insights">Resource Hub</a><a href="landing.html#footer">Company</a><a href="login.html">Log in <span class="login-arrow" aria-hidden="true">↗</span></a>`;
  header.after(mobile);
  const button = header.querySelector('.shared-marketing-menu');
  button.addEventListener('click', () => { const open = mobile.classList.toggle('open'); button.setAttribute('aria-expanded', String(open)); });
  mobile.addEventListener('click', (event) => { if (event.target.closest('a')) { mobile.classList.remove('open'); button.setAttribute('aria-expanded', 'false'); } });
})();
