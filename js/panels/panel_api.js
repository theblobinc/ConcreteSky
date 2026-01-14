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

export function isMobilePanelsViewport() {
  try {
    return window.matchMedia('(max-width: 560px)').matches;
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

// Auto-register built-in templates.
import posts from './templates/posts.js';
import connections from './templates/connections.js';
import search from './templates/search.js';
import notifications from './templates/notifications.js';
import content from './templates/content.js';

[posts, connections, search, notifications, content].forEach(registerPanelTemplate);
