(function () {
  // USD is the fixed product currency. Backend values remain stored in KES so
  // existing M-PESA reconciliation remains accurate; the UI uses 130 KES = 1 USD.
  const KES_PER_USD = 130;
  const currencies = [{ code: 'USD', name: 'US Dollar', fallback: 1 / KES_PER_USD }];

  function injectStyles() {
    if (document.getElementById('currencyConverterStyles')) return;
    const style = document.createElement('style');
    style.id = 'currencyConverterStyles';
    style.textContent = `
      .money-with-currency {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.55rem;
        flex-wrap: wrap;
      }

      .currency-select {
        min-height: 34px;
        max-width: 145px;
        border: 1px solid rgba(16, 16, 16, 0.16);
        border-radius: 999px;
        background: #fffaf1;
        color: #101010;
        padding: 0.35rem 0.65rem;
        font: inherit;
        font-size: 0.82rem;
        font-weight: 750;
        cursor: pointer;
      }
    `;
    document.head.appendChild(style);
  }

  function formatMoney(kesAmount) {
    const amount = Number(kesAmount) || 0;
    const converted = amount / KES_PER_USD;
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(converted);
  }

  function renderElement(element) {
    if (!element) return;
    const value = Number(element.dataset.moneyValue || 0);
    element.textContent = formatMoney(value);
  }

  function renderAll() {
    document.querySelectorAll('[data-money-value]').forEach(renderElement);
  }

  function initMoneyElements() {
    injectStyles();
    renderAll();
  }

  window.LinkCurrency = {
    currencies,
    KES_PER_USD,
    formatMoney,
    renderElement,
    renderAll,
    setMoneyValue(elementOrId, kesAmount) {
      const element = typeof elementOrId === 'string' ? document.getElementById(elementOrId) : elementOrId;
      if (!element) return;
      element.dataset.moneyValue = String(Number(kesAmount) || 0);
      renderElement(element);
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    initMoneyElements();
  });
})();
