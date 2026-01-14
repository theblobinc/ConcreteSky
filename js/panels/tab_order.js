import { loadJson, saveJson } from './storage.js';

export function getTabOrder(root) {
  const stored = loadJson('bsky_tab_order', null);
  if (Array.isArray(stored) && stored.length) return stored.map(String);

  // Default: current DOM order.
  return Array.from(root.querySelectorAll('[data-tab]'))
    .map((b) => b.getAttribute('data-tab'))
    .filter(Boolean);
}

export function applyTabOrder(root, order) {
  const tablist = root.querySelector('.tablist');
  const panelsWrap = root.querySelector('.panels');
  if (!tablist || !panelsWrap) return;

  const hint = tablist.querySelector('.tabhint');
  const btnBy = new Map(
    Array.from(tablist.querySelectorAll('[data-tab]')).map((b) => [b.getAttribute('data-tab'), b])
  );
  const panelBy = new Map(
    Array.from(panelsWrap.querySelectorAll('[data-panel]')).map((p) => [p.getAttribute('data-panel'), p])
  );

  const final = [];
  for (const name of (order || [])) {
    if (btnBy.has(name)) final.push(name);
  }
  for (const name of btnBy.keys()) {
    if (!final.includes(name)) final.push(name);
  }

  // Always keep cache at the end (not user-sortable).
  const CACHE = 'cache';
  const withoutCache = final.filter((n) => n !== CACHE);
  if (btnBy.has(CACHE)) withoutCache.push(CACHE);
  const finalOrdered = withoutCache;

  for (const name of finalOrdered) {
    tablist.appendChild(btnBy.get(name));
  }
  if (hint) tablist.appendChild(hint);

  for (const name of finalOrdered) {
    const p = panelBy.get(name);
    if (p) panelsWrap.appendChild(p);
  }

  saveJson('bsky_tab_order', finalOrdered);
}
