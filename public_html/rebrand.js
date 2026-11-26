(function () {
  function replaceText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (!node.parentElement?.closest('script,style')) nodes.push(node);
    }
    nodes.forEach((textNode) => {
      textNode.nodeValue = textNode.nodeValue.replace(/Toloka/gi, 'Toloka').replace(/Toloka/gi, 'Toloka').replace(/toloka/gi, 'toloka').replace(/toloka/gi, 'toloka');
    });
    root.querySelectorAll('[aria-label],[title],[alt]').forEach((el) => {
      ['aria-label', 'title', 'alt'].forEach((attr) => {
        if (el.hasAttribute(attr)) el.setAttribute(attr, el.getAttribute(attr).replace(/Toloka/gi, 'Toloka').replace(/Toloka/gi, 'Toloka').replace(/toloka/gi, 'toloka').replace(/toloka/gi, 'toloka'));
      });
    });
    root.querySelectorAll('.brand > span:last-child,.physical-brand > span:last-child,.arena-brand > span:last-child,.logo').forEach((el) => {
      if (el.classList.contains('logo') || el.children.length === 0) el.textContent = 'toloka';
    });
    if (document.title) document.title = document.title.replace(/Toloka/gi, 'Toloka');
  }
  function run() { replaceText(document); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true }); else run();
})();

