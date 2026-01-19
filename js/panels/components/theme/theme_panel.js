import {
  THEME_PRESETS,
  THEME_LAYOUT_DEFAULTS,
  THEME_PREF_DEFAULTS,
  loadThemeFromStorage,
  loadThemeFromInjected,
  applyTheme,
  setThemeAndPersist,
  resetThemeToDefaults,
} from '../../../theme/app_theme.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));
const escAttr = (s) => esc(String(s || '')).replace(/\n/g, ' ');

function clampPreset(p) {
  return (p === 'light' || p === 'dark') ? p : 'dark';
}

function isHexColor(v) {
  return /^#[0-9a-fA-F]{6}$/.test(String(v || '').trim());
}

function hexFromCssColor(v) {
  const s = String(v || '').trim();
  if (isHexColor(s)) return s;
  return '';
}

function normalizePrefs(raw) {
  const base = (raw && typeof raw === 'object') ? raw : {};
  const prefs = { ...THEME_PREF_DEFAULTS };

  {
    const motion = String(base.motion || '').trim();
    if (motion === 'system' || motion === 'reduce' || motion === 'full') prefs.motion = motion;
  }
  {
    const density = String(base.density || '').trim();
    if (density === 'compact' || density === 'comfortable') prefs.density = density;
  }
  {
    const fontSize = String(base.fontSize || '').trim();
    if (fontSize === 'sm' || fontSize === 'md' || fontSize === 'lg') prefs.fontSize = fontSize;
  }

  return prefs;
}

function themeTokenList() {
  const colorKeys = Object.keys(THEME_PRESETS.dark);
  const layoutKeys = Object.keys(THEME_LAYOUT_DEFAULTS);
  return {
    colors: colorKeys,
    layout: layoutKeys,
  };
}

export class BskyThemePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this.preset = 'dark';
    this.vars = {};
    this.prefs = { ...THEME_PREF_DEFAULTS };

    this._saveTimer = null;
    this._status = '';
  }

  connectedCallback() {
    this.load();
    this.shadowRoot.addEventListener('input', (e) => this.onInput(e));
    this.shadowRoot.addEventListener('change', (e) => this.onChange(e));
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
  }

  disconnectedCallback() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
  }

  load() {
    const storageMode = String(this.getAttribute('data-storage') || '').trim();
    const isServer = storageMode === 'server';

    if (isServer) {
      const injected = (window.BSKY?.themeAdmin?.initialTheme && typeof window.BSKY.themeAdmin.initialTheme === 'object')
        ? window.BSKY.themeAdmin.initialTheme
        : (loadThemeFromInjected() || null);

      const preset = clampPreset(injected?.preset);
      this.preset = preset;
      this.vars = { ...(injected?.vars || {}) };
      this.prefs = normalizePrefs(injected?.prefs);
      this._status = '';
      // Apply immediately for preview.
      applyTheme({ preset: this.preset, vars: this.vars, prefs: this.prefs });
      this.render();
      return;
    }

    const saved = loadThemeFromStorage();
    const preset = clampPreset(saved?.preset);
    this.preset = preset;
    this.vars = { ...(saved?.vars || {}) };
    this.prefs = normalizePrefs(saved?.prefs);
    this._status = '';
    this.render();
  }

  scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;

      const storageMode = String(this.getAttribute('data-storage') || '').trim();
      const isServer = storageMode === 'server';

      if (!isServer) {
        setThemeAndPersist({ preset: this.preset, vars: this.vars, prefs: this.prefs });
        return;
      }

      // Server mode: apply live for preview, then persist via dashboard endpoint.
      applyTheme({ preset: this.preset, vars: this.vars, prefs: this.prefs });
      this.saveToServer().catch(() => {
        // ignore
      });
    }, 120);
  }

  async saveToServer() {
    const cfg = window.BSKY?.themeAdmin;
    const saveUrl = String(cfg?.saveUrl || '').trim();
    const token = String(cfg?.token || '').trim();
    if (!saveUrl || !token) return;

    this._status = 'Saving…';
    this.render();

    const fd = new FormData();
    fd.set('ccm_token', token);
    fd.set('theme_json', JSON.stringify({ preset: this.preset, vars: this.vars, prefs: this.prefs }));

    const res = await fetch(saveUrl, {
      method: 'POST',
      body: fd,
      credentials: 'same-origin',
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      this._status = `Save failed (${res.status})`;
      console.warn('[BSKY theme] save failed', res.status, txt);
      this.render();
      return;
    }

    // Keep injected baseline in sync for other scripts.
    try {
      const json = await res.json();
      if (json?.ok && json?.theme) {
        window.BSKY = window.BSKY || {};
        window.BSKY.siteTheme = json.theme;
        if (window.BSKY.themeAdmin) window.BSKY.themeAdmin.initialTheme = json.theme;
      }
    } catch {
      // ignore
    }

    this._status = 'Saved';
    this.render();
    setTimeout(() => {
      if (this._status === 'Saved') {
        this._status = '';
        this.render();
      }
    }, 1200);
  }

  setVar(key, value) {
    const k = String(key || '').trim();
    if (!k.startsWith('--')) return;
    const v = String(value ?? '').trim();

    const next = { ...(this.vars || {}) };
    if (!v) {
      delete next[k];
    } else {
      next[k] = v;
    }
    this.vars = next;
    this.scheduleSave();
  }

  setPref(key, value) {
    const k = String(key || '').trim();
    const v = String(value ?? '').trim();
    const next = normalizePrefs({ ...(this.prefs || {}), [k]: v });
    this.prefs = next;
    this.scheduleSave();
  }

  onInput(e) {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;

    if (el.matches('[data-var][data-kind="text"]')) {
      const key = el.getAttribute('data-var');
      this.setVar(key, el.value);
      return;
    }
  }

  onChange(e) {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;

    if (el.matches('select[name="preset"]')) {
      const p = clampPreset(el.value);
      this.preset = p;
      // When switching preset, keep explicit overrides, but baseline changes.
      this.scheduleSave();
      this.render();
      return;
    }

    if (el.matches('select[name="motion"]')) {
      this.setPref('motion', el.value);
      this.render();
      return;
    }

    if (el.matches('select[name="density"]')) {
      this.setPref('density', el.value);
      this.render();
      return;
    }

    if (el.matches('select[name="fontSize"]')) {
      this.setPref('fontSize', el.value);
      this.render();
      return;
    }

    if (el.matches('[data-var][data-kind="color"]')) {
      const key = el.getAttribute('data-var');
      const v = String(el.value || '').trim();
      if (isHexColor(v)) this.setVar(key, v);
      this.render();
      return;
    }
  }

  onClick(e) {
    const btn = e.target?.closest?.('button[data-action]');
    if (!btn) return;

    const action = btn.getAttribute('data-action');
    if (action === 'apply-preset') {
      const preset = this.preset;
      // Apply preset baseline (no overrides).
      this.vars = {};
      if (String(this.getAttribute('data-storage') || '').trim() === 'server') {
        applyTheme({ preset, vars: {}, prefs: this.prefs });
        this.scheduleSave();
      } else {
        setThemeAndPersist({ preset, vars: {}, prefs: this.prefs });
      }
      this.render();
      return;
    }

    if (action === 'reset-all') {
      const preset = this.preset;
      if (!confirm(`Reset theme overrides and re-apply ${preset} defaults?`)) return;
      if (String(this.getAttribute('data-storage') || '').trim() === 'server') {
        this.vars = {};
        applyTheme({ preset, vars: {}, prefs: this.prefs });
        this.scheduleSave();
      } else {
        resetThemeToDefaults(preset);
        this.vars = {};
      }
      this.vars = {};
      this.render();
      return;
    }

    if (action === 'clear-var') {
      const key = btn.getAttribute('data-var');
      this.setVar(key, '');
      this.render();
      return;
    }
  }

  effectiveValueFor(key) {
    const k = String(key || '');
    const overrides = (this.vars && typeof this.vars === 'object') ? this.vars : {};
    if (Object.prototype.hasOwnProperty.call(overrides, k)) return String(overrides[k] ?? '');

    const presetVars = THEME_PRESETS[this.preset] || THEME_PRESETS.dark;
    if (Object.prototype.hasOwnProperty.call(presetVars, k)) return String(presetVars[k] ?? '');

    if (Object.prototype.hasOwnProperty.call(THEME_LAYOUT_DEFAULTS, k)) return String(THEME_LAYOUT_DEFAULTS[k] ?? '');

    return '';
  }

  render() {
    const { colors, layout } = themeTokenList();

    const storageMode = String(this.getAttribute('data-storage') || '').trim();
    const isServer = storageMode === 'server';

    const rows = (keys, sectionTitle) => {
      const html = keys.map((k) => {
        const val = this.effectiveValueFor(k);
        const hex = hexFromCssColor(val) || '#000000';
        const isColor = colors.includes(k);

        return `
          <div class="row">
            <div class="k"><span class="mono">${esc(k)}</span></div>
            <div class="v">
              ${isColor ? `<input class="color" type="color" data-kind="color" data-var="${escAttr(k)}" value="${escAttr(hex)}" />` : ''}
              <input class="text" type="text" data-kind="text" data-var="${escAttr(k)}" value="${escAttr(val)}" placeholder="(unset)" />
              <button class="btn small" type="button" data-action="clear-var" data-var="${escAttr(k)}" title="Clear override">Clear</button>
            </div>
          </div>
        `;
      }).join('');

      return `
        <div class="section">
          <div class="sectionTitle">${esc(sectionTitle)}</div>
          ${html}
        </div>
      `;
    };

    const presetOptions = ['dark', 'light'].map((p) =>
      `<option value="${p}" ${this.preset === p ? 'selected' : ''}>${p}</option>`
    ).join('');

    const motionOptions = [
      { v: 'system', t: 'System' },
      { v: 'reduce', t: 'Reduced' },
      { v: 'full', t: 'Full' },
    ].map((o) => `<option value="${o.v}" ${this.prefs.motion === o.v ? 'selected' : ''}>${o.t}</option>`).join('');

    const densityOptions = [
      { v: 'compact', t: 'Compact' },
      { v: 'comfortable', t: 'Comfortable' },
    ].map((o) => `<option value="${o.v}" ${this.prefs.density === o.v ? 'selected' : ''}>${o.t}</option>`).join('');

    const fontSizeOptions = [
      { v: 'sm', t: 'Small' },
      { v: 'md', t: 'Default' },
      { v: 'lg', t: 'Large' },
    ].map((o) => `<option value="${o.v}" ${this.prefs.fontSize === o.v ? 'selected' : ''}>${o.t}</option>`).join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block;color:var(--bsky-fg,#fff);font-family:var(--bsky-font-family,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif)}
        .wrap{padding:10px}
        .muted{color:var(--bsky-muted-fg,rgba(255,255,255,.75));font-size:12px}
        .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace}

        .toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px 0}
        select{background:var(--bsky-input-bg,#000);border:1px solid var(--bsky-border,#333);color:var(--bsky-fg,#fff);padding:8px}
        .btn{background:var(--bsky-btn-bg,#111);border:1px solid var(--bsky-border,#333);color:var(--bsky-fg,#fff);padding:8px 10px;cursor:pointer}
        .btn:hover{background:var(--bsky-surface-2,#060606)}
        .btn.small{padding:6px 8px;font-size:12px}

        .card{border:1px solid var(--bsky-border-soft,#222);background:var(--bsky-surface,#0b0b0b);padding:10px}

        .prefs{display:grid;grid-template-columns: repeat(3, minmax(160px, 1fr));gap:10px}
        .pref{display:flex;flex-direction:column;gap:6px}
        .pref label{font-weight:700}

        .section{margin-top:12px}
        .sectionTitle{font-weight:900;margin-bottom:8px}

        .row{display:grid;grid-template-columns: minmax(180px, 260px) 1fr;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--bsky-border-subtle,#111)}
        .row:first-child{border-top:0}
        .k{min-width:0;overflow:hidden;text-overflow:ellipsis}
        .v{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
        .text{min-width:260px;max-width:100%;flex:1 1 260px;background:var(--bsky-input-bg,#000);border:1px solid var(--bsky-border,#333);color:var(--bsky-fg,#fff);padding:8px}
        .color{width:44px;height:36px;padding:0;border:1px solid var(--bsky-border,#333);background:transparent}

        @media (max-width: 520px){
          .row{grid-template-columns: 1fr;}
          .text{min-width:0;flex:1 1 auto;width:100%}
          .prefs{grid-template-columns: 1fr;}
        }
      </style>

      <bsky-panel-shell dense title="Theme">
        <div class="wrap">
          <div class="muted">${isServer ? 'Adjust the site-wide default theme (saved server-side).' : 'Adjust the SPA theme by overriding CSS variables (saved in localStorage).'}</div>

          <div class="toolbar">
            <label class="muted">Preset</label>
            <select name="preset">${presetOptions}</select>
            <button class="btn" type="button" data-action="apply-preset">Apply preset</button>
            <button class="btn" type="button" data-action="reset-all">Reset overrides</button>
            ${this._status ? `<span class="muted">${esc(this._status)}</span>` : ''}
          </div>

          <div class="card">
            <div class="section">
              <div class="sectionTitle">Preferences</div>
              <div class="prefs">
                <div class="pref">
                  <label class="muted" for="bsky-theme-motion">Motion</label>
                  <select id="bsky-theme-motion" name="motion">${motionOptions}</select>
                </div>
                <div class="pref">
                  <label class="muted" for="bsky-theme-density">Density</label>
                  <select id="bsky-theme-density" name="density">${densityOptions}</select>
                </div>
                <div class="pref">
                  <label class="muted" for="bsky-theme-fontSize">Font size</label>
                  <select id="bsky-theme-fontSize" name="fontSize">${fontSizeOptions}</select>
                </div>
              </div>
              <div class="muted" style="margin-top:8px">
                Motion affects smooth scrolling and drag animations; density affects panel spacing; font size applies to the SPA root.
              </div>
            </div>

            ${rows(colors, 'Colors')}
            ${rows(layout, 'Layout')}
          </div>
        </div>
      </bsky-panel-shell>
    `;
  }
}

customElements.define('bsky-theme-panel', BskyThemePanel);
