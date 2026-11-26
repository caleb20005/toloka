(() => {
  const pendingKey = 'vpsRoutingNoticePendingUserId';

  document.addEventListener('DOMContentLoaded', async () => {
    const notice = document.getElementById('vpsRoutingNotice');
    const checkbox = document.getElementById('vpsRoutingNoticeAcknowledge');
    const closeButton = document.getElementById('vpsRoutingNoticeClose');
    const status = document.getElementById('vpsRoutingNoticeStatus');
    const currentUserId = localStorage.getItem('userId');

    if (!notice || !currentUserId || sessionStorage.getItem(pendingKey) !== currentUserId) return;

    try {
      const response = await fetch('/api/user/vps-routing-notice');
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.acknowledged) {
        sessionStorage.removeItem(pendingKey);
        return;
      }
    } catch (_) {
      // Keep the acknowledgement gate visible if its current status cannot be
      // read. The user can retry saving it with the enabled close control.
    }

    notice.classList.add('is-open');
    notice.setAttribute('aria-hidden', 'false');
    document.body.classList.add('vps-routing-notice-open');
    checkbox.focus();

    checkbox.addEventListener('change', () => {
      closeButton.disabled = !checkbox.checked;
      status.textContent = '';
    });

    notice.addEventListener('click', (event) => {
      if (event.target === notice) event.preventDefault();
    });

    document.addEventListener('keydown', (event) => {
      if (!notice.classList.contains('is-open')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...notice.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }, true);

    closeButton.addEventListener('click', async () => {
      if (!checkbox.checked || closeButton.disabled) return;
      closeButton.disabled = true;
      checkbox.disabled = true;
      status.textContent = 'Saving your acknowledgement…';

      try {
        const response = await fetch('/api/user/vps-routing-notice/acknowledge', { method: 'POST' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) throw new Error(data.message || 'Unable to save your acknowledgement.');
        sessionStorage.removeItem(pendingKey);
        notice.classList.remove('is-open');
        notice.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('vps-routing-notice-open');
      } catch (error) {
        status.textContent = error.message || 'Unable to save your acknowledgement. Please try again.';
        checkbox.disabled = false;
        closeButton.disabled = false;
      }
    });
  });
})();
