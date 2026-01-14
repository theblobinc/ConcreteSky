// application/single_pages/bluesky_feed/js/main.js
import { call } from './api.js';
import './components/profile.js';
import './components/cache_status.js';
import './components/db_manager.js';
import './components/feed.js';
import './components/notification_bar.js';
import './components/my_posts.js';
import './components/connections.js';
import './components/people_search.js';
import './components/interactions/interactions-modal.js';
import { bootTabs } from './tabs.js';

console.log('[BSKY main] boot', {
  apiPath: window.BSKY?.apiPath,
  csrf: !!window.BSKY?.csrf
});

function setLocked(locked) {
  const root = document.querySelector('[data-bsky-tabs]');
  if (!root) return;
  if (locked) root.setAttribute('data-bsky-locked', '1');
  else root.removeAttribute('data-bsky-locked');
}

function getActiveTabsFromDom() {
  const root = document.querySelector('[data-bsky-tabs]');
  if (!root) return ['posts'];
  const active = Array.from(root.querySelectorAll('[data-tab][aria-pressed="true"]'))
    .map((b) => b.getAttribute('data-tab'))
    .filter(Boolean);
  return active.length ? active : ['posts'];
}

function mountPanels(activeTabs = []) {
  const map = {
    posts: '<bsky-my-posts></bsky-my-posts>',
    connections: '<bsky-connections></bsky-connections>',
    search: '<bsky-people-search></bsky-people-search>',
  };
  document.querySelectorAll('[data-bsky-mount]').forEach((el) => {
    const key = el.getAttribute('data-bsky-mount');
    const shouldMount = Array.isArray(activeTabs) && activeTabs.includes(key);
    const html = shouldMount ? (map[key] || '') : '';
    // Avoid needless DOM churn.
    if (el.innerHTML.trim() !== html) el.innerHTML = html;
  });
}

function unmountPanels() {
  document.querySelectorAll('[data-bsky-mount]').forEach((el) => {
    el.innerHTML = '';
  });
}

let _tabsBooted = false;
function ensureTabsBooted() {
  if (_tabsBooted) return;
  bootTabs();
  _tabsBooted = true;
}

function maybeBackfillProfiles() {
  try {
    const key = 'bsky_profiles_backfill_at';
    const last = Number(localStorage.getItem(key) || 0);
    // Run at most once every 6 hours per browser.
    if (Number.isFinite(last) && last > 0 && (Date.now() - last) < (6 * 60 * 60 * 1000)) return;
    localStorage.setItem(key, String(Date.now()));

    // Fire-and-forget: populate displayName/avatar for existing connected accounts.
    setTimeout(() => {
      call('profilesBackfillAccounts', { max: 20, staleHours: 24 }).catch((e) => {
        console.warn('[BSKY profiles] backfill failed', e);
      });
    }, 2500);
  } catch {
    // ignore
  }
}

let _lastConnected = null;
let _authRefreshInFlight = null;
let _historySyncDid = null;
let _historySyncRunning = false;

async function runHistoryBackfill(auth) {
  const did = auth?.did || auth?.session?.did || null;
  const registered = auth?.c5?.registered !== false;
  if (!auth?.connected || !did || !registered) return;
  if (_historySyncRunning) return;
  if (_historySyncDid && _historySyncDid !== did) {
    _historySyncDid = null;
  }
  if (_historySyncDid === did) return;

  _historySyncDid = did;
  _historySyncRunning = true;
  try {
    // Chunked backfill to avoid long-running requests.
    for (let i = 0; i < 60; i++) {
      const res = await call('cacheBackfillMyPosts', { pagesMax: 10 });
      if (res?.done || !res?.cursor) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch (e) {
    console.warn('[BSKY history] backfill failed', e);
  } finally {
    _historySyncRunning = false;
  }
}

function scheduleBackgroundWork(auth) {
  // Defer heavy background work so initial panel loads (posts/connections) win the network.
  try {
    const run = () => {
      try {
        // Fire-and-forget: build history cache in the background.
        setTimeout(() => { runHistoryBackfill(auth); }, 0);
        // Fire-and-forget: hydrate cached account profiles.
        setTimeout(() => { maybeBackfillProfiles(); }, 250);
      } catch {}
    };

    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 5000 });
    } else {
      setTimeout(run, 1500);
    }
  } catch {
    // ignore
  }
}

async function initGate() {
  try {
    const auth = await call('authStatus', {});
    if (_lastConnected !== !!auth?.connected) {
      _lastConnected = !!auth?.connected;
      window.dispatchEvent(new CustomEvent('bsky-auth-changed', { detail: { connected: !!auth?.connected, auth } }));
    }
    if (auth?.connected) {
      setLocked(false);
      ensureTabsBooted();
      // Mount only panels that are actually visible/active (avoid loading hidden tabs).
      mountPanels(getActiveTabsFromDom());
      scheduleBackgroundWork(auth);
      return;
    }
  } catch {
    // treat as not connected
  }
  // Not connected: hide the app UI and avoid mounting components.
  unmountPanels();
  setLocked(true);
}

// Initial gating and transitions on connect/disconnect.
initGate();
window.addEventListener('bsky-auth-changed', (e) => {
  const connected = !!e?.detail?.connected;
  if (connected) {
    setLocked(false);
    ensureTabsBooted();
    mountPanels(getActiveTabsFromDom());
    scheduleBackgroundWork(e?.detail?.auth);
  } else {
    unmountPanels();
    setLocked(true);
  }
});

// When the user toggles tabs, only mount the active panels.
try {
  const root = document.querySelector('[data-bsky-tabs]');
  root?.addEventListener('bsky-tabs-changed', (e) => {
    const active = Array.isArray(e?.detail?.active) ? e.detail.active : getActiveTabsFromDom();
    mountPanels(active);
  });
} catch {}

// If the user returns to the tab/page after OAuth (bfcache restore or focus), refresh auth state.
function scheduleAuthRefresh() {
  if (_authRefreshInFlight) return _authRefreshInFlight;
  _authRefreshInFlight = (async () => {
    try {
      await initGate();
    } finally {
      _authRefreshInFlight = null;
    }
  })();
  return _authRefreshInFlight;
}

window.addEventListener('pageshow', () => { scheduleAuthRefresh(); });
window.addEventListener('focus', () => { scheduleAuthRefresh(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleAuthRefresh();
});

// Auto-refresh the local SQLite cache (server will skip if it ran recently)
if (window.BSKY?.cacheAvailable !== false) {
  (async () => {
    try {
      const auth = await call('authStatus', {});
      if (!auth?.connected) return;
      // Defer sync so it doesn't compete with initial posts/connections loads.
      setTimeout(async () => {
        try {
          const res = await call('cacheSync', { kind: 'both', mode: 'auto', pagesMax: 50 });
          if (res?.skipped) {
            console.log('[BSKY cache] sync skipped', res);
          } else {
            console.log('[BSKY cache] sync ok', res);
          }
        } catch (e) {
          console.warn('[BSKY cache] sync failed', e);
        }
      }, 2500);
    } catch (e) {
      // If cache is unavailable (sqlite missing), api.js will set window.BSKY.cacheAvailable=false.
      console.warn('[BSKY cache] sync failed', e);
    }
  })();
}
