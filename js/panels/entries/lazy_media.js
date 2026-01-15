// Entry-level lazy media + embed mounting.
//
// Why:
// - Panels can render thousands of entries.
// - Loading all media (images/iframes/oEmbed HTML) eagerly can lag/crash browsers.
//
// Design:
// - Shared IntersectionObserver per scroller (so we don't create 10k observers).
// - Small web components that panels can drop into templates:
//   - <bsky-lazy-img>
//   - <bsky-lazy-mount>

export const MEDIA_PLACEHOLDER_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

const escAttr = (s) => String(s ?? '').replace(/[<>&"]/g, (m) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[m]));

function parseAspect(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?$/.test(v)) return v.replace(/\s+/g, '');
  return v;
}

function resolvePanelScroller(scope) {
  try {
    let node = scope;
    for (let i = 0; i < 12; i++) {
      if (!node) break;
      const root = (typeof node.getRootNode === 'function') ? node.getRootNode() : null;
      if (root && typeof root.querySelector === 'function') {
        const shell = root.querySelector('bsky-panel-shell');
        const scroller = shell?.getScroller?.();
        if (scroller) return scroller;
      }
      node = root?.host || node.parentNode;
    }
  } catch {
    // ignore
  }
  return null;
}

class LazyObserverManager {
  constructor() {
    /** @type {Map<any, Map<string, { io: IntersectionObserver, els: Set<any> }>>} */
    this._byScroller = new Map();
  }

  _ensure(scroller, rootMargin) {
    const key = scroller || 'viewport';
    const margin = String(rootMargin || '1000px 0px');

    let byMargin = this._byScroller.get(key);
    if (!byMargin) {
      byMargin = new Map();
      this._byScroller.set(key, byMargin);
    }

    let entry = byMargin.get(margin);
    if (entry) return entry;

    const io = new IntersectionObserver((entries) => {
      for (const ent of entries) {
        const el = ent.target;
        try { el?._onIntersect?.(ent); } catch {}
      }
    }, {
      root: scroller || null,
      rootMargin: margin,
      threshold: 0.01,
    });

    entry = { io, els: new Set() };
    byMargin.set(margin, entry);
    return entry;
  }

  observe(el, { scroller, rootMargin } = {}) {
    const entry = this._ensure(scroller, rootMargin);
    entry.els.add(el);
    try { entry.io.observe(el); } catch {}
  }

  unobserve(el, { scroller, rootMargin } = {}) {
    const key = scroller || 'viewport';
    const margin = String(rootMargin || '1000px 0px');
    const byMargin = this._byScroller.get(key);
    if (!byMargin) return;
    const entry = byMargin.get(margin);
    if (!entry) return;

    entry.els.delete(el);
    try { entry.io.unobserve(el); } catch {}

    if (entry.els.size === 0) {
      try { entry.io.disconnect(); } catch {}
      byMargin.delete(margin);
    }

    if (byMargin.size === 0) {
      this._byScroller.delete(key);
    }
  }
}

const _lazyObserver = new LazyObserverManager();

// Lower-level helper for legacy code paths.
export function initLazyMedia({ scroller, root, selector, rootMargin, unloadDelayMs } = {}) {
  try {
    if (!scroller || !root) return () => {};
    if (typeof IntersectionObserver === 'undefined') return () => {};

    const sel = String(selector || 'img[data-media-src]');
    const margin = String(rootMargin || '900px 0px');
    const delay = Math.max(0, Number(unloadDelayMs ?? 2000));

    /** @type {Map<Element, any>} */
    const timers = new Map();

    const clearTimer = (el) => {
      const t = timers.get(el);
      if (t) {
        timers.delete(el);
        try { clearTimeout(t); } catch {}
      }
    };

    const loadEl = (el) => {
      clearTimer(el);
      if (!(el instanceof Element)) return;
      const src = el.getAttribute('data-media-src') || '';
      if (!src) return;

      if (el.tagName === 'IMG') {
        const img = /** @type {HTMLImageElement} */ (el);
        if (img.dataset.mediaLoaded === '1') return;
        img.decoding = 'async';
        img.loading = 'eager';
        img.src = src;
        const srcset = img.getAttribute('data-media-srcset');
        if (srcset) img.setAttribute('srcset', srcset);
        img.dataset.mediaLoaded = '1';
      }
    };

    const unloadEl = (el) => {
      if (!(el instanceof Element)) return;
      if (el.tagName === 'IMG') {
        const img = /** @type {HTMLImageElement} */ (el);
        if (img.dataset.mediaLoaded !== '1') return;
        if (img.dataset.mediaKeep === '1') return;
        img.removeAttribute('srcset');
        img.src = MEDIA_PLACEHOLDER_SRC;
        img.dataset.mediaLoaded = '0';
      }
    };

    const io = new IntersectionObserver((entries) => {
      for (const ent of entries) {
        const el = ent.target;
        if (ent.isIntersecting) {
          loadEl(el);
        } else {
          clearTimer(el);
          if (delay > 0) timers.set(el, setTimeout(() => unloadEl(el), delay));
          else unloadEl(el);
        }
      }
    }, { root: scroller, rootMargin: margin, threshold: 0.01 });

    const items = Array.from(root.querySelectorAll(sel));
    for (const el of items) io.observe(el);

    return () => {
      try { io.disconnect(); } catch {}
      for (const t of timers.values()) {
        try { clearTimeout(t); } catch {}
      }
      timers.clear();
    };
  } catch {
    return () => {};
  }
}

export class BskyLazyImg extends HTMLElement {
  static get observedAttributes() {
    return ['src', 'srcset', 'alt', 'aspect', 'root-margin', 'unload-delay', 'keep'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    /** @type {HTMLImageElement|null} */
    this._img = null;
    this._scroller = null;
    this._unloadTimer = null;
    this._loaded = false;
    this._rootMargin = '1000px 0px';

    this._render();
  }

  connectedCallback() {
    this._scroller = resolvePanelScroller(this);
    this._rootMargin = String(this.getAttribute('root-margin') || '1000px 0px');
    this._setPlaceholder();
    _lazyObserver.observe(this, { scroller: this._scroller, rootMargin: this._rootMargin });
  }

  disconnectedCallback() {
    try { clearTimeout(this._unloadTimer); } catch {}
    this._unloadTimer = null;
    _lazyObserver.unobserve(this, { scroller: this._scroller, rootMargin: this._rootMargin });
    this._scroller = null;
  }

  attributeChangedCallback() {
    if (this._loaded) this._load();
    this._applyAspect();
  }

  _render() {
    const alt = escAttr(this.getAttribute('alt') || '');
    const aspect = parseAspect(this.getAttribute('aspect'));

    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block;max-width:100%}
        img{display:block;width:100%;height:auto;max-width:100%;object-fit:cover;background:#111}
      </style>
      <img part="img" alt="${alt}">
    `;

    this._img = this.shadowRoot.querySelector('img');
    if (this._img) {
      this._img.decoding = 'async';
      this._img.loading = 'eager';
    }

    if (aspect) {
      this.style.aspectRatio = aspect;
      if (this._img) this._img.style.aspectRatio = aspect;
    }
  }

  _applyAspect() {
    try {
      const aspect = parseAspect(this.getAttribute('aspect'));
      if (aspect) {
        this.style.aspectRatio = aspect;
        if (this._img) this._img.style.aspectRatio = aspect;
      } else {
        this.style.removeProperty('aspect-ratio');
        if (this._img) this._img.style.removeProperty('aspect-ratio');
      }
    } catch {}
  }

  _setPlaceholder() {
    if (!this._img) return;
    this._loaded = false;
    try {
      this._img.removeAttribute('srcset');
      this._img.src = MEDIA_PLACEHOLDER_SRC;
    } catch {}
  }

  _load() {
    try { clearTimeout(this._unloadTimer); } catch {}
    this._unloadTimer = null;

    const src = String(this.getAttribute('src') || '');
    if (!src) {
      this._setPlaceholder();
      return;
    }

    if (!this._img) return;
    this._loaded = true;
    try {
      this._img.src = src;
      const srcset = this.getAttribute('srcset');
      if (srcset) this._img.setAttribute('srcset', String(srcset));
      else this._img.removeAttribute('srcset');
    } catch {}
  }

  _scheduleUnload() {
    if (this.hasAttribute('keep')) return;

    const delay = Math.max(0, Number(this.getAttribute('unload-delay') ?? 2500));
    try { clearTimeout(this._unloadTimer); } catch {}
    this._unloadTimer = null;

    if (!delay) {
      this._setPlaceholder();
      return;
    }

    this._unloadTimer = setTimeout(() => this._setPlaceholder(), delay);
  }

  _onIntersect(entry) {
    if (entry.isIntersecting) this._load();
    else this._scheduleUnload();
  }
}

// Generic: mount/unmount arbitrary HTML from a <template> child.
//
// Use cases:
// - iframes (YouTube/Vimeo/whatever)
// - oEmbed HTML snippets
// - custom "HTML blocks" inside entries (trusted HTML only)
export class BskyLazyMount extends HTMLElement {
  static get observedAttributes() {
    return ['aspect', 'root-margin', 'unload-delay', 'keep'];
  }

  constructor() {
    super();
    /** @type {HTMLTemplateElement|null} */
    this._tpl = null;
    /** @type {Array<Node>} */
    this._mounted = [];
    this._scroller = null;
    this._rootMargin = '1000px 0px';
    this._unloadTimer = null;
    this._isMounted = false;
  }

  connectedCallback() {
    this._tpl = this.querySelector('template');
    this._scroller = resolvePanelScroller(this);
    this._rootMargin = String(this.getAttribute('root-margin') || '1000px 0px');
    this._applyAspect();

    // Start unloaded.
    this._unmountNow();
    _lazyObserver.observe(this, { scroller: this._scroller, rootMargin: this._rootMargin });
  }

  disconnectedCallback() {
    try { clearTimeout(this._unloadTimer); } catch {}
    this._unloadTimer = null;
    _lazyObserver.unobserve(this, { scroller: this._scroller, rootMargin: this._rootMargin });
    this._scroller = null;
    this._unmountNow();
  }

  attributeChangedCallback() {
    this._applyAspect();
  }

  _applyAspect() {
    try {
      const aspect = parseAspect(this.getAttribute('aspect'));
      if (aspect) this.style.aspectRatio = aspect;
      else this.style.removeProperty('aspect-ratio');
    } catch {}
  }

  _mountNow() {
    if (this._isMounted) return;
    if (!this._tpl) this._tpl = this.querySelector('template');
    if (!this._tpl) return;

    // Clone template content into light DOM so parent styles apply.
    const frag = this._tpl.content.cloneNode(true);

    /** @type {Node[]} */
    const nodes = [];
    for (const n of Array.from(frag.childNodes)) nodes.push(n);

    this.appendChild(frag);
    this._mounted = nodes;
    this._isMounted = true;
  }

  _unmountNow() {
    // Remove previously mounted nodes only (leave the template in place).
    try {
      for (const n of this._mounted) {
        try { n.remove?.(); } catch {}
      }
    } catch {}
    this._mounted = [];
    this._isMounted = false;
  }

  _scheduleUnmount() {
    if (this.hasAttribute('keep')) return;

    const delay = Math.max(0, Number(this.getAttribute('unload-delay') ?? 2500));
    try { clearTimeout(this._unloadTimer); } catch {}
    this._unloadTimer = null;

    if (!delay) {
      this._unmountNow();
      return;
    }

    this._unloadTimer = setTimeout(() => this._unmountNow(), delay);
  }

  _onIntersect(entry) {
    try { clearTimeout(this._unloadTimer); } catch {}
    this._unloadTimer = null;

    if (entry.isIntersecting) this._mountNow();
    else this._scheduleUnmount();
  }
}

if (!customElements.get('bsky-lazy-img')) {
  customElements.define('bsky-lazy-img', BskyLazyImg);
}

if (!customElements.get('bsky-lazy-mount')) {
  customElements.define('bsky-lazy-mount', BskyLazyMount);
}
