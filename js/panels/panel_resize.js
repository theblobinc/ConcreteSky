import { isMobilePanelsViewport } from './panel_api.js';

export function enablePanelResize(root) {
  const panels = Array.from(root.querySelectorAll('.panels > .panel[data-panel]'));
  if (!panels.length) return;

  const panelsWrap = root.querySelector('.panels');

  // Bootstrap-ish layout columns (not cards).
  // The idea: as the viewport shrinks, we have fewer "grid units" to allocate to panels.
  // Smallest panel should be 2 units.
  const getLayoutCols = (w) => {
    const ww = Number(w || 0);
    // Bootstrap 5 breakpoints:
    // sm>=576, md>=768, lg>=992, xl>=1200, xxl>=1400.
    // We keep 2 as the minimum so panels never go below 2 grid units.
    if (ww >= 1400) return 12; // xxl
    // Keep a 12-col grid at xl so each panel can target span=3 (4 panels across).
    if (ww >= 1200) return 12; // xl
    if (ww >= 992) return 8;   // lg
    if (ww >= 768) return 6;   // md
    if (ww >= 576) return 4;   // sm
    return 2;                  // xs
  };

  // Below md, use one panel per screen (swipe between panels).
  const MOBILE_BREAKPOINT_PX = 768;

  const pxNum = (v) => {
    const n = Number.parseFloat(String(v || '0'));
    return Number.isFinite(n) ? n : 0;
  };

  const cssPx = (el, prop, fallback) => {
    try {
      const raw = window.getComputedStyle(el).getPropertyValue(prop);
      const n = Number.parseFloat(String(raw || ''));
      return Number.isFinite(n) ? n : fallback;
    } catch {
      return fallback;
    }
  };

  const getCardWidth = () => {
    // Panels snap based on the *minimum* card width.
    // Actual rendered card widths may expand to fill available space.
    return cssPx(panelsWrap || document.documentElement, '--bsky-card-min-w', 350);
  };

  const getCardGap = () => {
    return cssPx(panelsWrap || document.documentElement, '--bsky-card-gap', 12);
  };

  const getPanelsGap = () => {
    try {
      if (!panelsWrap) return 0;
      const cs = window.getComputedStyle(panelsWrap);
      // flex gap is reflected in `column-gap`/`row-gap` or `gap` depending on browser.
      const g = pxNum(cs.columnGap) || pxNum(cs.gap) || 0;
      return g;
    } catch {
      return 0;
    }
  };

  const getGridGutter = () => {
    return cssPx(panelsWrap || document.documentElement, '--bsky-grid-gutter', getPanelsGap() || 12);
  };

  const getGridCols = (wrapW) => {
    // Prefer viewport width for breakpoint logic.
    const w = window.innerWidth || wrapW || 0;
    return getLayoutCols(w);
  };

  const getGridUnit = (wrapW, cols, gutter) => {
    // Bootstrap-like: across the full row we have (cols-1) gutters.
    const gaps = Math.max(0, Number(cols || 0) - 1) * gutter;
    const avail = Math.max(0, Number(wrapW || 0) - gaps);
    return cols > 0 ? (avail / cols) : 0;
  };

  const spanWidthPx = (span, unit, gutter) => {
    const s = Math.max(1, Math.floor(Number(span || 1)));
    return (s * unit) + ((s - 1) * gutter);
  };

  const snapToGrid = (px, unit, cols, gutter, opts = {}) => {
    const minSpan = Math.max(1, Number(opts.minSpan ?? 2));
    const maxSpan = Math.max(minSpan, Number(opts.maxSpan ?? cols));
    if (!Number.isFinite(unit) || unit <= 0) return px;
    const stride = unit + gutter;
    const span = Math.max(minSpan, Math.min(maxSpan, Math.round((px + gutter) / stride)));
    return spanWidthPx(span, unit, gutter);
  };

  // Panels that should snap to "card columns" widths when data-bsky-fixed-cols is set.
  // Content behaves like a Posts subpanel and should size to the same column rhythm.
  const isCardPanel = (name) => (name === 'posts' || name === 'connections' || name === 'content');

  const getDenseExtra = (panelEl, opts = {}) => {
    const densePad = cssPx(panelsWrap || document.documentElement, '--bsky-panel-pad-dense', 4);
    const wrapPad = Math.max(0, Number(opts.wrapPad ?? densePad));
    const wrapBorder = Math.max(0, Number(opts.wrapBorder ?? 1));
    const scrollbarAllowance = Math.max(0, Number(opts.scrollbarAllowance ?? 0));
    const cs = window.getComputedStyle(panelEl);
    const panelPad = pxNum(cs.paddingLeft) + pxNum(cs.paddingRight);
    return panelPad + (wrapPad * 2) + (wrapBorder * 2) + scrollbarAllowance;
  };

  const widthForFixedCols = (panelEl, cols, opts = {}) => {
    const CARD = getCardWidth();
    const GAP = getCardGap();
    const c = Math.max(1, Math.floor(Number(cols || 1)));
    const extra = getDenseExtra(panelEl, opts);
    return extra + (c * CARD) + ((c - 1) * GAP);
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
    const CARD = getCardWidth();
    const GAP = getCardGap();
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

  const snapForPanel = (panelEl, name, px, snapCtx = null) => {
    const { unit, cols, gutter, minSpan } = snapCtx || {};
    if (Number.isFinite(unit) && unit > 0 && Number.isFinite(cols) && cols > 0) {
      return snapToGrid(px, unit, cols, gutter || 0, { minSpan: (minSpan ?? 2), maxSpan: cols });
    }
    return snapGeneric(px);
  };

  const minForPanel = (snapCtx = null) => {
    const { unit, gutter, minSpan } = snapCtx || {};
    const ms = Math.max(1, Number(minSpan ?? 2));
    if (Number.isFinite(unit) && unit > 0) return Math.max(1, spanWidthPx(ms, unit, gutter || 0));
    return 350;
  };

  // IMPORTANT: do not persist widths.
  // Persisted widths have repeatedly caused "stuck at 1-2 columns" layouts when the viewport or
  // panel chrome changes (e.g. after updates). We keep widths in-memory only.
  try { localStorage.removeItem('bsky_panel_widths'); } catch {}
  const widths = {};

  const getVisiblePanels = () => panels.filter((p) => !p.hasAttribute('hidden'));

  const getNextVisiblePanel = (panelEl) => {
    const visible = getVisiblePanels();
    const idx = visible.indexOf(panelEl);
    if (idx < 0) return null;
    return visible[idx + 1] || null;
  };

  const autoFitVisiblePanels = () => {
    const notifyPanelsResized = () => {
      try {
        window.dispatchEvent(new CustomEvent('bsky-panels-resized'));
      } catch {
        // ignore
      }
    };

    const visible = getVisiblePanels();
    if (!visible.length) { notifyPanelsResized(); return; }
    const wrapW = panelsWrap?.getBoundingClientRect()?.width || 0;
    if (!wrapW || wrapW < 50) { notifyPanelsResized(); return; }

    const gutter = getGridGutter();
    const cols = getGridCols(wrapW);
    const unit = getGridUnit(wrapW, cols, gutter);
    // When many panels are visible at once, allow panels to go down to 1 grid unit
    // so we can still fit without horizontal overflow.
    const minSpan = (visible.length * 2 > cols) ? 1 : 2;
    const snapCtx = { unit, cols, gutter, minSpan };

    // Expose grid diagnostics to CSS consumers.
    try {
      panelsWrap?.style?.setProperty?.('--bsky-layout-cols', String(cols));
      panelsWrap?.style?.setProperty?.('--bsky-grid-unit', `${Math.max(0, unit)}px`);
    } catch {}

    // Mobile: always force one panel per screen and rely on horizontal scrolling + snap.
    // This guarantees we never exceed 100% viewport width.
    if (wrapW <= MOBILE_BREAKPOINT_PX || isMobilePanelsViewport()) {
      for (const p of visible) {
        p.style.flex = '0 0 100%';
        p.style.flexBasis = '100%';
        p.style.minWidth = '100%';

        // Still expose a reasonable span/unit for components.
        try {
          p.style.setProperty('--bsky-panel-span', String(cols));
          p.style.setProperty('--bsky-grid-unit', `${Math.max(0, unit)}px`);
        } catch {}
      }
      notifyPanelsResized();
      return;
    }

    // Only auto-fit panels that the user hasn't manually resized.
    const manual = new Map();
    const auto = [];
    for (const p of visible) {
      const name = p.getAttribute('data-panel') || '';

      // Ephemeral fixed pixel basis (used for Posts ↔ Comments split behavior).
      const fixedPxRaw = p.getAttribute('data-bsky-fixed-px');
      const fixedPx = fixedPxRaw !== null ? Number.parseFloat(String(fixedPxRaw || '')) : NaN;
      if (Number.isFinite(fixedPx) && fixedPx > 0) {
        const minW = minForPanel(snapCtx);
        const w = Math.max(minW, fixedPx);
        manual.set(p, { name, width: w });
        continue;
      }

      // Ephemeral fixed cols (used by the content panel flow). Does not persist.
      const fixedRaw = p.getAttribute('data-bsky-fixed-cols');
      const fixedCols = fixedRaw !== null ? Number.parseInt(String(fixedRaw || ''), 10) : NaN;
      if (Number.isFinite(fixedCols) && fixedCols > 0 && isCardPanel(name)) {
        const w = snapForPanel(p, name, widthForFixedCols(p, fixedCols), snapCtx);
        manual.set(p, { name, width: w });
        continue;
      }

      const saved = widths?.[name];
      if (saved && Number.isFinite(saved)) {
        const w = snapForPanel(p, name, saved, snapCtx);
        manual.set(p, { name, width: w });
      } else {
        auto.push({ el: p, name });
      }
    }

    // Apply manual widths first (they consume space).
    let used = 0;
    for (const { width } of manual.values()) used += width;

    const gaps = Math.max(0, visible.length - 1) * gutter;
    let remaining = Math.max(0, wrapW - gaps - used);

    // If everything is manual, still enforce a fixed basis.
    // We allow flex-grow so panels can consume leftover space when there is slack,
    // but we keep flex-shrink at 0 so panels don't get squeezed (we want horizontal scroll instead).
    for (const [p, { name, width }] of manual.entries()) {
      const pinned = p.getAttribute('data-bsky-fixed-pin') === '1';
      const grow = (pinned || name === 'notifications') ? 0 : 1;

      // Clamp notifications to max span=2 on desktop.
      let basis = width;
      if (name === 'notifications') {
        const maxW = spanWidthPx(Math.min(cols, 2), unit, gutter);
        basis = Math.min(basis, maxW);
        try { p.style.maxWidth = `${Math.max(1, maxW)}px`; } catch {}
      } else {
        try { p.style.maxWidth = ''; } catch {}
      }

      // Allow shrinking to fit when new panels are opened.
      p.style.flex = `${grow} 1 ${basis}px`;
      p.style.flexBasis = `${basis}px`;

      // Expose an approximate span for components that want to compute columns.
      try {
        const stride = (unit + gutter) || 1;
        const span = (Number.isFinite(unit) && unit > 0)
          ? Math.max(minSpan, Math.round((basis + gutter) / stride))
          : cols;
        const clampedSpan = (name === 'notifications') ? Math.min(span, 2) : span;
        p.style.setProperty('--bsky-panel-span', String(clampedSpan));
        p.style.setProperty('--bsky-grid-unit', `${Math.max(0, unit)}px`);
      } catch {}
    }

    if (!auto.length) { notifyPanelsResized(); return; }

    // Bootstrap-ish: distribute grid spans across auto panels.
    const n = auto.length;
    const base = Math.floor(cols / n);
    const rem = cols % n;
    const spans = auto.map((_, i) => Math.max(minSpan, base + (i < rem ? 1 : 0)));

    // Apply widths (snap to whole units). If spans exceed total cols due to minSpan,
    // horizontal scrolling will kick in, which is acceptable.
    for (let i = 0; i < auto.length; i++) {
      const s = auto[i];
      let span = spans[i] || minSpan;
      if (s.name === 'notifications') span = Math.min(span, 2);
      const w0 = spanWidthPx(span, unit, gutter);
      const w = snapForPanel(s.el, s.name, w0, snapCtx);
      // Allow shrinking so panels fit without horizontal overflow.
      // Notifications should not expand beyond its clamped span.
      const grow = (s.name === 'notifications') ? 0 : 1;
      s.el.style.flex = `${grow} 1 ${w}px`;
      s.el.style.flexBasis = `${w}px`;
      s.el.style.minWidth = `${Math.max(1, spanWidthPx(minSpan, unit, gutter))}px`;
      try {
        s.el.style.setProperty('--bsky-panel-span', String(span));
        s.el.style.setProperty('--bsky-grid-unit', `${Math.max(0, unit)}px`);
        if (s.name === 'notifications') {
          const maxW = spanWidthPx(Math.min(cols, 2), unit, gutter);
          s.el.style.maxWidth = `${Math.max(1, maxW)}px`;
        } else {
          s.el.style.maxWidth = '';
        }
      } catch {}
    }

    // Notify listeners that panel widths/spans may have changed.
    notifyPanelsResized();
  };

  // Keep panels packed to content on load and when visible set changes.
  // Manual resize is persisted in widths[] and overrides auto-fit.
  const scheduleAutoFit = () => {
    requestAnimationFrame(() => autoFitVisiblePanels());
  };

  for (const p of panels) {
    const name = p.getAttribute('data-panel');
    if (!name) continue;

    // minWidth is applied during auto-fit (depends on current grid unit).

    const saved = widths?.[name];
    if (saved && Number.isFinite(saved)) {
      // Snap against the current grid when possible.
      const wrapW = panelsWrap?.getBoundingClientRect()?.width || 0;
      const visibleNow = getVisiblePanels();
      const gutter = getGridGutter();
      const cols = getGridCols(wrapW);
      const unit = getGridUnit(wrapW, cols, gutter);
      const next = snapForPanel(p, name, saved, { unit, cols, gutter });
      // Saved widths act as a basis. Allow grow, but do not shrink (we scroll instead).
      p.style.flex = `1 1 ${next}px`;
      p.style.flexBasis = `${next}px`;
    }

    let handle = p.querySelector('.resize-handle');
    if (!handle) {
      handle = document.createElement('div');
      handle.className = 'resize-handle';
      handle.title = 'Drag to resize panels';
      p.appendChild(handle);
    }

    // Reworked resizing:
    // Dragging the handle resizes the boundary between this panel and the next visible panel.
    // This keeps the overall row stable and feels like a split-pane.
    let startX = 0;
    let active = false;
    let left = null;
    let right = null;
    let leftName = '';
    let rightName = '';
    let startLeftW = 0;
    let startRightW = 0;
    let totalW = 0;
    let minLeftW = 0;
    let minRightW = 0;

    const applyBasis = (el, basisPx, mode) => {
      const w = Math.max(0, Math.round(basisPx));
      // During drag we pin widths (0 0) so the boundary tracks the pointer.
      // On release, we switch to (1 0) so panels can still grow into slack space.
      const flex = mode === 'drag' ? `0 0 ${w}px` : `1 1 ${w}px`;
      el.style.flex = flex;
      el.style.flexBasis = `${w}px`;
      return w;
    };

    const onMove = (e) => {
      if (!active || !left || !right) return;
      // Abort if visibility changed under us.
      if (left.hasAttribute('hidden') || right.hasAttribute('hidden')) return;

      const dx = (e.clientX || 0) - startX;
      const rawLeft = startLeftW + dx;

      // Clamp so both panels respect minimum widths.
      const clampedLeft = Math.max(minLeftW, Math.min(totalW - minRightW, rawLeft));
      const nextLeft = clampedLeft;
      const nextRight = totalW - nextLeft;

      const appliedLeft = applyBasis(left, nextLeft, 'drag');
      const appliedRight = applyBasis(right, nextRight, 'drag');

      // Save in-memory manual bases.
      if (leftName) widths[leftName] = appliedLeft;
      if (rightName) widths[rightName] = appliedRight;
    };

    const onUp = () => {
      if (!active) return;
      active = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);

      // Switch to grow-into-slack mode and re-auto-fit other visible panels.
      try {
        if (left && leftName && Number.isFinite(widths[leftName])) applyBasis(left, widths[leftName], 'release');
        if (right && rightName && Number.isFinite(widths[rightName])) applyBasis(right, widths[rightName], 'release');
      } catch {
        // ignore
      }
      scheduleAutoFit();
    };

    handle.addEventListener('pointerdown', (e) => {
      // Only activate if there is a next visible panel to resize against.
      const next = getNextVisiblePanel(p);
      if (!next) return;

      left = p;
      right = next;
      leftName = left.getAttribute('data-panel') || '';
      rightName = right.getAttribute('data-panel') || '';

      startX = e.clientX || 0;
      startLeftW = left.getBoundingClientRect().width;
      startRightW = right.getBoundingClientRect().width;
      totalW = startLeftW + startRightW;

      const wrapW = panelsWrap?.getBoundingClientRect()?.width || 0;
      const visibleNow = getVisiblePanels();
      const gutter = getGridGutter();
      const cols = getGridCols(wrapW);
      const unit = getGridUnit(wrapW, cols, gutter);
      const snapCtx = { unit, cols, gutter };

      minLeftW = minForPanel(snapCtx);
      minRightW = minForPanel(snapCtx);
      if (totalW < (minLeftW + minRightW)) {
        // Ensure we can always satisfy mins.
        totalW = minLeftW + minRightW;
      }

      active = true;
      handle.setPointerCapture?.(e.pointerId);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      e.preventDefault();
      e.stopPropagation();
    });

    handle.addEventListener('dblclick', (e) => {
      // Reset this boundary: clear both this panel and its next neighbor.
      const next = getNextVisiblePanel(p);
      const aName = p.getAttribute('data-panel') || '';
      const bName = next?.getAttribute?.('data-panel') || '';

      if (aName) delete widths[aName];
      if (bName) delete widths[bName];

      p.style.flex = '';
      p.style.flexBasis = '';
      if (next) {
        next.style.flex = '';
        next.style.flexBasis = '';
      }

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
