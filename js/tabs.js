function getHashTabs() {
  const h = String(window.location.hash || '');
  const m = h.match(/tabs=([^&]+)/i);
  if (!m) return null;
  const raw = decodeURIComponent(m[1] || '');
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

function setHashTabs(tabs) {
  const url = new URL(window.location.href);
  url.hash = `tabs=${encodeURIComponent(tabs.join(','))}`;
  // avoid adding to history for every click
  window.history.replaceState(null, '', url.toString());
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function getTabOrder(root) {
  const stored = loadJson('bsky_tab_order', null);
  if (Array.isArray(stored) && stored.length) return stored.map(String);

  // Default: current DOM order.
  return Array.from(root.querySelectorAll('[data-tab]')).map((b) => b.getAttribute('data-tab')).filter(Boolean);
}

function applyTabOrder(root, order) {
  const tablist = root.querySelector('.tablist');
  const panelsWrap = root.querySelector('.panels');
  if (!tablist || !panelsWrap) return;

  const hint = tablist.querySelector('.tabhint');
  const btnBy = new Map(Array.from(tablist.querySelectorAll('[data-tab]')).map((b) => [b.getAttribute('data-tab'), b]));
  const panelBy = new Map(Array.from(panelsWrap.querySelectorAll('[data-panel]')).map((p) => [p.getAttribute('data-panel'), p]));

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

function enableSortable(root) {
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

function enablePanelResize(root) {
  const panels = Array.from(root.querySelectorAll('.panels > .panel[data-panel]'));
  if (!panels.length) return;

  const panelsWrap = root.querySelector('.panels');

  const CARD = 350;
  const GAP = 12;
  const PANELS_GAP = 16; // must match CSS gap in view.php
  const DEFAULT_MAX_COLS = 6;

  const pxNum = (v) => {
    const n = Number.parseFloat(String(v || '0'));
    return Number.isFinite(n) ? n : 0;
  };

  // Snap widths so content can fit N cards at max 350px wide.
  // This avoids the "snaps to 700 but needs ~712+" problem caused by gaps/padding/borders.
  const snapToCardColumns = (panelEl, px, opts = {}) => {
    const maxCols = Math.max(1, Math.min(10, Number(opts.maxCols || DEFAULT_MAX_COLS)));
    const scrollbarAllowance = Math.max(0, Number(opts.scrollbarAllowance ?? 18));
    const wrapPad = Math.max(0, Number(opts.wrapPad ?? 10));
    const wrapBorder = Math.max(0, Number(opts.wrapBorder ?? 1));

    const cs = window.getComputedStyle(panelEl);
    const panelPad = pxNum(cs.paddingLeft) + pxNum(cs.paddingRight);

    // Most components use a .wrap with 10px padding and 1px border.
    // We can't read inside shadow DOM reliably, so we model it here.
    const extra = panelPad + (wrapPad * 2) + (wrapBorder * 2) + scrollbarAllowance;

    const min = extra + CARD;
    const max = extra + (maxCols * CARD) + ((maxCols - 1) * GAP);
    const v = Math.max(min, Math.min(max, px));

    const avail = Math.max(0, v - extra);
    // Use floor so we never snap to a width larger than what is actually available.
    let cols = Math.floor((avail + GAP) / (CARD + GAP));
    cols = Math.max(1, Math.min(maxCols, cols));

    return extra + (cols * CARD) + ((cols - 1) * GAP);
  };

  const calcCardExtra = (panelEl, opts = {}) => {
    const scrollbarAllowance = Math.max(0, Number(opts.scrollbarAllowance ?? 18));
    const wrapPad = Math.max(0, Number(opts.wrapPad ?? 10));
    const wrapBorder = Math.max(0, Number(opts.wrapBorder ?? 1));
    const cs = window.getComputedStyle(panelEl);
    const panelPad = pxNum(cs.paddingLeft) + pxNum(cs.paddingRight);
    return panelPad + (wrapPad * 2) + (wrapBorder * 2) + scrollbarAllowance;
  };

  const widthForCardCols = (panelEl, cols, opts = {}) => {
    const extra = calcCardExtra(panelEl, opts);
    const c = Math.max(1, Math.floor(cols || 1));
    return extra + (c * CARD) + ((c - 1) * GAP);
  };

  const snapGeneric = (px) => {
    const MIN = 350;
    const MAX = 1750;
    const STEP = 350;
    const v = Math.max(MIN, Math.min(MAX, px));
    // Floor to avoid snapping wider than available.
    return Math.max(MIN, Math.floor(v / STEP) * STEP);
  };

  const snapForPanel = (panelEl, name, px) => {
    // Posts + Connections are card-based and need gap/padding-aware snapping.
    if (name === 'posts' || name === 'connections') {
      return snapToCardColumns(panelEl, px);
    }
    return snapGeneric(px);
  };

  const minForPanel = (panelEl, name) => {
    // By passing a tiny value, snapToCardColumns will clamp to its computed minimum.
    if (name === 'posts' || name === 'connections') return snapToCardColumns(panelEl, 0);
    return 350;
  };

  const widths = loadJson('bsky_panel_widths', {});

  const getVisiblePanels = () => panels.filter((p) => !p.hasAttribute('hidden'));

  const autoFitVisiblePanels = () => {
    const visible = getVisiblePanels();
    if (!visible.length) return;
    const wrapW = panelsWrap?.getBoundingClientRect()?.width || 0;
    if (!wrapW || wrapW < 50) return;

    // Only auto-fit panels that the user hasn't manually resized.
    const manual = new Map();
    const auto = [];
    for (const p of visible) {
      const name = p.getAttribute('data-panel') || '';
      const saved = widths?.[name];
      if (saved && Number.isFinite(saved)) {
        const w = snapForPanel(p, name, saved);
        manual.set(p, { name, width: w });
      } else {
        auto.push({ el: p, name });
      }
    }

    // Apply manual widths first (they consume space).
    let used = 0;
    for (const { width } of manual.values()) used += width;

    const gaps = Math.max(0, visible.length - 1) * PANELS_GAP;
    let remaining = Math.max(0, wrapW - gaps - used);

    // If everything is manual, still enforce the fixed basis (prevents flex-grow stretch).
    for (const [p, { width }] of manual.entries()) {
      p.style.flex = `0 0 ${width}px`;
      p.style.flexBasis = `${width}px`;
    }

    if (!auto.length) return;

    // Greedily distribute card columns to maximize total columns in the available width.
    // Start each auto panel at its minimum.
    const maxCols = DEFAULT_MAX_COLS;
    const state = auto.map(({ el, name }) => {
      const minW = minForPanel(el, name);
      return { el, name, cols: 1, width: minW };
    });

    const minSum = state.reduce((s, x) => s + x.width, 0);
    if (minSum > remaining) {
      // Not enough room to satisfy mins; fall back to flexing so the UI remains usable.
      for (const s of state) {
        s.el.style.flex = `1 1 ${s.width}px`;
        s.el.style.flexBasis = `${s.width}px`;
      }
      return;
    }
    remaining -= minSum;

    // Round-robin: add one column at a time while it fits.
    // (Keeps the distribution fair and avoids a single panel hogging all space.)
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const s of state) {
        if (s.name !== 'posts' && s.name !== 'connections') continue;
        if (s.cols >= maxCols) continue;
        const nextW = widthForCardCols(s.el, s.cols + 1);
        const delta = nextW - s.width;
        if (delta <= remaining) {
          s.cols += 1;
          s.width = nextW;
          remaining -= delta;
          progressed = true;
        }
      }
    }

    // Apply widths (fixed basis, no stretch).
    for (const s of state) {
      const w = snapForPanel(s.el, s.name, s.width);
      s.el.style.flex = `0 0 ${w}px`;
      s.el.style.flexBasis = `${w}px`;
    }
  };

  // Keep panels packed to content on load and when visible set changes.
  // Manual resize is persisted in widths[] and overrides auto-fit.
  const scheduleAutoFit = () => {
    requestAnimationFrame(() => autoFitVisiblePanels());
  };
  for (const p of panels) {
    const name = p.getAttribute('data-panel');
    if (!name) continue;

    // Ensure flex items can shrink, but not below a sensible minimum for their content.
    const minPx = minForPanel(p, name);
    p.style.minWidth = `${minPx}px`;

    const saved = widths?.[name];
    if (saved && Number.isFinite(saved)) {
      const next = snapForPanel(p, name, saved);
      // Prefer basis but allow shrink/grow so adjacent panels can respond.
      p.style.flex = `1 1 ${next}px`;
      p.style.flexBasis = `${next}px`;
    }

    if (p.querySelector('.resize-handle')) continue;
    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    handle.title = 'Drag to resize panel';
    p.appendChild(handle);

    let startX = 0;
    let startW = 0;
    let active = false;

    const onMove = (e) => {
      if (!active) return;
      const dx = (e.clientX || 0) - startX;

      // Clamp resize so we always leave room for other visible panels at their minimum width.
      let maxAllowed = Infinity;
      try {
        const wrapW = panelsWrap?.getBoundingClientRect()?.width || 0;
        const visibleOthers = panels.filter(x => x !== p && !x.hasAttribute('hidden'));
        const gaps = Math.max(0, (visibleOthers.length + 1 - 1)) * PANELS_GAP;
        const othersMin = visibleOthers.reduce((sum, el) => {
          const n = el.getAttribute('data-panel') || '';
          return sum + minForPanel(el, n);
        }, 0);
        if (wrapW > 0) maxAllowed = Math.max(0, wrapW - gaps - othersMin);
      } catch {}

      const raw = startW + dx;
      const capped = Number.isFinite(maxAllowed) ? Math.min(raw, maxAllowed) : raw;
      const next = snapForPanel(p, name, capped);
      // Pin width: if we only set flex-basis, flex-grow will stretch and break snapping.
      p.style.flex = `0 0 ${next}px`;
      p.style.flexBasis = `${next}px`;
      widths[name] = next;
      saveJson('bsky_panel_widths', widths);
    };
    const onUp = () => {
      if (!active) return;
      active = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    handle.addEventListener('pointerdown', (e) => {
      active = true;
      startX = e.clientX || 0;
      startW = p.getBoundingClientRect().width;
      handle.setPointerCapture?.(e.pointerId);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      e.preventDefault();
      e.stopPropagation();
    });

    handle.addEventListener('dblclick', (e) => {
      delete widths[name];
      saveJson('bsky_panel_widths', widths);
      p.style.flex = '';
      p.style.flexBasis = '';
      scheduleAutoFit();
      e.preventDefault();
      e.stopPropagation();
    });
  }

  // Auto-fit after initial handles are installed.
  scheduleAutoFit();

  // Re-fit when tabs/panels visibility changes or viewport changes.
  root.addEventListener('bsky-tabs-changed', scheduleAutoFit);
  window.addEventListener('resize', scheduleAutoFit);
}

function initTabs(root) {
  const buttons = Array.from(root.querySelectorAll('[data-tab]'));
  const panels = Array.from(root.querySelectorAll('[data-panel]'));
  const byName = new Map(panels.map(p => [p.getAttribute('data-panel'), p]));

  // One-click escape hatch if a saved panel width locks you into 1-column layouts.
  root.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('#bsky-reset-layout');
    if (!btn) return;
    try { localStorage.removeItem('bsky_panel_widths'); } catch {}
    for (const p of panels) {
      p.style.flex = '';
      p.style.flexBasis = '';
    }
    // Nudge layouts (MagicGrid uses ResizeObserver and will reflow).
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    e.preventDefault();
    e.stopPropagation();
  });

  // Apply saved ordering before we wire events.
  applyTabOrder(root, getTabOrder(root));

  const normalize = (arr) => Array.from(new Set((arr || []).filter(n => n && byName.has(n))));

  const setActive = (names) => {
    const active = normalize(names);
    if (!active.length) return;

    for (const btn of buttons) {
      const on = active.includes(btn.getAttribute('data-tab'));
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('is-active', on);
    }
    for (const p of panels) {
      const on = active.includes(p.getAttribute('data-panel'));
      p.toggleAttribute('hidden', !on);
    }

    saveJson('bsky_active_tabs', active);

    setHashTabs(active);

    // Notify panels/components that visibility changed (some layouts need a reflow).
    try {
      root.dispatchEvent(new CustomEvent('bsky-tabs-changed', { detail: { active }, bubbles: true, composed: true }));
    } catch {}
  };

  const toggle = (name) => {
    if (!name || !byName.has(name)) return;

    const current = buttons
      .filter(b => b.getAttribute('aria-pressed') === 'true')
      .map(b => b.getAttribute('data-tab'));

    const next = new Set(current);
    if (next.has(name)) {
      if (next.size === 1) return; // never allow zero
      next.delete(name);
    } else {
      next.add(name);
    }
    setActive(Array.from(next));
  };

  root.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-tab]');
    if (!btn) return;
    toggle(btn.getAttribute('data-tab'));
  });

  // Initial tabs priority: hash → localStorage → default
  let initial = getHashTabs();
  if (!initial) {
    initial = loadJson('bsky_active_tabs', null);
  }
  if (!initial || !initial.length) {
    initial = [buttons[0]?.getAttribute('data-tab') || 'posts'];
  }
  setActive(initial);

  // If user manually edits hash / uses back/forward
  window.addEventListener('hashchange', () => {
    const t = getHashTabs();
    if (t && t.length) setActive(t);
  });

  // Optional: sortable tab reorder + resizable panels
  enableSortable(root);
  enablePanelResize(root);
}

export function bootTabs() {
  const root = document.querySelector('[data-bsky-tabs]');
  if (!root) return;
  initTabs(root);
}
