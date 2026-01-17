import { getHashTabs, setHashTabs } from './hash_tabs.js';
import { loadJson } from './storage.js';
import { getTabOrder, applyTabOrder } from './tab_order.js';
import { enableSortable } from './sortable.js';
import { enablePanelResize } from './panel_resize.js';
import { isMobilePanelsViewport } from './panel_api.js';

function initTabs(root) {
  const buttons = Array.from(root.querySelectorAll('[data-tab]'));
  const panels = Array.from(root.querySelectorAll('[data-panel]'));
  const panelsWrap = root.querySelector('.panels');
  const byName = new Map(panels.map((p) => [p.getAttribute('data-panel'), p]));
  const tabNames = new Set(buttons.map((b) => b.getAttribute('data-tab')).filter(Boolean));

  const isSingleSelectViewport = () => {
    try { return isMobilePanelsViewport(); } catch { return false; }
  };

  // One-click escape hatch if a saved panel width locks you into 1-column layouts.
  const resetLayout = () => {
    try {
      localStorage.removeItem('bsky_panel_widths');
    } catch {
      // ignore
    }
    for (const p of panels) {
      p.style.flex = '';
      p.style.flexBasis = '';
    }
    // Nudge layouts so components can reflow.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  };

  // Back-compat: if a button with this id exists in the DOM, allow clicking it.
  root.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('#bsky-reset-layout');
    if (!btn) return;
    resetLayout();
    e.preventDefault();
    e.stopPropagation();
  });

  // Preferred: trigger from anywhere (e.g. notification settings) via a global event.
  window.addEventListener('bsky-reset-layout', () => {
    resetLayout();
  });

  // Apply saved ordering before we wire events.
  applyTabOrder(root, getTabOrder(root));

  const normalize = (arr) => Array.from(new Set((arr || []).filter((n) => n && byName.has(n))));

  const getActive = () => buttons
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.getAttribute('data-tab'))
    .filter(Boolean);

  const getVisible = () => {
    const active = getActive();
    const aux = panels
      .filter((p) => !p.hasAttribute('hidden'))
      .map((p) => p.getAttribute('data-panel'))
      .filter((n) => n && !tabNames.has(n));
    return Array.from(new Set([...active, ...aux]));
  };

  const setActive = (names) => {
    // Only tab-backed panels are considered "active" for persistence/hash.
    let activeTabs = normalize(names).filter((n) => tabNames.has(n));
    if (isSingleSelectViewport() && activeTabs.length > 1) {
      activeTabs = [activeTabs[0]];
    }
    if (!activeTabs.length) return;

    const mobile = isSingleSelectViewport();

    // Preserve any currently-visible aux panels (panels without a tab button).
    const auxVisible = panels
      .filter((p) => !p.hasAttribute('hidden'))
      .map((p) => p.getAttribute('data-panel'))
      .filter((n) => n && !tabNames.has(n));

    // Desktop: visible is the active set + any aux panels.
    // Mobile: keep ALL primary panels visible so users can swipe between them.
    const visible = mobile
      ? Array.from(new Set([...Array.from(tabNames), ...auxVisible]))
      : Array.from(new Set([...activeTabs, ...auxVisible]));

    for (const btn of buttons) {
      const on = activeTabs.includes(btn.getAttribute('data-tab'));
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('is-active', on);
    }
    for (const p of panels) {
      const on = visible.includes(p.getAttribute('data-panel'));
      const pn = p.getAttribute('data-panel');
      // Mobile: never hide primary panels (keeps swipe navigation working).
      if (mobile && pn && tabNames.has(pn)) {
        p.removeAttribute('hidden');
        continue;
      }
      p.toggleAttribute('hidden', !on);
    }

    try {
      localStorage.setItem('bsky_active_tabs', JSON.stringify(activeTabs));
    } catch {
      // ignore
    }

    setHashTabs(activeTabs);

    // Notify panels/components that visibility changed (some layouts need a reflow).
    try {
      root.dispatchEvent(
        new CustomEvent('bsky-tabs-changed', { detail: { active: activeTabs, visible }, bubbles: true, composed: true })
      );
    } catch {
      // ignore
    }

    // Mobile: selecting a tab should bring that panel into the foreground.
    if (mobile && panelsWrap) {
      const target = byName.get(activeTabs[0]);
      if (target) {
        try {
          panelsWrap.scrollTo({ left: target.offsetLeft, behavior: 'smooth' });
        } catch {
          try { panelsWrap.scrollLeft = target.offsetLeft; } catch {}
        }
      }
    }
  };

  const toggle = (name) => {
    if (!name || !byName.has(name)) return;

    // Aux panels are toggled directly and are not persisted.
    if (!tabNames.has(name)) {
      const p = byName.get(name);
      if (!p) return;
      const willShow = p.hasAttribute('hidden');
      p.toggleAttribute('hidden', !willShow);
      try {
        const active = getActive();
        const visible = getVisible();
        root.dispatchEvent(new CustomEvent('bsky-tabs-changed', { detail: { active, visible }, bubbles: true, composed: true }));
      } catch {
        // ignore
      }
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      return;
    }

    const current = getActive();

    // Mobile: tabs are single-select (never toggle off; never multi-select).
    if (isSingleSelectViewport()) {
      if (current.length === 1 && current[0] === name) return;

      // Switching primaries closes any aux subpanels (e.g. content overlay).
      for (const p of panels) {
        const pn = p.getAttribute('data-panel') || '';
        if (pn && !tabNames.has(pn)) p.setAttribute('hidden', '');
      }

      setActive([name]);
      return;
    }

    const next = new Set(current);
    if (next.has(name)) {
      if (next.size === 1) return; // never allow zero
      next.delete(name);
    } else {
      next.add(name);
    }
    setActive(Array.from(next));
  };

  const activate = (name) => {
    if (!name || !byName.has(name)) return;

    // Aux panels: show directly.
    if (!tabNames.has(name)) {
      const p = byName.get(name);
      if (p) p.removeAttribute('hidden');
      try {
        const active = getActive();
        const visible = getVisible();
        root.dispatchEvent(new CustomEvent('bsky-tabs-changed', { detail: { active, visible }, bubbles: true, composed: true }));
      } catch {
        // ignore
      }
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      return;
    }

    // Mobile: tabs are single-select.
    if (isSingleSelectViewport()) {
      for (const p of panels) {
        const pn = p.getAttribute('data-panel') || '';
        if (pn && !tabNames.has(pn)) p.setAttribute('hidden', '');
      }
      setActive([name]);
      return;
    }

    const current = new Set(getActive());
    current.add(name);
    setActive(Array.from(current));
  };

  const deactivate = (name) => {
    if (!name || !byName.has(name)) return;

    // Aux panels: hide directly.
    if (!tabNames.has(name)) {
      const p = byName.get(name);
      if (p) p.setAttribute('hidden', '');
      try {
        const active = getActive();
        const visible = getVisible();
        root.dispatchEvent(new CustomEvent('bsky-tabs-changed', { detail: { active, visible }, bubbles: true, composed: true }));
      } catch {
        // ignore
      }
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      return;
    }
    const current = new Set(getActive());
    if (!current.has(name)) return;
    if (current.size === 1) return;
    current.delete(name);
    setActive(Array.from(current));
  };

  const placeAfter = (name, afterName) => {
    if (!name || !afterName) return;
    if (!byName.has(name) || !byName.has(afterName)) return;
    if (name === afterName) return;

    try {
      // Move tab button.
      const btn = root.querySelector(`[data-tab="${CSS.escape(name)}"]`);
      const afterBtn = root.querySelector(`[data-tab="${CSS.escape(afterName)}"]`);
      const btnParent = afterBtn?.parentElement;
      if (btn && afterBtn && btnParent && btnParent === btn.parentElement) {
        btnParent.insertBefore(btn, afterBtn.nextSibling);
      }
    } catch {
      // ignore
    }

    try {
      // Move panel section.
      const panel = root.querySelector(`.panel[data-panel="${CSS.escape(name)}"]`);
      const afterPanel = root.querySelector(`.panel[data-panel="${CSS.escape(afterName)}"]`);
      const panelsWrap = afterPanel?.parentElement;
      if (panel && afterPanel && panelsWrap && panelsWrap === panel.parentElement) {
        panelsWrap.insertBefore(panel, afterPanel.nextSibling);
      }
    } catch {
      // ignore
    }

    // Nudge layouts that depend on visibility/order.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  };

  // Expose an internal API for programmatic panel activation.
  // This stays attached to the tabs root so it works across shadow boundaries.
  try {
    root.__bskyTabsApi = { setActive, getActive, toggle, activate, deactivate, placeAfter };
  } catch {
    // ignore
  }

  root.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-tab]');
    if (!btn) return;
    toggle(btn.getAttribute('data-tab'));
  });

  // Initial tabs priority: hash → localStorage → default
  let initial = getHashTabs();
  if (!initial) {
    initial = loadJson('bsky_active_tabs', null);
  }
  if (!initial || !initial.length) {
    initial = [buttons[0]?.getAttribute('data-tab') || 'posts'];
  }
  setActive(initial);

  // If user manually edits hash / uses back/forward
  window.addEventListener('hashchange', () => {
    const t = getHashTabs();
    if (t && t.length) setActive(t);
  });

  // Mobile: update active tab when user swipes between primary panels.
  try {
    if (panelsWrap) {
      let swipeTimer = null;
      const pickForeground = () => {
        if (!isSingleSelectViewport()) return;
        const wrapRect = panelsWrap.getBoundingClientRect();
        const left0 = wrapRect.left;
        let best = null;
        let bestDx = Infinity;
        for (const name of tabNames) {
          const el = byName.get(name);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          const dx = Math.abs(r.left - left0);
          if (dx < bestDx) { bestDx = dx; best = name; }
        }
        if (!best) return;
        const cur = getActive();
        if (cur.length === 1 && cur[0] === best) return;
        // Swiping away closes any aux overlays.
        for (const p of panels) {
          const pn = p.getAttribute('data-panel') || '';
          if (pn && !tabNames.has(pn)) p.setAttribute('hidden', '');
        }
        setActive([best]);
      };
      panelsWrap.addEventListener('scroll', () => {
        if (!isSingleSelectViewport()) return;
        if (swipeTimer) { try { clearTimeout(swipeTimer); } catch {} }
        swipeTimer = setTimeout(() => {
          swipeTimer = null;
          pickForeground();
        }, 120);
      }, { passive: true });
    }
  } catch {
    // ignore
  }

  // Optional: sortable tab reorder + resizable panels
  enableSortable(root);
  enablePanelResize(root);
}

export function bootTabs(scope = document) {
  const q = (scope && typeof scope.querySelector === 'function') ? scope : document;
  // Support either passing the actual root element or a broader scope.
  const root = (q instanceof Element && q.matches?.('[data-bsky-tabs]')) ? q : q.querySelector('[data-bsky-tabs]');
  if (!root) return;
  initTabs(root);
}
