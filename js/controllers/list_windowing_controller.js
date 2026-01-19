const noop = () => {};

// Generic DOM windowing helper for list-like panels.
//
// It renders only a slice of items + top/bottom spacers to approximate full scroll height,
// and can materialize a given key on demand (for scroll-anchor restore).
export class ListWindowingController {
  constructor(host, opts = {}) {
    this.host = host;

    this.listSelector = String(opts.listSelector || '.list');
    this.itemSelector = String(opts.itemSelector || '');
    this.keyAttr = String(opts.keyAttr || 'data-k');

    this.getListEl = typeof opts.getListEl === 'function'
      ? opts.getListEl
      : null;

    this.getRoot = typeof opts.getRoot === 'function'
      ? opts.getRoot
      : () => host?.shadowRoot;

    this.getScroller = typeof opts.getScroller === 'function'
      ? opts.getScroller
      : () => null;

    this.enabled = typeof opts.enabled === 'function' ? opts.enabled : () => true;
    this.getLayout = typeof opts.getLayout === 'function' ? opts.getLayout : () => 'list'; // 'list' | 'grid'

    this.getColumns = typeof opts.getColumns === 'function'
      ? opts.getColumns
      : null;

    this.onAfterRender = typeof opts.onAfterRender === 'function'
      ? opts.onAfterRender
      : null;

    this.keyFor = typeof opts.keyFor === 'function' ? opts.keyFor : (it) => String(it?.key || '');
    this.renderRow = typeof opts.renderRow === 'function' ? opts.renderRow : () => '';

    this.estimatePx = Number.isFinite(opts.estimatePx) ? opts.estimatePx : 72;
    this.overscanItems = Number.isFinite(opts.overscanItems) ? opts.overscanItems : 30;
    this.minItemsToWindow = Number.isFinite(opts.minItemsToWindow) ? opts.minItemsToWindow : 220;

    this._start = 0;
    this._end = 0;

    this._items = null;
    this._keyToIndex = null;

    this._scroller = null;
    this._unbindScroll = null;

    this._resizeHandler = null;
    this._raf = 0;
  }

  disconnect() {
    if (this._resizeHandler) {
      try { window.removeEventListener('resize', this._resizeHandler); } catch {}
      this._resizeHandler = null;
    }

    try { this._unbindScroll?.(); } catch {}
    this._unbindScroll = null;
    this._scroller = null;

    if (this._raf) {
      try { cancelAnimationFrame(this._raf); } catch {}
      this._raf = 0;
    }
  }

  connect() {
    if (!this._resizeHandler) {
      this._resizeHandler = () => this.scheduleRerender();
      try { window.addEventListener('resize', this._resizeHandler); } catch {}
    }
    this.bindScroller();
  }

  setItems(items) {
    this._items = Array.isArray(items) ? items : [];
    this._keyToIndex = new Map();

    try {
      for (let i = 0; i < this._items.length; i++) {
        const k = String(this.keyFor(this._items[i]) || '');
        if (k) this._keyToIndex.set(k, i);
      }
    } catch {
      // ignore
    }
  }

  bindScroller() {
    try {
      const scroller = this.getScroller?.() || null;
      if (!scroller || scroller === this._scroller) return;

      try { this._unbindScroll?.(); } catch {}
      this._scroller = scroller;

      const onScroll = () => this.scheduleRerender();
      scroller.addEventListener('scroll', onScroll, { passive: true });
      this._unbindScroll = () => {
        try { scroller.removeEventListener('scroll', onScroll); } catch {}
      };
    } catch {
      // ignore
    }
  }

  scheduleRerender() {
    if (!this.enabled()) return;
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.bindScroller();
      this.rerenderWindowOnly();
    });
  }

  // Used by scroll-anchor restore hooks.
  ensureKeyVisible(key) {
    try {
      const k = String(key || '').trim();
      if (!k) return;
      if (!this.enabled()) return;

      const idx = this._keyToIndex?.get?.(k);
      if (!Number.isFinite(idx) || idx < 0) return;

      const total = this._items?.length || 0;
      const layout = String(this.getLayout?.() || 'list');

      const { cols } = this._getGridInfo(layout);
      const overscan = Math.max(10, Number(this.overscanItems || 30));
      const maxRender = Math.max(120, overscan * 8);

      let newStart = 0;
      let newEnd = total;

      if (layout === 'grid' && cols > 1) {
        const centerRow = Math.floor(idx / cols);
        const overscanRows = Math.max(2, Math.ceil(overscan / cols));
        const maxRows = Math.max(10, Math.ceil(maxRender / cols));

        let startRow = Math.max(0, centerRow - overscanRows);
        let endRow = Math.min(Math.ceil(total / cols), startRow + maxRows);
        if (endRow - startRow < maxRows) startRow = Math.max(0, endRow - maxRows);

        newStart = startRow * cols;
        newEnd = Math.min(total, endRow * cols);
      } else {
        newStart = Math.max(0, idx - overscan);
        newEnd = Math.min(total, newStart + maxRender);
        if (newEnd - newStart < maxRender) newStart = Math.max(0, newEnd - maxRender);
      }

      if (idx >= newStart && idx < newEnd) return;

      this._start = newStart;
      this._end = newEnd;
      this.rerenderWindowOnly({ force: true });
    } catch {
      // ignore
    }
  }

  innerHtml({ loadingHtml = '<div class="muted">Loading…</div>', emptyHtml = '<div class="muted">Empty.</div>' } = {}) {
    const items = this._items || [];
    const total = items.length;

    if (!total) return String(emptyHtml || '');

    const enabled = !!this.enabled();
    const layout = String(this.getLayout?.() || 'list');

    if (!enabled || total < this.minItemsToWindow) {
      return items.map((it) => this.renderRow(it)).join('');
    }

    const w = this._computeWindow(total, layout);
    const slice = items.slice(w.start, w.end);
    const rows = slice.map((it) => this.renderRow(it)).join('');

    const dbg = this._debugEnabled()
      ? (() => {
          const shown = Math.max(0, (w.end - w.start));
          const est = Math.round(Math.max(0, Number(this.estimatePx || 0)));
          const cols = (() => {
            try {
              if (layout !== 'grid') return 1;
              const info = this._getGridInfo(layout);
              return Math.max(1, Number(info?.cols || 1));
            } catch {
              return 1;
            }
          })();

          const msg = (layout === 'grid')
            ? `win grid cols=${cols} show=${shown}/${total} [${w.start}..${Math.max(w.start, w.end - 1)}] est=${est}px`
            : `win list show=${shown}/${total} [${w.start}..${Math.max(w.start, w.end - 1)}] est=${est}px`;

          return `
            <div
              class="win-debug"
              aria-hidden="true"
              style="position:sticky;top:0;z-index:3;pointer-events:none;font:12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;color:#ddd;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.18);padding:3px 6px;margin:0 0 6px;max-width:max-content"
            >${msg}</div>
          `;
        })()
      : '';

    return `
      ${dbg}
      <div class="win-spacer" data-win-spacer="top" aria-hidden="true" style="height:${Math.max(0, Math.round(w.topPx))}px"></div>
      ${rows || String(loadingHtml || '')}
      <div class="win-spacer" data-win-spacer="bottom" aria-hidden="true" style="height:${Math.max(0, Math.round(w.bottomPx))}px"></div>
    `;
  }

  _debugEnabled() {
    try {
      // Opt-in only: `localStorage.setItem('bsky_debug_windowing','1')`
      return String(localStorage?.getItem?.('bsky_debug_windowing') || '') === '1';
    } catch {
      return false;
    }
  }

  rerenderWindowOnly({ force = false } = {}) {
    try {
      const root = this.getRoot?.();
      if (!root) return;

      const list = this.getListEl?.() || root.querySelector?.(this.listSelector);
      if (!list) return;

      const items = this._items || [];
      const total = items.length;

      const enabled = !!this.enabled();
      const layout = String(this.getLayout?.() || 'list');
      if (!enabled || total < this.minItemsToWindow) return;

      const prevStart = this._start;
      const prevEnd = this._end;
      const w = this._computeWindow(total, layout);
      if (!force && w.start === prevStart && w.end === prevEnd) return;

      list.innerHTML = this.innerHtml();
      this.afterRender();
    } catch {
      // ignore
    }
  }

  afterRender() {
    this.connect();
    this._updateEstimateFromDom();
    try { this.onAfterRender?.(); } catch {}
  }

  _updateEstimateFromDom() {
    try {
      const root = this.getRoot?.();
      if (!root) return;
      if (!this.enabled()) return;

      const layout = String(this.getLayout?.() || 'list');
      const selector = this.itemSelector || '';
      if (!selector) return;

      const scope = this.getListEl?.() || root;
      const els = Array.from(scope.querySelectorAll(selector) || []);
      if (!els.length) return;

      const sample = els.slice(0, 8)
        .map((el) => el.getBoundingClientRect?.().height || 0)
        .filter((h) => Number.isFinite(h) && h > 20);
      if (!sample.length) return;

      const avg = sample.reduce((a, b) => a + b, 0) / sample.length;
      const clamped = Math.max(28, Math.min(260, avg));

      const old = Math.max(28, Number(this.estimatePx || 72));
      // Keep it sticky to avoid spacer jitter.
      const next = (old * 0.85) + (clamped * 0.15);

      this.estimatePx = Math.max(28, Math.min(260, next));

      // If we're grid, rows tend to be taller than the average item.
      // A small bump helps reduce underestimation.
      if (layout === 'grid') {
        this.estimatePx = Math.max(this.estimatePx, Math.min(320, this.estimatePx * 1.12));
      }
    } catch {
      // ignore
    }
  }

  _getGridInfo(layout) {
    if (layout !== 'grid') return { cols: 1 };

    try {
      const explicit = Number(this.getColumns?.() || 0);
      if (Number.isFinite(explicit) && explicit >= 1) return { cols: Math.max(1, Math.floor(explicit)) };
    } catch {
      // ignore
    }

    try {
      const root = this.getRoot?.();
      const list = this.getListEl?.() || root?.querySelector?.(this.listSelector);
      if (!list) return { cols: 1 };

      const cs = getComputedStyle(list);
      const tmpl = String(cs.gridTemplateColumns || '').trim();
      if (tmpl) {
        const cols = tmpl.split(/\s+/).filter(Boolean).length;
        if (Number.isFinite(cols) && cols >= 1) return { cols };
      }
    } catch {
      // ignore
    }

    return { cols: 1 };
  }

  _computeWindow(total, layout) {
    const scroller = this._scroller || this.getScroller?.() || null;
    let st = Math.max(0, Number(scroller?.scrollTop || 0));
    const vh = Math.max(200, Number(scroller?.clientHeight || 800));

    // If the list is not the first child of the scroller, convert the global scrollTop
    // into a scroll position within the list itself.
    try {
      const root = this.getRoot?.();
      const list = this.getListEl?.() || root?.querySelector?.(this.listSelector) || null;
      if (scroller && list && typeof scroller.getBoundingClientRect === 'function' && typeof list.getBoundingClientRect === 'function') {
        const r0 = scroller.getBoundingClientRect();
        const r1 = list.getBoundingClientRect();
        const delta = Number(r1.top - r0.top);
        if (Number.isFinite(delta)) {
          st = Math.max(0, -delta);
        }
      }
    } catch {
      // ignore
    }

    const est = Math.max(28, Number(this.estimatePx || 72));
    const overscan = Math.max(10, Number(this.overscanItems || 30));

    if (layout === 'grid') {
      const { cols } = this._getGridInfo(layout);
      const safeCols = Math.max(1, Number(cols || 1));
      const totalRows = Math.max(1, Math.ceil(total / safeCols));

      const approxFirstRow = Math.floor(st / est);
      const overscanRows = Math.max(2, Math.ceil(overscan / safeCols));

      let startRow = Math.max(0, approxFirstRow - overscanRows);
      const wantRows = Math.ceil(vh / est) + (overscanRows * 2);
      let endRow = Math.min(totalRows, startRow + Math.max(6, wantRows));

      const maxRows = Math.max(10, Math.ceil(Math.max(120, overscan * 8) / safeCols));
      if ((endRow - startRow) > maxRows) endRow = Math.min(totalRows, startRow + maxRows);
      if (endRow <= startRow) {
        startRow = Math.max(0, totalRows - maxRows);
        endRow = totalRows;
      }

      const start = startRow * safeCols;
      const end = Math.min(total, endRow * safeCols);

      this._start = start;
      this._end = end;

      const topPx = startRow * est;
      const bottomPx = Math.max(0, (totalRows - endRow) * est);
      return { start, end, topPx, bottomPx };
    }

    // list
    const approxFirst = Math.floor(st / est);
    let start = Math.max(0, approxFirst - overscan);
    const want = Math.ceil(vh / est) + (overscan * 2);
    let end = Math.min(total, start + Math.max(50, want));

    const maxRender = Math.max(120, overscan * 8);
    if ((end - start) > maxRender) end = Math.min(total, start + maxRender);
    if (end <= start) {
      start = Math.max(0, total - Math.min(total, maxRender));
      end = total;
    }

    this._start = start;
    this._end = end;

    const topPx = start * est;
    const bottomPx = Math.max(0, (total - end) * est);
    return { start, end, topPx, bottomPx };
  }
}
