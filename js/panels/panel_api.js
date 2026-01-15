// Standard panel utilities + registry for panel templates.
// This is intentionally small and framework-free so panels remain simple web components.

const _registry = [];

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
import search from './templates/search.js';
import notifications from './templates/notifications.js';
import content from './templates/content.js';

[posts, connections, search, notifications, content].forEach(registerPanelTemplate);
