// Standard panel utilities + registry for panel templates.
// This is intentionally small and framework-free so panels remain simple web components.

const _registry = [];

export * from './lazy_media.js';

/**
 * @typedef {Object} PanelTemplate
 * @property {string} name              Unique id. Also used for [data-tab] and [data-panel].
 * @property {string} title             Human readable title.
 * @property {string} mountHtml         HTML inserted into the mount point when active.
 * @property {boolean=} defaultActive   If true, included in the default active tabs.
 * @property {boolean=} showInTabs      If false, panel exists but has no tab button (aux/side panel).
 */

/** @returns {PanelTemplate[]} */
export function getPanelTemplates() {
  return _registry.slice();
}

/** @param {PanelTemplate} tpl */
export function registerPanelTemplate(tpl) {
  if (!tpl || typeof tpl !== 'object') return;
  if (!tpl.name || !tpl.title || !tpl.mountHtml) return;
  if (_registry.some((x) => x.name === tpl.name)) return;
  _registry.push({
    name: String(tpl.name),
    title: String(tpl.title),
    mountHtml: String(tpl.mountHtml),
    defaultActive: !!tpl.defaultActive,
    showInTabs: tpl.showInTabs !== false,
  });
}

export function getDefaultActiveTabs() {
  const tabTemplates = _registry.filter((t) => t.showInTabs !== false);
  const defs = tabTemplates.filter((t) => t.defaultActive).map((t) => t.name);
  return defs.length ? defs : (tabTemplates[0] ? [tabTemplates[0].name] : ['posts']);
}

export function debounce(fn, ms = 200) {
  let t = null;
  return function debounced(...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn.apply(this, args);
    }, ms);
  };
}

export function bindNearBottom(scroller, onNearBottom, opts = {}) {
  if (!scroller) return () => {};
  const threshold = Math.max(0, Number(opts.threshold ?? 220));
  const enabled = (typeof opts.enabled === 'function') ? opts.enabled : () => true;

  const onScroll = () => {
    try {
      if (!enabled()) return;
      if (scroller.scrollTop + scroller.clientHeight >= (scroller.scrollHeight - threshold)) {
        onNearBottom?.();
      }
    } catch {
      // ignore
    }
  };

  scroller.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    try { scroller.removeEventListener('scroll', onScroll); } catch {}
  };
}

// Standard infinite scroll binding used across panels.
// - De-dupes triggers so re-renders don't accidentally attach multiple listeners.
// - Optionally supports a backfill/queue hook when the cache is exhausted.
//
// Filter conventions (shared across list panels):
// - Prefer ISO 8601 timestamps for server queries.
//   - `since`: inclusive lower bound (e.g. 2026-01-14T00:00:00.000Z)
//   - `until`: inclusive upper bound
// - Prefer filtering at the DB query level when possible so `limit`/`offset` represent
//   the visible list (avoid querying 100 rows and hiding 80 client-side).
// - Common filter keys used by panels:
//   - `q`: free-text query
//   - `types`: array of strings (server-side kind filter)
//   - `since` / `until`: ISO date range
export function bindInfiniteScroll(scroller, loadMore, opts = {}) {
  if (!scroller) return () => {};

  const threshold = Math.max(0, Number(opts.threshold ?? 220));
  const enabled = (typeof opts.enabled === 'function') ? opts.enabled : () => true;
  const isLoading = (typeof opts.isLoading === 'function') ? opts.isLoading : () => false;
  const hasMore = (typeof opts.hasMore === 'function') ? opts.hasMore : () => true;
  const onExhausted = (typeof opts.onExhausted === 'function') ? opts.onExhausted : null;
  const cooldownMs = Math.max(0, Number(opts.cooldownMs ?? 250));
  const exhaustedCooldownMs = Math.max(0, Number(opts.exhaustedCooldownMs ?? 5000));
  const initialTick = (opts.initialTick !== false);

  let cancelled = false;
  let running = false;
  let exhaustedRunning = false;
  let lastRunAt = 0;
  let lastExhaustedAt = 0;

  const tick = async () => {
    if (cancelled) return;
    try {
      if (!enabled()) return;
      if (running || exhaustedRunning) return;
      if (isLoading()) return;

      const now = Date.now();
      if (now - lastRunAt < cooldownMs) return;

      if (hasMore()) {
        running = true;
        lastRunAt = now;
        try {
          await loadMore?.();
        } finally {
          running = false;
        }
        return;
      }

      if (onExhausted && (now - lastExhaustedAt >= exhaustedCooldownMs)) {
        exhaustedRunning = true;
        lastExhaustedAt = now;
        try {
          await onExhausted();
        } finally {
          exhaustedRunning = false;
        }

        // After a backfill attempt, try loading again.
        if (cancelled) return;
        if (isLoading()) return;
        running = true;
        lastRunAt = Date.now();
        try {
          await loadMore?.();
        } finally {
          running = false;
        }
      }
    } catch {
      // Ignore errors; the component should surface them.
    }
  };

  const unbind = bindNearBottom(scroller, () => { tick(); }, { threshold, enabled });
  // If the list doesn't fill the viewport yet, load the next page immediately.
  if (initialTick) queueMicrotask(() => { tick(); });

  return () => {
    cancelled = true;
    try { unbind?.(); } catch {}
  };
}

// --- Scroll stability helpers (shared across panels, cards, and bars) ---

// Find the nearest panel scroller for a component, even when the component is nested
// inside other shadow roots (e.g. <bsky-notifications> inside <bsky-notifications-panel>). 
export function resolvePanelScroller(scope) {
  try {
    let node = scope;
    for (let i = 0; i < 10; i++) {
      if (!node) break;
      const root = (typeof node.getRootNode === 'function') ? node.getRootNode() : null;
      if (root && typeof root.querySelector === 'function') {
        const shell = root.querySelector('bsky-panel-shell');
        const scroller = shell?.getScroller?.();
        if (scroller) return scroller;
      }
      node = root?.host || null;
    }
  } catch {
    // ignore
  }
  return null;
}

export function captureScrollAnchor({ scroller, root, itemSelector, keyAttr } = {}) {
  try {
    if (!scroller || !root) return null;
    const selector = String(itemSelector || '');
    const attr = String(keyAttr || 'data-uri');

    const scRect = scroller.getBoundingClientRect();
    const items = selector ? Array.from(root.querySelectorAll(selector)) : [];

    let best = null;
    let bestRect = null;
    let bestTop = Infinity;

    for (const el of items) {
      const r = el.getBoundingClientRect();
      const visible = (r.bottom > scRect.top + 8) && (r.top < scRect.bottom - 8);
      if (!visible) continue;
      if (r.top < bestTop) {
        best = el;
        bestRect = r;
        bestTop = r.top;
      }
    }

    const key = best?.getAttribute?.(attr) || '';
    const offsetY = bestRect ? (bestRect.top - scRect.top) : 0;

    return {
      key,
      offsetY,
      scrollTop: scroller.scrollTop || 0,
    };
  } catch {
    return null;
  }
}

export function applyScrollAnchor({ scroller, root, anchor, keyAttr } = {}) {
  try {
    if (!scroller || !root || !anchor) return false;
    const attr = String(keyAttr || 'data-uri');
    const key = String(anchor.key || '');

    if (key) {
      const safe = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
        ? CSS.escape(key)
        : key.replace(/[^a-zA-Z0-9_\-]/g, (m) => `\\${m}`);

      const el = root.querySelector?.(`[${attr}="${safe}"]`) || null;
      if (el) {
        const scRect = scroller.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const newOffsetY = r.top - scRect.top;
        const delta = newOffsetY - (Number(anchor.offsetY) || 0);
        if (Number.isFinite(delta) && delta !== 0) {
          scroller.scrollTop = Math.max(0, (scroller.scrollTop || 0) + delta);
        }
        return true;
      }
    }

    if (Number.isFinite(anchor.scrollTop)) {
      scroller.scrollTop = Math.max(0, Number(anchor.scrollTop) || 0);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

// Coalesces repeated layout work into one rAF tick and preserves scroll position
// by anchoring the top-most visible item.
export function createStableWorkQueue({ getScroller, getRoot, itemSelector, keyAttr } = {}) {
  let queued = false;
  return function queueStable(work) {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const scroller = (typeof getScroller === 'function') ? getScroller() : null;
      const root = (typeof getRoot === 'function') ? getRoot() : null;
      const anchor = captureScrollAnchor({ scroller, root, itemSelector, keyAttr });
      try { work?.(); } catch { /* ignore */ }
      requestAnimationFrame(() => applyScrollAnchor({ scroller, root, anchor, keyAttr }));
      setTimeout(() => applyScrollAnchor({ scroller, root, anchor, keyAttr }), 160);
    });
  };
}


export function isMobilePanelsViewport() {
  try {
    // Bootstrap-ish: below md.
    return window.matchMedia('(max-width: 767px)').matches;
  } catch {
    return false;
  }
}

function _resolveTabsRoot(scope) {
  try {
    // Allow passing the tabs root directly.
    if (scope instanceof Element && scope.matches?.('[data-bsky-tabs]')) return scope;

    // If called from inside a component, allow passing `this`.
    if (scope && typeof scope.getRootNode === 'function') {
      const rn = scope.getRootNode();
      if (rn && typeof rn.querySelector === 'function') {
        const r = rn.querySelector('[data-bsky-tabs]');
        if (r) return r;
      }
    }

    // Document / ShadowRoot / Element.
    const q = (scope && typeof scope.querySelector === 'function') ? scope : document;
    return q.querySelector?.('[data-bsky-tabs]') || null;
  } catch {
    return null;
  }
}

export function getTabsApi(scope) {
  const root = _resolveTabsRoot(scope);
  return root?.__bskyTabsApi || null;
}

export function activatePanel(name, scope) {
  getTabsApi(scope)?.activate?.(name);
}

export function deactivatePanel(name, scope) {
  getTabsApi(scope)?.deactivate?.(name);
}

export function placePanelAfter(name, afterName, scope) {
  getTabsApi(scope)?.placeAfter?.(name, afterName);
}

// Convenience helpers for panels/components to drive the aux "content" panel.
// These dispatch a bubbling, composed event that the app shell listens for.
export function openContentPanel(detail = {}, scope) {
  try {
    const target = (scope instanceof EventTarget) ? scope : window;
    target.dispatchEvent(new CustomEvent('bsky-open-content', {
      detail: detail || {},
      bubbles: true,
      composed: true,
    }));
  } catch {
    // ignore
  }
}

export function closeContentPanel(scope) {
  try {
    const target = (scope instanceof EventTarget) ? scope : window;
    target.dispatchEvent(new CustomEvent('bsky-close-content', {
      bubbles: true,
      composed: true,
    }));
  } catch {
    // ignore
  }
}

// Auto-register built-in templates.
import posts from './templates/posts.js';
import connections from './templates/connections.js';
import notifications from './templates/notifications.js';
import content from './templates/content.js';

[posts, connections, notifications, content].forEach(registerPanelTemplate);
