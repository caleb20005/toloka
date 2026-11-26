(function () {
  const KES_PER_USD = 130;
  const moneyPattern = /\b(?:Ksh\.?|KES)\s*([0-9][0-9,]*(?:\.\d+)?)/gi;

  function formatUsd(kes) {
    return `USD $${(Number(kes) / KES_PER_USD).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function convertText(text) {
    return text
      .replace(moneyPattern, (_, value) => formatUsd(Number(String(value).replace(/,/g, ''))))
      .replace(/\bKsh\.?\b|\bKES\b/gi, 'USD');
  }

  function convertTextNode(node) {
    const parent = node.parentElement;
    if (!parent || parent.closest('script, style, textarea, pre, code, [data-usd-skip]')) return;
    const converted = convertText(node.nodeValue);
    if (converted !== node.nodeValue) node.nodeValue = converted;
  }

  function convertTree(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(convertTextNode);
  }

  function convertAttributes(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    ['placeholder', 'title', 'aria-label'].forEach(attribute => {
      const value = root.getAttribute(attribute);
      if (value && /\b(?:Ksh\.?|KES)\b/i.test(value)) root.setAttribute(attribute, convertText(value));
    });
    root.querySelectorAll?.('[placeholder], [title], [aria-label]').forEach(convertAttributes);
  }

  function observeUsdDisplay() {
    convertTree(document.body);
    convertAttributes(document.body);
    new MutationObserver(records => {
      records.forEach(record => {
        if (record.type === 'characterData') convertTextNode(record.target);
        record.addedNodes.forEach(node => {
          if (node.nodeType === Node.TEXT_NODE) convertTextNode(node);
          if (node.nodeType === Node.ELEMENT_NODE) {
            convertTree(node);
            convertAttributes(node);
          }
        });
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  window.LinkUsd = { KES_PER_USD, formatUsd, fromKes: value => Number(value) / KES_PER_USD, toKes: value => Number(value) * KES_PER_USD };
  document.addEventListener('DOMContentLoaded', observeUsdDisplay);
})();
