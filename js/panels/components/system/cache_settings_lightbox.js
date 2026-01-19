import { getAuthStatusCached } from '../../../auth_state.js';

class BskyCacheSettingsLightbox extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.opened = false;
    this.tab = 'calendar'; // calendar | status | advanced

    this._lsKey = 'bsky.cacheSettings.tab';

    // Keep single instances so switching tabs doesn't re-fetch/re-initialize.
    this._db = document.createElement('bsky-db-manager');
    this._status = document.createElement('bsky-cache-status');

    this._openHandler = (e) => {
      // If caller provides a tab, honor it. Otherwise restore last-used tab.
      const hasTab = (e && e.detail && typeof e.detail.tab !== 'undefined' && e.detail.tab !== null && String(e.detail.tab).trim() !== '');
      const tab = hasTab ? String(e.detail.tab) : null;
      this.open(tab);
    };
  }

  _loadSavedTab() {
    try {
      const t = localStorage.getItem(this._lsKey);
      return (t === 'status' || t === 'advanced' || t === 'calendar') ? t : null;
    } catch {
      return null;
    }
  }

  _saveTab(tab) {
    try {
      if (tab === 'status' || tab === 'advanced' || tab === 'calendar') {
        localStorage.setItem(this._lsKey, tab);
      }
    } catch {
      // ignore
    }
  }

  connectedCallback() {
    window.addEventListener('bsky-open-cache-settings', this._openHandler);
    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener('bsky-open-cache-settings', this._openHandler);
  }

  async open(tab = null) {
    this.opened = true;
    const restored = this._loadSavedTab();
    const desired = (tab === 'status' || tab === 'advanced' || tab === 'calendar') ? tab : (restored || 'calendar');
    this.tab = desired;
    this._saveTab(this.tab);
    this.render();

    // If user isn't connected, still show the UI (it will explain), but avoid throwing.
    try { await getAuthStatusCached(); } catch {}

    // Calendar tab is rendered inline; no nested modal needed.
  }

  close() {
    this.opened = false;
    this.render();
  }

  onClick(e) {
    const act = e?.target?.getAttribute?.('data-action') || e?.target?.closest?.('[data-action]')?.getAttribute?.('data-action');
    if (!act) return;

    if (act === 'close') { this.close(); return; }
    if (act === 'tab') {
      const t = e?.target?.getAttribute?.('data-tab') || e?.target?.closest?.('[data-tab]')?.getAttribute?.('data-tab');
      this.tab = (t === 'status' || t === 'advanced' || t === 'calendar') ? t : 'calendar';
      this._saveTab(this.tab);
      this.render();
      return;
    }
  }

  render() {
    const opened = this.opened;
    const tab = this.tab;

    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{position:fixed;inset:0;z-index:100001;display:${opened ? 'flex' : 'none'};align-items:center;justify-content:center;font-family: var(--bsky-font-family, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif);}
        .backdrop{position:absolute;inset:0;background:rgba(0,0,0,.72)}
        .card{position:relative;width:min(980px, calc(100vw - 20px));max-height:min(86vh, 980px);overflow:auto;background:var(--bsky-surface, #0b0b0b);border:1px solid var(--bsky-border, #2b2b2b);border-radius: var(--bsky-radius, 0px);box-shadow:0 18px 60px rgba(0,0,0,.65);color:var(--bsky-fg, #fff)}
        .hd{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.10)}
        .t{font-weight:900}
        .tabs{display:flex;gap:8px;flex-wrap:wrap}
        .tab{appearance:none;background:var(--bsky-btn-bg, #111);color:var(--bsky-fg, #fff);border:1px solid var(--bsky-border, #333);border-radius: var(--bsky-radius, 0px);padding:8px 12px;cursor:pointer;font-weight:800}
        .tab[aria-pressed="true"]{background:#1d2a41;border-color:#2f4b7a}
        .close{appearance:none;background:var(--bsky-btn-bg, #111);color:var(--bsky-fg, #fff);border:1px solid var(--bsky-border, #333);border-radius: var(--bsky-radius, 0px);padding:8px 12px;cursor:pointer;font-weight:900}
        .close:hover,.tab:hover{background:#1b1b1b}
        .bd{padding:12px 14px}
        .note{color:var(--bsky-muted-fg, #aaa);margin:0 0 10px 0}
      </style>
      <div class="backdrop" data-action="close"></div>
      <div class="card" role="dialog" aria-modal="true" aria-label="Cache settings">
        <div class="hd">
          <div class="t">Cache settings</div>
          <div class="tabs" role="tablist" aria-label="Cache settings tabs">
            <button class="tab" type="button" data-action="tab" data-tab="calendar" aria-pressed="${tab === 'calendar' ? 'true' : 'false'}">Calendar</button>
            <button class="tab" type="button" data-action="tab" data-tab="status" aria-pressed="${tab === 'status' ? 'true' : 'false'}">Status</button>
            <button class="tab" type="button" data-action="tab" data-tab="advanced" aria-pressed="${tab === 'advanced' ? 'true' : 'false'}">Advanced</button>
          </div>
          <button class="close" type="button" data-action="close">Close</button>
        </div>
        <div class="bd">
          ${tab === 'calendar' ? '<p class="note">Calendar coverage + day drill-down + selection/backfill tools.</p><div id="dbSlot"></div>' : ''}
          ${tab === 'status' ? '<p class="note">Compact cache status.</p><div id="statusSlot"></div>' : ''}
          ${tab === 'advanced' ? '<p class="note">Advanced operations and bulk tools.</p><div id="dbSlot"></div>' : ''}
        </div>
      </div>
    `;

    this.shadowRoot.querySelector('.card')?.addEventListener('click', (e) => this.onClick(e));
    this.shadowRoot.querySelector('.backdrop')?.addEventListener('click', (e) => this.onClick(e));

    // Re-attach persistent child components.
    const dbSlot = this.shadowRoot.querySelector('#dbSlot');
    if (dbSlot && (tab === 'calendar' || tab === 'advanced')) {
      if (tab === 'calendar') this._db.setAttribute('data-view', 'calendar');
      else this._db.removeAttribute('data-view');
      dbSlot.appendChild(this._db);
    }

    const statusSlot = this.shadowRoot.querySelector('#statusSlot');
    if (statusSlot && tab === 'status') {
      statusSlot.appendChild(this._status);
    }
  }
}

customElements.define('bsky-cache-settings-lightbox', BskyCacheSettingsLightbox);

// Ensure a singleton exists for callers that just dispatch events.
queueMicrotask(() => {
  try {
    if (!document.querySelector('bsky-cache-settings-lightbox')) {
      document.body.appendChild(document.createElement('bsky-cache-settings-lightbox'));
    }
  } catch {
    // ignore
  }
});
