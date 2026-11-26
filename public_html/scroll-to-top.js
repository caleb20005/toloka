/**
 * Dynamic Back-to-Top button that appears when user scrolls past the navbar.
 */
(function () {
  function initScrollToTop() {
    if (document.getElementById('backToTopBtn')) return;

    var btn = document.createElement('button');
    btn.id = 'backToTopBtn';
    btn.className = 'back-to-top-btn';
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', 'Scroll back to top');
    btn.innerHTML = '<span aria-hidden="true">&#8593;</span>';
    document.body.appendChild(btn);

    function onScroll() {
      var nav = document.querySelector('header, .site-header, .topbar, .control-menu-shell');
      var threshold = nav ? Math.max(nav.offsetHeight + 20, 80) : 100;
      if (window.pageYOffset > threshold || document.documentElement.scrollTop > threshold) {
        btn.classList.add('visible');
      } else {
        btn.classList.remove('visible');
      }
    }

    btn.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScrollToTop);
  } else {
    initScrollToTop();
  }
})();
