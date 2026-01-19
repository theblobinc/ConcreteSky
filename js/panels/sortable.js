import { applyTabOrder } from './tab_order.js';

function motionEnabled(el) {
  try {
    const v = getComputedStyle(el || document.documentElement).getPropertyValue('--bsky-motion').trim();
    if (v === '0') return false;
    if (v === '1') return true;
  } catch {
    // ignore
  }
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  } catch {
    // ignore
  }
  return true;
}

export function enableSortable(root) {
  const tablist = root.querySelector('.tablist');
  if (!tablist) return;
  const Sortable = window.Sortable;
  if (!Sortable) return;

  // Only make actual tab buttons draggable (not the hint).
  // eslint-disable-next-line no-new
  new Sortable(tablist, {
    animation: motionEnabled(tablist) ? 150 : 0,
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
