(function () {
  const THEME_STORAGE_KEY = 'tolokaTheme';
  let activeModal = null;
  const modalReturnFocus = new WeakMap();

  function getFocusableElements(container) {
    return Array.from(container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(element => !element.hidden && element.offsetParent !== null);
  }

  function updateModalState(modal) {
    const isOpen = modal.classList.contains('active');
    if (isOpen) {
      if (activeModal === modal) return;
      activeModal = modal;
      modalReturnFocus.set(modal, document.activeElement);
      const focusable = getFocusableElements(modal);
      setTimeout(() => (focusable[0] || modal).focus(), 0);
      return;
    }

    if (activeModal === modal) activeModal = null;
    const opener = modalReturnFocus.get(modal);
    if (opener && document.contains(opener)) opener.focus();
  }

  function getStoredTheme() {
    // The workspace now has one accessible theme. Ignore any legacy light
    // mode preference so old localStorage values cannot reintroduce contrast
    // failures after the theme control was removed.
    return 'light';
  }

  function applyTheme(theme) {
    const safeTheme = 'light';
    document.documentElement.dataset.theme = safeTheme;
    document.documentElement.style.colorScheme = safeTheme;
    // Also set on <body> so body[data-theme] CSS rules engage correctly
    document.body.dataset.theme = safeTheme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, safeTheme);
    } catch {
      // Theme still applies for this page load when storage is unavailable.
    }

    const toggle = document.querySelector('.theme-toggle');
    if (toggle) {
      const isLight = safeTheme === 'light';
      toggle.setAttribute('aria-label', isLight ? 'Switch to dark mode' : 'Switch to light mode');
      toggle.setAttribute('title', isLight ? 'Switch to dark mode' : 'Switch to light mode');
      toggle.textContent = isLight ? 'Dark' : 'Light';
    }
  }

  applyTheme(getStoredTheme());

  function closeOpenUi() {
    document.querySelectorAll('.nav-links.show').forEach(nav => {
      nav.classList.remove('show');
      nav.setAttribute('aria-expanded', 'false');
    });

    document.querySelectorAll('.menu-toggle[aria-expanded="true"]').forEach(toggle => {
      toggle.setAttribute('aria-expanded', 'false');
    });

    document.querySelectorAll('.dropdown.active, .dropdown.open').forEach(dropdown => {
      dropdown.classList.remove('active', 'open');
      const toggle = dropdown.querySelector('.tower-menu-toggle, .dropdown-toggle');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    });

    document.querySelectorAll('.dropdown-menu').forEach(menu => {
      menu.style.display = '';
    });

    document.querySelectorAll('.work-picker.open').forEach(picker => {
      picker.classList.remove('open');
    });
  }

  function isContributorNavigation(nav) {
    if (!nav || nav.closest('.control-tower-nav, .control-tower-header, .topbar, .report-header')) return false;
    return Boolean(nav.querySelector('a[href*="Homepage.html"], a[href*="savings.html"], a[href*="Loans.html"], a[href*="withdrawal.html"], a[href*="Referals.html"], a[href*="wallet.html"], a[href*="status.html"], a[href*="history.html"], a[href*="Testimonials.html"]'));
  }

  function renderContributorNavigation() {
    document.querySelectorAll('.nav-links').forEach((nav) => {
      if (!isContributorNavigation(nav)) return;

      const page = (location.pathname.split('/').pop() || 'Homepage.html').toLowerCase();
      const active = (name) => page === name.toLowerCase() ? ' class="active"' : '';
      nav.innerHTML = `
        <li><a href="Homepage.html"${active('Homepage.html')}>Home</a></li>
        <li><a href="Testimonials.html"${active('Testimonials.html')}>Feedback &amp; Insights</a></li>
        <li><a href="Referals.html"${active('Referals.html')}>Referral Program</a></li>
        <li class="dropdown">
          <button type="button" class="dropdown-toggle" id="accountDropdown" aria-expanded="false" aria-controls="accountMenu">Account</button>
          <ul class="dropdown-menu" id="accountMenu">
            <li><a href="wallet.html"${active('wallet.html')}>Wallet</a></li>
            <li><a href="history.html"${active('history.html')}>History</a></li>
            <li><a href="login.html" id="logoutBtn" data-logout>Log out <span class="nav-arrow" aria-hidden="true">↗</span></a></li>
          </ul>
        </li>`;
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (document.body.classList.contains('link-workspace') && !document.querySelector('link[href*="workspace-core.css"]')) {
      const coreStyles = document.createElement('link');
      coreStyles.rel = 'stylesheet';
      coreStyles.href = 'workspace-core.css?v=20260903';
      document.head.appendChild(coreStyles);
    }
    if (document.body.classList.contains('link-workspace') && !document.querySelector('link[href*="workspace-polish.css"]')) {
      const polishStyles = document.createElement('link');
      polishStyles.rel = 'stylesheet';
      polishStyles.href = 'workspace-polish.css?v=20260907';
      document.head.appendChild(polishStyles);
    }
    if (document.body.classList.contains('link-workspace') && !document.querySelector('link[href*="workspace-interactions.css"]')) {
      const interactionStyles = document.createElement('link');
      interactionStyles.rel = 'stylesheet';
      interactionStyles.href = 'workspace-interactions.css?v=20260910-final';
      document.head.appendChild(interactionStyles);
    }
    renderContributorNavigation();
    applyTheme(getStoredTheme());

    const menuToggle = document.getElementById('menuToggle');
    const navLinks = document.getElementById('navLinks');

    if (menuToggle && navLinks) {
      // A few older workspace pages still render the word “Menu”. Replace it
      // with the shared, compact two-line control at runtime so every signed-in
      // screen has the same accessible trigger without changing page behavior.
      if (menuToggle.querySelectorAll(':scope > span').length !== 2) {
        menuToggle.replaceChildren(document.createElement('span'), document.createElement('span'));
      }
      menuToggle.type = 'button';
      menuToggle.setAttribute('aria-controls', navLinks.id);
      menuToggle.setAttribute('aria-expanded', String(navLinks.classList.contains('show')));
      menuToggle.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();

        const willOpen = !navLinks.classList.contains('show');
        closeOpenUi();
        navLinks.classList.toggle('show', willOpen);
        menuToggle.setAttribute('aria-expanded', String(willOpen));
      }, true);
    }

    document.querySelectorAll('.dropdown-toggle').forEach(toggle => {
      toggle.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();

        const dropdown = toggle.closest('.dropdown');
        if (!dropdown) return;

        const willOpen = !dropdown.classList.contains('open') && !dropdown.classList.contains('active');
        document.querySelectorAll('.dropdown.active, .dropdown.open').forEach(item => {
          if (item !== dropdown) {
            item.classList.remove('active', 'open');
            item.querySelector('.dropdown-toggle, .tower-menu-toggle')?.setAttribute('aria-expanded', 'false');
          }
        });

        dropdown.classList.toggle('open', willOpen);
        dropdown.classList.toggle('active', willOpen);
        toggle.setAttribute('aria-expanded', String(willOpen));
      }, true);
    });

    // Control Tower menus use their own trigger so legacy page handlers cannot
    // double-toggle or suppress the primary navigation.
    document.querySelectorAll('.tower-menu-toggle').forEach(toggle => {
      toggle.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const dropdown = toggle.closest('.dropdown');
        if (!dropdown) return;
        const willOpen = !dropdown.classList.contains('open');
        document.querySelectorAll('.dropdown.open').forEach(item => {
          if (item !== dropdown) {
            item.classList.remove('open');
            item.querySelector('.tower-menu-toggle, .dropdown-toggle')?.setAttribute('aria-expanded', 'false');
          }
        });
        dropdown.classList.toggle('open', willOpen);
        toggle.setAttribute('aria-expanded', String(willOpen));
      });
    });

    document.querySelectorAll('.dropdown-menu').forEach(menu => {
      menu.addEventListener('click', function (event) {
        event.stopPropagation();
      });
    });

    document.addEventListener('click', function (event) {
      const logout = event.target.closest('[data-logout]');
      if (!logout) return;
      event.preventDefault();
      ['token', 'userId', 'userPhone', 'referralCode', 'totalEarned', 'expectedEarning', 'savingsBalance', 'aiTimers', 'workTimers', 'mpesaSubmissions'].forEach((key) => localStorage.removeItem(key));
      window.location.assign('login.html');
    });

    document.addEventListener('click', function (event) {
      const clickedOpenTrigger = event.target.closest('.menu-toggle, .dropdown-toggle, .tower-menu-toggle, .work-btn');
      const clickedOpenPanel = event.target.closest('.nav-links.show, .dropdown.open .dropdown-menu, .dropdown.active .dropdown-menu, .work-picker.open .work-type-menu, .modal-content');

      if (!clickedOpenTrigger && !clickedOpenPanel) closeOpenUi();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (activeModal) {
          event.preventDefault();
          activeModal.querySelector('[data-modal-close], .btn-secondary')?.click();
          return;
        }
        closeOpenUi();
      }

      if (event.key === 'Tab' && activeModal) {
        const focusable = getFocusableElements(activeModal);
        if (!focusable.length) {
          event.preventDefault();
          activeModal.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });

    document.querySelectorAll('.toast').forEach(toast => {
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      toast.setAttribute('aria-atomic', 'true');
    });

    document.querySelectorAll('.modal').forEach((modal, index) => {
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('tabindex', '-1');
      const heading = modal.querySelector('h1, h2, h3');
      if (heading) {
        if (!heading.id) heading.id = `${modal.id || 'dialog'}-title-${index + 1}`;
        modal.setAttribute('aria-labelledby', heading.id);
      }
      updateModalState(modal);
      new MutationObserver(() => updateModalState(modal)).observe(modal, { attributes: true, attributeFilter: ['class'] });
    });
  });
})();
