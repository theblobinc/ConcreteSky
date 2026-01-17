import './notifications.js';
import { bindInfiniteScroll } from '../../panel_api.js';

export class BskyNotificationsPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this._unbindInfiniteScroll = null;
    this._infiniteScrollEl = null;
  }

  connectedCallback() {
    this.render();
    queueMicrotask(() => this.bindInfiniteScroll());
  }

  disconnectedCallback() {
    if (this._unbindInfiniteScroll) { try { this._unbindInfiniteScroll(); } catch {} this._unbindInfiniteScroll = null; }
    this._infiniteScrollEl = null;
  }

  bindInfiniteScroll() {
    try {
      const shell = this.shadowRoot.querySelector('bsky-panel-shell');
      const scroller = shell?.getScroller?.();
      const notif = this.shadowRoot.querySelector('bsky-notifications');
      if (!scroller || !notif) return;

      if (scroller === this._infiniteScrollEl) return;
      try { this._unbindInfiniteScroll?.(); } catch {}
      this._infiniteScrollEl = scroller;

      this._unbindInfiniteScroll = bindInfiniteScroll(scroller, () => notif.load?.(false), {
        threshold: 220,
        enabled: () => true,
        isLoading: () => !!notif.loading,
        hasMore: () => !!notif.hasMore,
        onExhausted: () => notif.queueOlderFromServer?.(),
        exhaustedCooldownMs: 5000,
        anchor: {
          getRoot: () => notif.shadowRoot,
          itemSelector: '.n[data-k]',
          keyAttr: 'data-k',
        },
      });
    } catch {
      // ignore
    }
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{display:block}
      </style>

      <bsky-panel-shell dense title="Notifications">
        <bsky-notifications embedded></bsky-notifications>
      </bsky-panel-shell>
    `;

    queueMicrotask(() => this.bindInfiniteScroll());
  }
}

customElements.define('bsky-notifications-panel', BskyNotificationsPanel);
