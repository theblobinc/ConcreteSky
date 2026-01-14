import { applyTabOrder } from './tab_order.js';

export function enableSortable(root) {
  const tablist = root.querySelector('.tablist');
  if (!tablist) return;
  const Sortable = window.Sortable;
  if (!Sortable) return;

  // Only make actual tab buttons draggable (not the hint).
  // eslint-disable-next-line no-new
  new Sortable(tablist, {
    animation: 150,
    draggable: 'button.tab[data-tab]:not([data-tab="cache"])',
    filter: '.tabhint',
    onEnd: () => {
      const order = Array.from(tablist.querySelectorAll('button.tab[data-tab]'))
        .map((b) => b.getAttribute('data-tab'))
        .filter(Boolean);
      applyTabOrder(root, order);
    }
  });
}
