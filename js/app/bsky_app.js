import { call } from '../api.js';
import { bootTabs } from '../tabs.js';
import { getPanelTemplates, getDefaultActiveTabs } from '../panels/panel_api.js';

// Side-effect imports: define custom elements used in the shell.
import '../components/profile.js';
import '../components/notification_bar.js';
import '../components/panel_shell.js';
import '../components/my_posts.js';
import '../components/connections.js';
import '../components/people_search.js';
import '../components/thread_tree.js';
import '../components/comment_composer.js';
import '../components/content_panel.js';
import '../components/notifications_panel.js';
import '../components/interactions/interactions-modal.js';

class BskyApp extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this._tabsBooted = false;
    this._authRefreshInFlight = null;
    this._lastConnected = null;

    // Ephemeral layout overrides (do not persist to localStorage).
    this._fixedColsPrev = new Map(); // panelName -> previous string|null
    this._fixedPxPrev = new Map();   // panelName -> previous string|null
    this._fixedPinPrev = new Map();  // panelName -> previous string|null
  }

  connectedCallback() {
    this.render();

    // When the user toggles tabs, only mount the active panels.
    try {
      const root = this.shadowRoot.querySelector('[data-bsky-tabs]');
      root?.addEventListener('bsky-tabs-changed', (e) => {
        const active = Array.isArray(e?.detail?.active) ? e.detail.active : this.getActiveTabsFromDom();
        const visible = Array.isArray(e?.detail?.visible) ? e.detail.visible : active;
        this.mountPanels(visible);

        // If the content panel is not active anymore (user closed it via tab),
        // drop the temporary sizing + selection.
        if (!visible.includes('content')) {
          this.clearFixedPx(['posts', 'content']);
          if (Array.isArray(this._contentPinnedPanels) && this._contentPinnedPanels.length) {
            this.clearFixedPx(this._contentPinnedPanels);
            this._contentPinnedPanels = [];
          }
          this.clearFixedCols(['posts', 'content']);
          const cp = this.shadowRoot.querySelector('bsky-content-panel');
          cp?.setSelection?.(null);
        }
      });
    } catch {
      // ignore
    }

    // Content panel open/close flow (bubbled from posts/notifications/etc).
    this.addEventListener('bsky-open-content', (e) => {
      try { this.openContent(e?.detail || {}); } catch {}
    }, { capture: true });
    this.addEventListener('bsky-close-content', () => {
      try { this.closeContent(); } catch {}
    }, { capture: true });

    // Initial gating and transitions on connect/disconnect.
    this.initGate();

    // If the user returns to the tab/page after OAuth (bfcache restore or focus), refresh auth state.
    window.addEventListener('pageshow', () => {
      this.scheduleAuthRefresh();
    });
    window.addEventListener('focus', () => {
      this.scheduleAuthRefresh();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.scheduleAuthRefresh();
    });
  }

  disconnectedCallback() {
    // Keep it simple: listeners above are cheap, and this component is intended to be long-lived.
  }

  setLocked(locked) {
    const root = this.shadowRoot.querySelector('[data-bsky-tabs]');
    if (!root) return;
    if (locked) root.setAttribute('data-bsky-locked', '1');
    else root.removeAttribute('data-bsky-locked');
  }

  getActiveTabsFromDom() {
    const root = this.shadowRoot.querySelector('[data-bsky-tabs]');
    if (!root) return ['posts'];
    const active = Array.from(root.querySelectorAll('[data-tab][aria-pressed="true"]'))
      .map((b) => b.getAttribute('data-tab'))
      .filter(Boolean);
    return active.length ? active : ['posts'];
  }

  mountPanels(activeTabs = []) {
    const map = Object.fromEntries(getPanelTemplates().map((t) => [t.name, t.mountHtml]));

    this.shadowRoot.querySelectorAll('[data-bsky-mount]').forEach((el) => {
      const key = el.getAttribute('data-bsky-mount');
      const shouldMount = Array.isArray(activeTabs) && activeTabs.includes(key);
      const html = shouldMount ? (map[key] || '') : '';
      // Avoid needless DOM churn.
      if (el.innerHTML.trim() !== html) el.innerHTML = html;
    });
  }

  unmountPanels() {
    this.shadowRoot.querySelectorAll('[data-bsky-mount]').forEach((el) => {
      el.innerHTML = '';
    });
  }

  ensureTabsBooted() {
    if (this._tabsBooted) return;
    bootTabs(this.shadowRoot);
    this._tabsBooted = true;
  }

  _cssPx(varName, fallback) {
    try {
      const raw = getComputedStyle(this).getPropertyValue(varName);
      const n = Number.parseFloat(String(raw || ''));
      return Number.isFinite(n) ? n : fallback;
    } catch {
      return fallback;
    }
  }

  _panelExtraPx(panelEl) {
    // Mirror panel_resize's dense "extra" model (panel padding + wrap padding + borders).
    // We can't reliably read inside shadow DOM, so we model it using CSS vars.
    try {
      const cs = window.getComputedStyle(panelEl);
      const panelPad = (Number.parseFloat(cs.paddingLeft || '0') || 0) + (Number.parseFloat(cs.paddingRight || '0') || 0);
      const densePad = this._cssPx('--bsky-panel-pad-dense', 4);
      const wrapPad = Math.max(0, densePad);
      const wrapBorder = 1;
      return panelPad + (wrapPad * 2) + (wrapBorder * 2);
    } catch {
      return 0;
    }
  }

  _getPostsCardWidthPx() {
    try {
      const posts = this.shadowRoot.querySelector('.panel[data-panel="posts"] bsky-my-posts');
      if (!posts) return this._cssPx('--bsky-card-min-w', 350);
      const raw = window.getComputedStyle(posts).getPropertyValue('--bsky-card-w');
      const n = Number.parseFloat(String(raw || ''));
      return Number.isFinite(n) && n > 0 ? n : this._cssPx('--bsky-card-min-w', 350);
    } catch {
      return this._cssPx('--bsky-card-min-w', 350);
    }
  }

  setFixedPx(panelName, px) {
    const panel = this.shadowRoot.querySelector(`.panel[data-panel="${panelName}"]`);
    if (!panel) return;
    const key = String(panelName || '');
    if (!this._fixedPxPrev.has(key)) {
      const prev = panel.getAttribute('data-bsky-fixed-px');
      this._fixedPxPrev.set(key, prev === null ? null : String(prev));
    }
    if (!this._fixedPinPrev.has(key)) {
      const prev = panel.getAttribute('data-bsky-fixed-pin');
      this._fixedPinPrev.set(key, prev === null ? null : String(prev));
    }
    panel.setAttribute('data-bsky-fixed-px', String(Math.max(0, Math.round(Number(px || 0)))));
    // Pin means "do not flex-grow" so the split stays stable.
    panel.setAttribute('data-bsky-fixed-pin', '1');
  }

  clearFixedPx(panelNames = []) {
    for (const name of panelNames) {
      const key = String(name || '');
      if (!this._fixedPxPrev.has(key)) continue;
      const panel = this.shadowRoot.querySelector(`.panel[data-panel="${key}"]`);
      const prev = this._fixedPxPrev.get(key);
      this._fixedPxPrev.delete(key);
      if (!panel) continue;
      if (prev === null) panel.removeAttribute('data-bsky-fixed-px');
      else panel.setAttribute('data-bsky-fixed-px', String(prev));

      if (this._fixedPinPrev.has(key)) {
        const prevPin = this._fixedPinPrev.get(key);
        this._fixedPinPrev.delete(key);
        if (prevPin === null) panel.removeAttribute('data-bsky-fixed-pin');
        else panel.setAttribute('data-bsky-fixed-pin', String(prevPin));
      }
    }
  }

  setFixedCols(panelName, cols) {
    const panel = this.shadowRoot.querySelector(`.panel[data-panel="${panelName}"]`);
    if (!panel) return;
    const key = String(panelName || '');
    if (!this._fixedColsPrev.has(key)) {
      const prev = panel.getAttribute('data-bsky-fixed-cols');
      this._fixedColsPrev.set(key, prev === null ? null : String(prev));
    }
    panel.setAttribute('data-bsky-fixed-cols', String(Math.max(1, Number(cols || 1))));
  }

  clearFixedCols(panelNames = []) {
    for (const name of panelNames) {
      const key = String(name || '');
      if (!this._fixedColsPrev.has(key)) continue;
      const panel = this.shadowRoot.querySelector(`.panel[data-panel="${key}"]`);
      const prev = this._fixedColsPrev.get(key);
      this._fixedColsPrev.delete(key);
      if (!panel) continue;
      if (prev === null) panel.removeAttribute('data-bsky-fixed-cols');
      else panel.setAttribute('data-bsky-fixed-cols', String(prev));
    }
  }

  openContent(detail = {}) {
    const uri = String(detail?.uri || '');
    const cid = String(detail?.cid || '');
    if (!uri) return;

    this.ensureTabsBooted();

    const root = this.shadowRoot.querySelector('[data-bsky-tabs]');
    const api = root?.__bskyTabsApi;
    // Optional: allow the caller to request where the Content panel should be placed.
    // We currently only use this for Posts → replies click.
    const spawnAfter = String(detail?.spawnAfter || '');

    const contentSection = this.shadowRoot.querySelector('.panel[data-panel="content"]');
    const contentWasVisibleAtCall = !!(contentSection && !contentSection.hasAttribute('hidden'));

    if (spawnAfter) api?.placeAfter?.('content', spawnAfter);

    // Posts side-panel behavior: pin all other visible panels so Comments only
    // takes space from Posts (not from Connections/Search/etc).
    if (spawnAfter === 'posts' && !contentWasVisibleAtCall) {
      try {
        const panelsWrap = this.shadowRoot.querySelector('.panels');
        const visiblePanels = Array.from(this.shadowRoot.querySelectorAll('.panel[data-panel]:not([hidden])'));
        const pinned = [];
        for (const p of visiblePanels) {
          const n = p.getAttribute('data-panel') || '';
          if (!n) continue;
          if (n === 'posts' || n === 'content') continue;
          const w = p.getBoundingClientRect?.().width || 0;
          if (w > 0) {
            this.setFixedPx(n, w);
            pinned.push(n);
          }
        }
        // Remember so closeContent can unpin.
        this._contentPinnedPanels = pinned;
        // Small nudge so the pinning takes effect before we insert Comments.
        requestAnimationFrame(() => {
          try { panelsWrap && window.dispatchEvent(new Event('resize')); } catch {}
        });
      } catch {
        this._contentPinnedPanels = [];
      }
    }
    api?.activate?.('content');

    // After the panel mounts, pass selection + (posts-only) size Posts + Comments as a split.
    requestAnimationFrame(() => {
      const cp = this.shadowRoot.querySelector('bsky-content-panel');
      cp?.setSelection?.({ uri, cid });

      // Posts-only behavior: on desktop, shrink Posts by one *actual* column width
      // and allocate that column to the Comments panel.
      try {
        const isMobile = window.matchMedia('(max-width: 560px)').matches;
        if (isMobile) return;

        if (spawnAfter !== 'posts') return;
        // If Comments is already open, only update selection (no resizing/pinning).
        if (contentWasVisibleAtCall) return;

        const postsPanel = this.shadowRoot.querySelector('.panel[data-panel="posts"]');
        const contentPanel = this.shadowRoot.querySelector('.panel[data-panel="content"]');
        if (!postsPanel || !contentPanel) return;

        const GAP = this._cssPx('--bsky-card-gap', 8);
        const CARD = this._getPostsCardWidthPx();
        const colW = CARD + GAP;

        // Remove exactly one *current* column from Posts, so the remaining columns
        // keep the same computed CARD width and fill correctly.
        const postsW0 = postsPanel.getBoundingClientRect().width || 0;
        const minPostsW = (() => {
          try {
            const v = window.getComputedStyle(postsPanel).minWidth;
            const n = Number.parseFloat(String(v || ''));
            return Number.isFinite(n) ? n : 0;
          } catch { return 0; }
        })();
        const minContentW = (() => {
          try {
            const v = window.getComputedStyle(contentPanel).minWidth;
            const n = Number.parseFloat(String(v || ''));
            return Number.isFinite(n) ? n : 0;
          } catch { return 0; }
        })();

        const contentExtra = (() => {
          try {
            const el = contentPanel.querySelector('bsky-content-panel');
            const shell = el?.shadowRoot?.querySelector?.('bsky-panel-shell');
            const scroller = shell?.getScroller?.();
            const panelW = contentPanel.getBoundingClientRect().width || 0;
            const scrollerW = scroller?.clientWidth || scroller?.getBoundingClientRect?.().width || 0;
            const extra = panelW && scrollerW ? Math.max(0, panelW - scrollerW) : 0;
            return extra;
          } catch {
            return 0;
          }
        })();

        // Inserting a new panel increases the number of inter-panel gaps by 1.
        // Charge that extra gap to Posts so Connections doesn't get squeezed.
        const panelsGap = (() => {
          try {
            const wrap = this.shadowRoot.querySelector('.panels');
            if (!wrap) return 0;
            const cs = window.getComputedStyle(wrap);
            const raw = cs.columnGap || cs.gap || '0';
            const n = Number.parseFloat(String(raw || '0'));
            return Number.isFinite(n) ? n : 0;
          } catch {
            return 0;
          }
        })();

        // If we can't actually spare a full column (+ the new gap), don't force a shrink.
        const canShrink = postsW0 > (minPostsW + colW + panelsGap + 8);
        if (!canShrink) {
          this.setFixedPx('content', Math.max(minContentW, colW));
          requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
          return;
        }

        const nextPostsW = Math.max(minPostsW, postsW0 - colW - panelsGap);
        const nextContentW = Math.max(minContentW, (contentExtra + CARD));

        // Apply explicit bases so the split is stable (panel_resize will respect these).
        this.setFixedPx('posts', nextPostsW);
        this.setFixedPx('content', nextContentW);

        // Nudge panel_resize to reflow with fixed cols.
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));

        // Keep Posts visually anchored on the left and place Comments into the freed space.
        requestAnimationFrame(() => {
          try {
            const wrap = this.shadowRoot.querySelector('.panels');
            const postsPanel2 = this.shadowRoot.querySelector('.panel[data-panel="posts"]');
            if (!wrap || !postsPanel2) return;
            // Align Posts panel to the left edge of the scroll viewport.
            wrap.scrollLeft = postsPanel2.offsetLeft;
          } catch {
            // ignore
          }
        });
      } catch {
        // ignore
      }
    });
  }

  closeContent() {
    const root = this.shadowRoot.querySelector('[data-bsky-tabs]');
    const api = root?.__bskyTabsApi;

    const cp = this.shadowRoot.querySelector('bsky-content-panel');
    cp?.setSelection?.(null);

    this.clearFixedPx(['posts', 'content']);
    if (Array.isArray(this._contentPinnedPanels) && this._contentPinnedPanels.length) {
      this.clearFixedPx(this._contentPinnedPanels);
      this._contentPinnedPanels = [];
    }
    this.clearFixedCols(['posts', 'content']);
    api?.deactivate?.('content');
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  async initGate() {
    // Debug escape hatch: allow loading the UI without auth so we can validate
    // layout/MagicGrid sizing in a clean browser context.
    try {
      const u = new URL(window.location.href);
      const force = (u.searchParams.get('bsky_force') === '1') || (window.BSKY?.debug?.forceUI === true);
      if (force) {
        this.setLocked(false);
        this.ensureTabsBooted();
        this.mountPanels(this.getActiveTabsFromDom());
        return;
      }
    } catch {
      // ignore
    }

    try {
      const auth = await call('authStatus', {});
      if (this._lastConnected !== !!auth?.connected) {
        this._lastConnected = !!auth?.connected;
        window.dispatchEvent(new CustomEvent('bsky-auth-changed', { detail: { connected: !!auth?.connected, auth } }));
      }

      if (auth?.connected) {
        this.setLocked(false);
        this.ensureTabsBooted();
        this.mountPanels(this.getActiveTabsFromDom());
        return;
      }
    } catch {
      // treat as not connected
    }

    // Not connected: hide the app UI and avoid mounting components.
    this.unmountPanels();
    this.setLocked(true);
  }

  scheduleAuthRefresh() {
    if (this._authRefreshInFlight) return this._authRefreshInFlight;
    this._authRefreshInFlight = (async () => {
      try {
        await this.initGate();
      } finally {
        this._authRefreshInFlight = null;
      }
    })();
    return this._authRefreshInFlight;
  }

  render() {
    const templates = getPanelTemplates();
    const defaultActive = getDefaultActiveTabs();

    const tabTemplates = templates.filter((t) => t?.showInTabs !== false);

    const tabsHtml = tabTemplates.map((t, i) => {
      const pressed = defaultActive.includes(t.name) ? 'true' : 'false';
      // Make the first template always pressed if defaultActive is empty.
      const aria = (defaultActive.length ? pressed : (i === 0 ? 'true' : 'false'));
      return `<button class="tab" type="button" aria-pressed="${aria}" data-tab="${t.name}">${t.title}</button>`;
    }).join('');

    const panelsHtml = templates.map((t) => {
      const hidden = defaultActive.includes(t.name) ? '' : 'hidden';
      return `
        <section class="panel" data-panel="${t.name}" ${hidden}>
          <div data-bsky-mount="${t.name}"></div>
        </section>
      `;
    }).join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{display:block;background:#000;color:#fff}

        /* Card sizing: shared by panel resize logic + MagicGrid components */
        :host{
          /* Cards are fluid-width, with a minimum that relaxes on tiny screens.
             Upper bound remains 350px, but on small viewports it can drop (down to 280px). */
          --bsky-card-min-w: clamp(280px, 92vw, 350px);
          /* Components override this per-panel to the computed column width. */
          --bsky-card-w: 350px;
          --bsky-card-gap: 8px;
          --bsky-panels-gap: 6px;

          /* Panel spacing defaults (used by bsky-panel-shell). */
          --bsky-panel-pad: 10px;
          --bsky-panel-gap: 10px;
          --bsky-panel-control-gap: 8px;
          --bsky-panel-pad-dense: 4px;
          --bsky-panel-gap-dense: 6px;
          --bsky-panel-control-gap-dense: 6px;
        }
        .root{background:#000;color:#fff;width:100%;max-width:100%;margin:0;border:0;border-radius:0;overflow-x:hidden;
          padding-left: clamp(6px, 1vw, 12px);
          padding-right: clamp(6px, 1vw, 12px);
          padding-top: 0;
        }

        /* Tabs */
        .bsky-tabs{width:100%; background:#000}

        /* Hide the taskbar + panels until connected (JS clears data-bsky-locked). */
        .bsky-tabs[data-bsky-locked="1"] .tabsbar,
        .bsky-tabs[data-bsky-locked="1"] .panels{display:none;}

        .tabsbar{
          display:flex;
          gap:8px;
          flex-wrap:wrap;
          align-items:center;
          padding:8px;
          background:#0b0b0b;
          border:1px solid #222;
          border-radius:12px;
          position:relative;
          z-index:10;
        }
        .tablist{
          display:flex;
          gap:8px;
          flex-wrap:wrap;
          align-items:center;
          min-width:0;
          flex:1 1 auto;
        }
        .tab{
          appearance:none;
          background:#111;
          color:#fff;
          border:1px solid #333;
          border-radius:999px;
          padding:8px 12px;
          cursor:grab;
          font-weight:600;
        }
        .tab:active{cursor:grabbing}
        .tab[aria-pressed="true"]{background:#1d2a41;border-color:#2f4b7a;}
        .tab:focus{outline:2px solid #2f4b7a; outline-offset:2px}
        .tabhint{color:#aaa;font-size:.9rem;margin-left:auto;white-space:nowrap}

        .panels{
          margin-top:12px;
          display:flex;
          flex-wrap:nowrap;
          gap: var(--bsky-panels-gap);
          align-items:stretch;
          overflow-x:auto;
          overflow-y:hidden;
          scroll-snap-type: x mandatory;
          scroll-behavior: smooth;
          overscroll-behavior-x: contain;
          -webkit-overflow-scrolling: touch;
          width:100%;
          max-width:100%;
        }
        .panel{
          min-width:0;
          flex: 1 1 calc(var(--bsky-card-min-w) + 40px);
          position:relative;
          background:#000;
          padding: 0px;
          box-sizing: border-box;
          border: 1px solid #111;
          scroll-snap-align: start;
          scroll-snap-stop: always;
        }

        .panel[data-panel="posts"]{ padding:0; }

        /* resizer handle (injected by tabs/panels subsystem) */
        .panel .resize-handle{
          position:absolute;
          top:10px;
          right:2px;
          bottom:10px;
          width:10px;
          cursor:col-resize;
          border-radius:8px;
          background:linear-gradient(to right, transparent, rgba(255,255,255,0.12));
          opacity:0.25;
        }
        .panel:hover .resize-handle{opacity:0.6}

        @media (max-width: 520px){
          .tablist{display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:8px;align-items:stretch}
          .tab{width:100%;cursor:pointer}
          .tabhint{grid-column:1/-1;margin-left:0;white-space:normal;display:block}

          /* Mobile: one panel per screen, swipe between them. */
          .panels{gap:0; scroll-snap-type:x mandatory;}
          .panel{flex:0 0 100%; min-width:100%; border-left:0; border-right:0;}
          .panel .resize-handle{display:none;}
        }

        /* Avoid wrapping panels into multiple rows; prefer swipe/scroll instead. */
        @media (max-width: 900px){
          .panels{flex-wrap:nowrap; overflow-x:auto;}
        }

        /* Ensure media inside components scale */
        .root img, .root video{ max-width:100%; height:auto; display:block }
        bsky-my-posts, bsky-connections, bsky-people-search { display:block; width:100% }
      </style>

      <div class="root">
        <div class="bsky-tabs" data-bsky-tabs data-bsky-locked="1">
          <bsky-profile>
            <div slot="taskbar" class="tabsbar" role="toolbar" aria-label="Bluesky Feed Views">
              <div class="tablist">
                ${tabsHtml}
                <button class="tab" id="bsky-reset-layout" type="button" aria-pressed="false" style="cursor:pointer">Reset layout</button>
                <span class="tabhint">Tip: click multiple tabs to compare in columns.</span>
              </div>
            </div>
          </bsky-profile>

          <div class="panels">
            ${panelsHtml}
          </div>
        </div>

        <bsky-notification-bar></bsky-notification-bar>
      </div>
    `;
  }
}

customElements.define('bsky-app', BskyApp);
