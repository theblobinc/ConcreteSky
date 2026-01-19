import { bindInfiniteScroll, resolvePanelScroller, captureScrollAnchor, applyScrollAnchor, dispatchToast } from '../panels/panel_api.js';

const noop = () => {};

export class PanelListController {
  constructor(host, opts = {}) {
    this.host = host;

    this.itemSelector = String(opts.itemSelector || '');
    this.keyAttr = String(opts.keyAttr || 'data-k');

    this.getRoot = typeof opts.getRoot === 'function'
      ? opts.getRoot
      : () => host?.shadowRoot;

    this.getScroller = typeof opts.getScroller === 'function'
      ? opts.getScroller
      : () => {
          try {
            const shell = host?.shadowRoot?.querySelector?.('bsky-panel-shell');
            const s = shell?.getScroller?.();
            return s || resolvePanelScroller(host) || document.scrollingElement || null;
          } catch {
            return resolvePanelScroller(host) || document.scrollingElement || null;
          }
        };

    this.onLoadMore = typeof opts.onLoadMore === 'function' ? opts.onLoadMore : null;
    this.onExhausted = typeof opts.onExhausted === 'function' ? opts.onExhausted : null;

    // Optional hook for windowed/virtualized lists: ensure a given key is present
    // in the DOM before attempting to apply a scroll anchor.
    this.ensureKeyVisible = typeof opts.ensureKeyVisible === 'function'
      ? opts.ensureKeyVisible
      : null;

    this.enabled = typeof opts.enabled === 'function' ? opts.enabled : () => true;
    this.isLoading = typeof opts.isLoading === 'function' ? opts.isLoading : () => false;
    this.hasMore = typeof opts.hasMore === 'function' ? opts.hasMore : () => false;

    this.threshold = Number.isFinite(opts.threshold) ? opts.threshold : 220;
    this.cooldownMs = Number.isFinite(opts.cooldownMs) ? opts.cooldownMs : 250;

    this.exhaustedCooldownMs = Number.isFinite(opts.exhaustedCooldownMs) ? opts.exhaustedCooldownMs : 5000;

    this._restoreRequested = false;
    this._restoreWantsAnchor = true;

    this._scrollTop = 0;
    this._scrollAnchor = null;

    this._infiniteScrollEl = null;
    this._unbindInfiniteScroll = null;

    this._lastToastMessage = '';
  }

  disconnect() {
    try { this._unbindInfiniteScroll?.(); } catch {}
    this._unbindInfiniteScroll = null;
    this._infiniteScrollEl = null;
  }

  requestRestore({ anchor = true } = {}) {
    this._restoreRequested = true;
    this._restoreWantsAnchor = !!anchor;
  }

  beforeRender() {
    if (!this._restoreRequested) return;

    try {
      const scroller = this.getScroller();
      if (!scroller) return;

      this._scrollTop = scroller.scrollTop || 0;

      if (this._restoreWantsAnchor && this.itemSelector) {
        const root = this.getRoot();
        this._scrollAnchor = captureScrollAnchor({
          scroller,
          root,
          itemSelector: this.itemSelector,
          keyAttr: this.keyAttr,
        });
      }
    } catch {
      // ignore
    }
  }

  afterRender() {
    if (!this._restoreRequested) {
      // Still ensure infinite scroll stays bound after a render.
      queueMicrotask(() => this.bindInfiniteScroll());
      return;
    }

    queueMicrotask(() => {
      requestAnimationFrame(() => {
        try {
          const scroller = this.getScroller();
          if (!scroller) return;

          if (this._scrollAnchor) {
            const root = this.getRoot();
            let ok = applyScrollAnchor({ scroller, root, anchor: this._scrollAnchor, keyAttr: this.keyAttr });
            if (!ok && this.ensureKeyVisible && this._scrollAnchor?.key) {
              try {
                this.ensureKeyVisible(String(this._scrollAnchor.key || ''));
              } catch {}
              try {
                const r2 = this.getRoot();
                ok = applyScrollAnchor({ scroller, root: r2, anchor: this._scrollAnchor, keyAttr: this.keyAttr });
              } catch {}
            }
            setTimeout(() => {
              try {
                const sc = this.getScroller();
                if (!sc) return;
                const r = this.getRoot();
                let ok2 = applyScrollAnchor({ scroller: sc, root: r, anchor: this._scrollAnchor, keyAttr: this.keyAttr });
                if (!ok2 && this.ensureKeyVisible && this._scrollAnchor?.key) {
                  try {
                    this.ensureKeyVisible(String(this._scrollAnchor.key || ''));
                  } catch {}
                  try {
                    const r2 = this.getRoot();
                    applyScrollAnchor({ scroller: sc, root: r2, anchor: this._scrollAnchor, keyAttr: this.keyAttr });
                  } catch {}
                }
              } catch {}
            }, 160);
          } else {
            scroller.scrollTop = Math.max(0, this._scrollTop || 0);
          }
        } catch {
          // ignore
        } finally {
          this._restoreRequested = false;
          this._scrollAnchor = null;

          // Re-bind infinite scroll after layout settles.
          queueMicrotask(() => this.bindInfiniteScroll());
        }
      });
    });
  }

  bindInfiniteScroll() {
    if (!this.onLoadMore) return;

    try {
      const scroller = this.getScroller();
      if (!scroller) return;
      if (scroller === this._infiniteScrollEl) return;

      try { this._unbindInfiniteScroll?.(); } catch {}
      this._infiniteScrollEl = scroller;

      const anchorCfg = this.itemSelector
        ? {
            getRoot: () => this.getRoot(),
            itemSelector: this.itemSelector,
            keyAttr: this.keyAttr,
          }
        : null;

      this._unbindInfiniteScroll = bindInfiniteScroll(scroller, () => this.onLoadMore?.() || noop(), {
        threshold: this.threshold,
        enabled: () => !!this.enabled(),
        isLoading: () => !!this.isLoading(),
        hasMore: () => !!this.hasMore(),
        cooldownMs: this.cooldownMs,
        onExhausted: this.onExhausted ? () => this.onExhausted?.() : undefined,
        exhaustedCooldownMs: this.onExhausted ? this.exhaustedCooldownMs : undefined,
        anchor: anchorCfg || undefined,
        // Avoid auto-fetching every page on open ("fill the viewport" loop).
        initialTick: false,
      });
    } catch {
      // ignore
    }
  }

  toastError(message, { kind = 'error', dedupe = true } = {}) {
    const msg = String(message || '').trim();
    if (!msg) return;

    if (dedupe && msg === this._lastToastMessage) return;
    this._lastToastMessage = msg;

    try {
      dispatchToast(this.host, { message: msg, kind });
    } catch {
      // ignore
    }
  }
}
