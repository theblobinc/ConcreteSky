import { isMobilePanelsViewport } from './panel_api.js';

export function enablePanelResize(root) {
  const panels = Array.from(root.querySelectorAll('.panels > .panel[data-panel]'));
  if (!panels.length) return;

  const panelsWrap = root.querySelector('.panels');

  // Allow wide screens to actually use their space.
  // (Used for snapping + auto-fit distribution; actual width is still clamped by available space.)
  const DEFAULT_MAX_COLS = 20;

  // Mobile target: one panel per screen (swipe between panels).
  // Keep this higher than typical "tiny" phones to ensure no overflow.
  const MOBILE_BREAKPOINT_PX = 560;

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
    // Actual card widths inside MagicGrid may expand to fill available space.
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

  // Snap widths so content can fit N cards.
  // This avoids the "snaps to 700 but needs ~712+" problem caused by gaps/padding/borders.
  const snapToCardColumns = (panelEl, px, opts = {}) => {
    const CARD = getCardWidth();
    const GAP = getCardGap();
    const maxCols = Math.max(1, Math.min(10, Number(opts.maxCols || DEFAULT_MAX_COLS)));
    // Since panels now use <bsky-panel-shell dense>, the horizontal "chrome" is much smaller.
    // Model it using CSS vars defined on the app shell.
    const densePad = cssPx(panelsWrap || document.documentElement, '--bsky-panel-pad-dense', 4);
    const wrapPad = Math.max(0, Number(opts.wrapPad ?? densePad));
    const wrapBorder = Math.max(0, Number(opts.wrapBorder ?? 1));
    // Prefer 0 here; the grid itself sizes against scroller.clientWidth.
    const scrollbarAllowance = Math.max(0, Number(opts.scrollbarAllowance ?? 0));

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

  const snapForPanel = (panelEl, name, px) => {
    // Posts + Connections are card-based and need gap/padding-aware snapping.
    if (isCardPanel(name)) {
      return snapToCardColumns(panelEl, px);
    }
    return snapGeneric(px);
  };

  const minForPanel = (panelEl, name) => {
    // By passing a tiny value, snapToCardColumns will clamp to its computed minimum.
    if (isCardPanel(name)) return snapToCardColumns(panelEl, 0);
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
    const visible = getVisiblePanels();
    if (!visible.length) return;
    const wrapW = panelsWrap?.getBoundingClientRect()?.width || 0;
    if (!wrapW || wrapW < 50) return;

    // Mobile: always force one panel per screen and rely on horizontal scrolling + snap.
    // This guarantees we never exceed 100% viewport width.
    if (wrapW <= MOBILE_BREAKPOINT_PX || isMobilePanelsViewport()) {
      for (const p of visible) {
        p.style.flex = '0 0 100%';
        p.style.flexBasis = '100%';
        p.style.minWidth = '100%';
      }
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
        const minW = minForPanel(p, name);
        const w = Math.max(minW, fixedPx);
        manual.set(p, { name, width: w });
        continue;
      }

      // Ephemeral fixed cols (used by the content panel flow). Does not persist.
      const fixedRaw = p.getAttribute('data-bsky-fixed-cols');
      const fixedCols = fixedRaw !== null ? Number.parseInt(String(fixedRaw || ''), 10) : NaN;
      if (Number.isFinite(fixedCols) && fixedCols > 0 && isCardPanel(name)) {
        const w = snapForPanel(p, name, widthForFixedCols(p, fixedCols));
        manual.set(p, { name, width: w });
        continue;
      }

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

    const gaps = Math.max(0, visible.length - 1) * getPanelsGap();
    let remaining = Math.max(0, wrapW - gaps - used);

    // If everything is manual, still enforce a fixed basis.
    // We allow flex-grow so panels can consume leftover space when there is slack,
    // but we keep flex-shrink at 0 so panels don't get squeezed (we want horizontal scroll instead).
    for (const [p, { width }] of manual.entries()) {
      const pinned = p.getAttribute('data-bsky-fixed-pin') === '1';
      const grow = pinned ? 0 : 1;
      p.style.flex = `${grow} 0 ${width}px`;
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

    // Apply widths.
    // Allow flex-grow so remaining pixels (not enough for a whole new column) still get used.
    // Keep flex-shrink at 0 so we scroll horizontally instead of squeezing columns.
    for (const s of state) {
      const w = snapForPanel(s.el, s.name, s.width);
      const pinned = s.el.getAttribute('data-bsky-fixed-pin') === '1';
      const grow = pinned ? 0 : 1;
      s.el.style.flex = `${grow} 0 ${w}px`;
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
      // Saved widths act as a basis. Allow grow, but do not shrink (we scroll instead).
      p.style.flex = `1 0 ${next}px`;
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
      const flex = mode === 'drag' ? `0 0 ${w}px` : `1 0 ${w}px`;
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

      minLeftW = minForPanel(left, leftName);
      minRightW = minForPanel(right, rightName);
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
