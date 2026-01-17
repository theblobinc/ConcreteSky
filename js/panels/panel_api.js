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
  // Used to ignore stale delayed anchor-apply attempts across multiple ticks.
  let anchorApplyToken = 0;

  const anchorOpts = (opts && typeof opts === 'object') ? opts.anchor : null;
  const anchorEnabled = !!(anchorOpts && anchorOpts.itemSelector && (anchorOpts.root || anchorOpts.getRoot));
  const anchorKeyAttr = anchorEnabled ? String(anchorOpts.keyAttr || 'data-uri') : null;
  const anchorItemSelector = anchorEnabled ? String(anchorOpts.itemSelector || '') : null;
  const anchorGetRoot = anchorEnabled
    ? ((typeof anchorOpts.getRoot === 'function') ? anchorOpts.getRoot : () => anchorOpts.root)
    : null;
  const anchorTracker = anchorEnabled
    ? createLiveScrollAnchorTracker({
        scroller,
        root: (typeof anchorGetRoot === 'function') ? anchorGetRoot() : null,
        getRoot: anchorGetRoot,
        itemSelector: anchorItemSelector,
        keyAttr: anchorKeyAttr,
      })
    : null;

  const applyAnchorSoon = (anchor) => {
    if (!anchorEnabled || !anchor || typeof anchorGetRoot !== 'function') return;

    const token = ++anchorApplyToken;
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        try {
          if (cancelled) return;
          if (token !== anchorApplyToken) return;
          const r = anchorGetRoot();
          if (!r) return;
          applyScrollAnchor({ scroller, root: r, anchor, keyAttr: anchorKeyAttr });
          setTimeout(() => {
            try {
              if (cancelled) return;
              if (token !== anchorApplyToken) return;
              applyScrollAnchor({ scroller, root: r, anchor, keyAttr: anchorKeyAttr });
            } catch {
              // ignore
            }
          }, 160);
        } catch {
          // ignore
        }
      });
    });
  };

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
        const anchor = anchorTracker?.getAnchor?.() || null;
        try {
          await loadMore?.();
        } finally {
          running = false;
        }
        applyAnchorSoon(anchor);
        return;
      }

      if (onExhausted && (now - lastExhaustedAt >= exhaustedCooldownMs)) {
        exhaustedRunning = true;
        lastExhaustedAt = now;
        const anchor = anchorTracker?.getAnchor?.() || null;
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

        applyAnchorSoon(anchor);
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
    try { anchorTracker?.disconnect?.(); } catch {}
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
    const scCenter = (scRect.top + scRect.bottom) / 2;
    const items = selector ? Array.from(root.querySelectorAll(selector)) : [];

    let best = null;
    let bestRect = null;
    let bestDist = Infinity;

    for (const el of items) {
      const r = el.getBoundingClientRect();
      const visible = (r.bottom > scRect.top + 8) && (r.top < scRect.bottom - 8);
      if (!visible) continue;
      const itemCenter = (r.top + r.bottom) / 2;
      const dist = Math.abs(itemCenter - scCenter);
      if (dist < bestDist) {
        best = el;
        bestRect = r;
        bestDist = dist;
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

// Tracks which list entries are currently visible in the scroller and returns
// the center-most visible entry as an anchor. This is more robust than a
// one-time snapshot when the list is re-rendered or reflowed multiple times.
export function createLiveScrollAnchorTracker({ scroller, root, getRoot, itemSelector, keyAttr } = {}) {
  const selector = String(itemSelector || '');
  const attr = String(keyAttr || 'data-uri');
  if (!scroller || !selector || (!root && typeof getRoot !== 'function')) {
    return {
      getAnchor: () => null,
      disconnect: () => {},
    };
  }

  // Fallback for older browsers: compute anchors on-demand via a scan.
  if (typeof IntersectionObserver === 'undefined' || typeof MutationObserver === 'undefined') {
    const resolveRoot = () => {
      try {
        const r = (typeof getRoot === 'function') ? getRoot() : root;
        return (r && typeof r.querySelectorAll === 'function') ? r : null;
      } catch {
        return null;
      }
    };
    return {
      getAnchor: () => captureScrollAnchor({ scroller, root: resolveRoot(), itemSelector: selector, keyAttr: attr }),
      disconnect: () => {},
    };
  }

  const resolveRoot = () => {
    try {
      const r = (typeof getRoot === 'function') ? getRoot() : root;
      return (r && typeof r.querySelectorAll === 'function') ? r : null;
    } catch {
      return null;
    }
  };

  const visible = new Set();

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) visible.add(e.target);
      else visible.delete(e.target);
    }
  }, {
    root: scroller,
    threshold: [0, 0.01, 0.25],
  });

  const observeAllIn = (node) => {
    try {
      if (!node) return;
      if (node instanceof Element && node.matches?.(selector)) io.observe(node);
      const q = (node && typeof node.querySelectorAll === 'function') ? node : null;
      const els = q ? q.querySelectorAll(selector) : [];
      for (const el of Array.from(els || [])) io.observe(el);
    } catch {
      // ignore
    }
  };

  const unobserveAllIn = (node) => {
    try {
      if (!node) return;
      if (node instanceof Element && node.matches?.(selector)) {
        visible.delete(node);
        io.unobserve(node);
      }
      const q = (node && typeof node.querySelectorAll === 'function') ? node : null;
      const els = q ? q.querySelectorAll(selector) : [];
      for (const el of Array.from(els || [])) {
        visible.delete(el);
        io.unobserve(el);
      }
    } catch {
      // ignore
    }
  };

  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of Array.from(m.addedNodes || [])) observeAllIn(n);
      for (const n of Array.from(m.removedNodes || [])) unobserveAllIn(n);
    }
  });

  const rootNow = resolveRoot();
  if (rootNow) {
    observeAllIn(rootNow);
    try { mo.observe(rootNow, { childList: true, subtree: true }); } catch {}
  }

  const getAnchor = () => {
    try {
      const r = resolveRoot();
      if (!r) return null;

      // Prefer the center-most visible element for stability.
      const scRect = scroller.getBoundingClientRect();
      const scCenter = (scRect.top + scRect.bottom) / 2;

      let best = null;
      let bestRect = null;
      let bestDist = Infinity;

      for (const el of visible) {
        if (!el || !el.isConnected) continue;
        const rect = el.getBoundingClientRect();
        const isVisible = (rect.bottom > scRect.top + 8) && (rect.top < scRect.bottom - 8);
        if (!isVisible) continue;
        const itemCenter = (rect.top + rect.bottom) / 2;
        const dist = Math.abs(itemCenter - scCenter);
        if (dist < bestDist) {
          best = el;
          bestRect = rect;
          bestDist = dist;
        }
      }

      const key = best?.getAttribute?.(attr) || '';
      if (key && bestRect) {
        const offsetY = bestRect.top - scRect.top;
        return {
          key,
          offsetY,
          scrollTop: scroller.scrollTop || 0,
        };
      }

      // Fallback: a one-time scan if the observer set is empty or keys are missing.
      return captureScrollAnchor({ scroller, root: r, itemSelector: selector, keyAttr: attr });
    } catch {
      return null;
    }
  };

  const disconnect = () => {
    try { mo.disconnect(); } catch {}
    try { io.disconnect(); } catch {}
    try { visible.clear(); } catch {}
  };

  return { getAnchor, disconnect };
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
