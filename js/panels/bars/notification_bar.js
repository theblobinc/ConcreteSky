import { call } from '../../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../../auth_state.js';
import { identityCss, identityHtml, bindCopyClicks } from '../../lib/identity.js';
import { PanelListController } from '../../controllers/panel_list_controller.js';
import { ListWindowingController } from '../../controllers/list_windowing_controller.js';
import { renderListEndcap } from '../panel_api.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));

const fmtAge = (iso) => {
  if (!iso) return '';
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
  } catch {
    return '';
  }
};

// Convert at://did/app.bsky.feed.post/rkey → https://bsky.app/profile/did/post/rkey
const atUriToWebPost = (uri) => {
  const m = String(uri || '').match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)/);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : '';
};

// Convert at://did/app.bsky.actor.profile/self → https://bsky.app/profile/did
const atUriToWebProfile = (uri) => {
  const m = String(uri || '').match(/^at:\/\/([^/]+)\/app\.bsky\.actor\.profile\/self/);
  return m ? `https://bsky.app/profile/${m[1]}` : '';
};

const STORAGE_KEY_FILTERS = 'bsky.notifBar.filters.v1';
const REASONS = ['follow', 'like', 'reply', 'repost', 'mention', 'quote', 'subscribed-post', 'subscribed'];

function dataUrlToBase64(dataUrl) {
  const s = String(dataUrl || '');
  const i = s.indexOf(',');
  return (i >= 0) ? s.slice(i + 1) : '';
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    try {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('Failed to read file'));
      fr.onload = () => resolve(String(fr.result || ''));
      fr.readAsDataURL(file);
    } catch (e) {
      reject(e);
    }
  });
}

 function normalizeNotification(n) {
   const base = (n && typeof n === 'object') ? n : {};
   const rawAuthor = (base.author && typeof base.author === 'object') ? base.author : {};

   const did = rawAuthor.did || base.authorDid || base.author_did || '';
   const handle = rawAuthor.handle || base.authorHandle || base.author_handle || '';
   const displayName = rawAuthor.displayName || base.authorDisplayName || base.author_display_name || '';
   const avatar = rawAuthor.avatar || base.authorAvatar || base.author_avatar || '';

   return {
     ...base,
     author: {
       ...rawAuthor,
       did: did || rawAuthor.did || '',
       handle: handle || rawAuthor.handle || '',
       displayName: displayName || rawAuthor.displayName || '',
       avatar: avatar || rawAuthor.avatar || '',
     },
   };
 }

class BskyNotificationBar extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this.items = [];
    this.followMap = {};

    this.loading = false;
    this.error = null;
    this.connected = false;

    this.filters = { hours: 24, reasons: new Set(REASONS), onlyNotFollowed: false };
    this.expanded = false;

    this.mode = 'notifications'; // 'notifications' | 'settings'
    this.settingsTab = 'cache';
    this.unseen = 0;

    this._profileEdit = {
      loaded: false,
      loading: false,
      saving: false,
      error: null,
      status: null,
      displayName: '',
      description: '',
      currentAvatar: '',
      currentBanner: '',
      avatar: { file: null, dataUrl: '', mime: '', clear: false },
      banner: { file: null, dataUrl: '', mime: '', clear: false },
    };

    this._markSeenBusy = false;

    // Keyed by actor DID: { open, loading, error, followers, fetchedAt }
    this._knownFollowers = new Map();

    this._page = {
      cacheOffset: 0,
      cacheLimit: 50,
      xrpcCursor: null,
      done: false,
      loadingMore: false,
    };

    this._timer = null;
    this._autoBasePeriodSec = 60;
    this._autoMaxPeriodSec = 15 * 60;
    this._autoPeriodSec = 60;
    this._autoFailures = 0;
    this._lookbackMinutes = 2;

    this._nextAutoAt = Date.now() + (this._autoPeriodSec * 1000);
    this._clockTimer = null;

    this._listCtl = new PanelListController(this, {
      itemSelector: '.row[data-k]',
      keyAttr: 'data-k',
      getRoot: () => this.shadowRoot,
      getScroller: () => {
        try { return this.shadowRoot?.querySelector?.('[data-list]') || null; } catch { return null; }
      },
      onLoadMore: () => this.loadMore(),
      enabled: () => this.expanded && this.mode === 'notifications',
      isLoading: () => !!this.loading || !!this._page.loadingMore,
      hasMore: () => !this._page.done,
      threshold: 200,
      cooldownMs: 250,
      ensureKeyVisible: (key) => this._winCtl?.ensureKeyVisible?.(key),
    });

    this._winCtl = new ListWindowingController(this, {
      listSelector: '[data-win]',
      itemSelector: '.row[data-k]',
      keyAttr: 'data-k',
      getRoot: () => this.shadowRoot,
      getScroller: () => {
        try { return this.shadowRoot?.querySelector?.('[data-list]') || null; } catch { return null; }
      },
      enabled: () => this.expanded && this.mode === 'notifications',
      getLayout: () => 'list',
      minItemsToWindow: 140,
      estimatePx: 86,
      overscanItems: 36,
      keyFor: (n) => String(this.notifKey(n) || ''),
      renderRow: (n) => this._renderNotifRow(n),
    });

    this._syncRecentTimer = null;
    this._syncRecentNextAt = 0;
    this._syncRecentQueuedMinutes = 0;
    this._syncRecentThrottleMs = 8000;
    this._suppressNextRefreshRecent = false;

    this._refreshRecentHandler = (e) => {
      if (this._suppressNextRefreshRecent) {
        this._suppressNextRefreshRecent = false;
        return;
      }
      const mins = Number(e?.detail?.minutes ?? this._lookbackMinutes);
      this.refreshRecent(mins);
    };

    this._syncRecentHandler = (e) => {
      const mins = Math.max(1, Number(e?.detail?.minutes ?? this._lookbackMinutes));
      this._syncRecentQueuedMinutes = Math.max(this._syncRecentQueuedMinutes || 0, mins);

      if (this._syncRecentTimer) return;

      const now = Date.now();
      const wait = Math.max(300, this._syncRecentNextAt ? (this._syncRecentNextAt - now) : 0);

      this._syncRecentTimer = setTimeout(async () => {
        const minutes = Math.max(1, Number(this._syncRecentQueuedMinutes || this._lookbackMinutes));
        this._syncRecentQueuedMinutes = 0;
        this._syncRecentTimer = null;
        this._syncRecentNextAt = Date.now() + this._syncRecentThrottleMs;

        try {
          await this.syncRecentThenRefresh(minutes);
        } catch (err) {
          console.warn('notif bar syncRecentThenRefresh failed', err);
        }

        // Tell other panels to pull in the newly-synced cached rows.
        try {
          this._suppressNextRefreshRecent = true;
          window.dispatchEvent(new CustomEvent('bsky-refresh-recent', { detail: { minutes } }));
        } catch {}
      }, Math.max(0, wait));
    };

    this._authChangedHandler = (e) => {
      const connected = !!e?.detail?.connected;
      this.connected = connected;
      if (!connected) {
        this.items = [];
        this.error = null;
        this.render();
        return;
      }
      this.error = null;
      this.load(true);
    };

    this._cacheUnavailableHandler = () => {
      // If cache went away (sqlite missing), immediately re-load using XRPC fallback.
      this.load(true);
    };

    this._openSettingsHandler = () => {
      this.mode = 'settings';
      this.setExpanded(true);
      this.render();
    };

    this._visHandler = () => {
      // When the tab becomes visible again, try a quick refresh.
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!this.connected) return;
      this._autoFailures = 0;
      this._autoPeriodSec = this._autoBasePeriodSec;
      this._scheduleNextAuto({ delaySec: 1 });
    };

    this._onlineHandler = () => {
      if (!this.connected) return;
      this._autoFailures = 0;
      this._autoPeriodSec = this._autoBasePeriodSec;
      this._scheduleNextAuto({ delaySec: 1 });
    };
  }

  _notifTimeIso(n) {
    if (!n || typeof n !== 'object') return '';
    if (n.__group) {
      const iso = String(n.__seenAt || n.indexedAt || n.createdAt || '').trim();
      if (iso) return iso;
      const kids = Array.isArray(n.notifications) ? n.notifications : [];
      return String(kids[0]?.indexedAt || kids[0]?.createdAt || '').trim();
    }
    return String(n?.indexedAt || n?.createdAt || '').trim();
  }

  _isUnread(n) {
    // Bluesky listNotifications includes `isRead`; cache preserves it in raw_json.
    // Treat missing as unknown/read to avoid false "unread" spikes.
    if (!n || typeof n !== 'object') return false;
    if (n.__group && Array.isArray(n.notifications)) {
      return n.notifications.some((x) => this._isUnread(x));
    }
    if (typeof n.isRead === 'boolean') return !n.isRead;
    if (typeof n.isRead === 'number') return n.isRead === 0;
    return false;
  }

  _authorsFor(n) {
    if (!n || typeof n !== 'object') return [];
    if (n.__group && Array.isArray(n.authors)) return n.authors.filter(Boolean);
    return [n.author].filter(Boolean);
  }

  _groupKeyFor(n) {
    try {
      const reason = String(n?.reason || '').trim();
      if (!reason) return '';
      const groupable = new Set(['like', 'repost', 'quote']);
      if (!groupable.has(reason)) return '';
      const subj = String(n?.reasonSubject || '').trim();
      if (!subj || !subj.startsWith('at://')) return '';
      return `${reason}|${subj}`;
    } catch {
      return '';
    }
  }

  _groupNotificationsForDisplay(items) {
    const src = Array.isArray(items) ? items : [];
    if (!src.length) return src;

    const out = [];
    let cur = null;

    const flush = () => {
      if (!cur) return;
      if (Array.isArray(cur.notifications) && cur.notifications.length >= 2) out.push(cur);
      else if (Array.isArray(cur.notifications) && cur.notifications[0]) out.push(cur.notifications[0]);
      cur = null;
    };

    for (const n of src) {
      const key = this._groupKeyFor(n);
      if (!key) {
        flush();
        out.push(n);
        continue;
      }

      if (!cur || cur.__groupKey !== key) {
        flush();
        const t = this._notifTimeIso(n);
        cur = {
          __group: true,
          __groupKey: key,
          __key: `g|${key}|${t || ''}`,
          __seenAt: t || '',
          reason: n?.reason,
          reasonSubject: n?.reasonSubject,
          uri: n?.uri,
          indexedAt: n?.indexedAt,
          createdAt: n?.createdAt,
          author: n?.author,
          authors: [n?.author].filter(Boolean),
          notifications: [n],
        };
        continue;
      }

      cur.notifications.push(n);
      const did = n?.author?.did;
      if (did && !cur.authors.some((a) => a?.did === did)) cur.authors.push(n.author);
    }

    flush();
    return out;
  }

  _recountUnread() {
    try {
      const items = this.filteredItems();
      this.unseen = items.filter((n) => this._isUnread(n)).length;
    } catch {
      this.unseen = 0;
    }
  }

  async markAllRead() {
    if (this._markSeenBusy) return;
    this._markSeenBusy = true;
    this.render();

    try {
      const seenAt = new Date().toISOString();
      await call('updateSeenNotifications', { seenAt });

      // Refresh recent notifications so cached rows reflect isRead.
      await this.syncRecentThenRefresh(Math.max(5, this._lookbackMinutes));
      this._recountUnread();
      this.render();
    } catch (e) {
      console.warn('markAllRead failed', e);
    } finally {
      this._markSeenBusy = false;
      this.render();
    }
  }

  async markReadThrough(iso) {
    if (this._markSeenBusy) return;
    const seenAt = String(iso || '').trim();
    if (!seenAt) return;

    this._markSeenBusy = true;
    this.render();

    try {
      await call('updateSeenNotifications', { seenAt });
      await this.syncRecentThenRefresh(Math.max(5, this._lookbackMinutes));
      this._recountUnread();
      this.render();
    } catch (e) {
      console.warn('markReadThrough failed', e);
    } finally {
      this._markSeenBusy = false;
      this.render();
    }
  }

  _isRateLimitError(e) {
    return (e && (e.status === 429 || e.code === 'RATE_LIMITED' || e.name === 'RateLimitError'))
      || /\bHTTP\s*429\b/i.test(String(e?.message || ''));
  }

  _retryAfterSeconds(e) {
    const v = e?.retryAfterSeconds;
    if (Number.isFinite(v) && v >= 0) return v;
    const msg = String(e?.message || '');
    const m = msg.match(/retry-after:\s*([^\)\s]+)/i);
    if (!m) return null;
    const raw = String(m[1] || '').trim();
    if (/^\d+$/.test(raw)) return Math.max(0, parseInt(raw, 10));
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Math.ceil((t - Date.now()) / 1000));
  }

  _withJitter(sec) {
    const s = Math.max(1, Number(sec || 1));
    const j = 0.1;
    const r = (Math.random() * 2 - 1) * j;
    return Math.max(1, Math.round(s * (1 + r)));
  }

  _computeNextAutoDelaySec({ error = null } = {}) {
    const hidden = (typeof document !== 'undefined' && !!document.hidden);
    const offline = (typeof navigator !== 'undefined' && navigator.onLine === false);

    // When hidden/offline: be gentle.
    if (offline) return Math.max(60, Math.min(this._autoMaxPeriodSec, 5 * 60));
    if (hidden) return Math.max(60, Math.min(this._autoMaxPeriodSec, 3 * 60));

    if (!error) return this._autoBasePeriodSec;

    // Rate limit: honor Retry-After if we can.
    if (this._isRateLimitError(error)) {
      const ra = this._retryAfterSeconds(error);
      if (Number.isFinite(ra) && ra > 0) return Math.min(this._autoMaxPeriodSec, Math.max(5, ra));
      return Math.min(this._autoMaxPeriodSec, Math.max(10, this._autoBasePeriodSec * 2));
    }

    // Generic failure: exponential backoff.
    const failures = Math.max(1, Number(this._autoFailures || 1));
    const next = Math.min(this._autoMaxPeriodSec, this._autoBasePeriodSec * Math.pow(2, Math.min(6, failures)));
    return Math.max(this._autoBasePeriodSec, next);
  }

  _scheduleNextAuto({ delaySec } = {}) {
    try {
      const sec = this._withJitter(Math.max(1, Number(delaySec || this._autoBasePeriodSec)));
      this._autoPeriodSec = sec;

      if (this._timer) {
        try { clearTimeout(this._timer); } catch {}
        this._timer = null;
      }

      this._nextAutoAt = Date.now() + (sec * 1000);

      this._timer = setTimeout(async () => {
        this._timer = null;
        await this._autoTick();
      }, sec * 1000);
    } catch {
      // ignore
    }
  }

  async _autoTick() {
    if (!this.connected) {
      this._scheduleNextAuto({ delaySec: this._autoBasePeriodSec });
      return;
    }

    const hidden = (typeof document !== 'undefined' && !!document.hidden);
    const offline = (typeof navigator !== 'undefined' && navigator.onLine === false);
    if (hidden || offline) {
      this._scheduleNextAuto({ delaySec: this._computeNextAutoDelaySec({ error: null }) });
      return;
    }

    let syncError = null;
    try {
      const res = await this.syncRecentThenRefresh(this._lookbackMinutes);
      syncError = res?.error || null;
    } catch (e) {
      syncError = e;
    }

    if (syncError) {
      this._autoFailures = Math.max(1, Number(this._autoFailures || 0) + 1);
    } else {
      this._autoFailures = 0;
    }

    const nextSec = this._computeNextAutoDelaySec({ error: syncError });
    this._scheduleNextAuto({ delaySec: nextSec });
  }

  async toggleFollow(did) {
    if (!did) return;
    try {
      const rel = this.followMap[did] || {};
      if (rel.following) {
        await call('unfollow', { did });
        this.followMap = { ...this.followMap, [did]: { ...rel, following: false } };
      } else {
        await call('follow', { did });
        this.followMap = { ...this.followMap, [did]: { ...rel, following: true } };
      }
      this.render();
    } catch (e) {
      console.warn('toggleFollow failed', e);
    }
  }

  _kfState(key) {
    const k = String(key || '').trim();
    if (!k) return { open: false, loading: false, error: '', followers: null, fetchedAt: null };
    const cur = this._knownFollowers.get(k);
    if (cur && typeof cur === 'object') return cur;
    return { open: false, loading: false, error: '', followers: null, fetchedAt: null };
  }

  _setKfState(key, next) {
    const k = String(key || '').trim();
    if (!k) return;
    this._knownFollowers.set(k, { ...this._kfState(k), ...(next || {}) });
  }

  _fmtKnownFollowersLine(list) {
    const items = Array.isArray(list) ? list : [];
    const names = items
      .map((p) => p?.displayName || (p?.handle ? `@${p.handle}` : '') || p?.did)
      .filter(Boolean);
    if (!names.length) return '';
    if (names.length === 1) return `Followed by ${names[0]}`;
    if (names.length === 2) return `Followed by ${names[0]} and ${names[1]}`;
    return `Followed by ${names[0]}, ${names[1]}, and ${names.length - 2} others`;
  }

  async _toggleKnownFollowers(actorDid) {
    const did = String(actorDid || '').trim();
    if (!did) return;

    const cur = this._kfState(did);
    const nextOpen = !cur.open;
    this._setKfState(did, { open: nextOpen, error: cur.error || '' });
    this.render();

    if (!nextOpen) return;
    if (cur.loading) return;
    if (Array.isArray(cur.followers)) return;

    this._setKfState(did, { loading: true, error: '' });
    this.render();

    try {
      const res = await call('getKnownFollowers', { actor: did, limit: 10, pagesMax: 10 });
      const followers = Array.isArray(res?.followers) ? res.followers : [];
      const mapped = followers.map((p) => ({
        did: String(p?.did || ''),
        handle: String(p?.handle || ''),
        displayName: String(p?.displayName || p?.display_name || ''),
        avatar: String(p?.avatar || ''),
      })).filter((p) => p.did || p.handle);
      this._setKfState(did, { followers: mapped, loading: false, error: '', fetchedAt: new Date().toISOString() });
    } catch (e) {
      const msg = e?.message || String(e || 'Failed to load followers you know');
      this._setKfState(did, { loading: false, error: msg, followers: [] });
    } finally {
      this.render();
    }
  }

  connectedCallback() {
    // Always start collapsed; users can expand when they want.
    // (We persist filters, not open/closed state.)
    this.expanded = false;
    this.loadFilters();
    this.render();

    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
    this.shadowRoot.addEventListener('change', (e) => this.onChange(e));

    window.addEventListener('bsky-refresh-recent', this._refreshRecentHandler);
    window.addEventListener('bsky-sync-recent', this._syncRecentHandler);
    window.addEventListener('bsky-auth-changed', this._authChangedHandler);
    window.addEventListener('bsky-cache-unavailable', this._cacheUnavailableHandler);
    window.addEventListener('bsky-open-settings', this._openSettingsHandler);
    try { document.addEventListener('visibilitychange', this._visHandler); } catch {}
    try { window.addEventListener('online', this._onlineHandler); } catch {}

    // Enable copy-DID buttons inside this component.
    bindCopyClicks(this.shadowRoot);

    this.init();
    this.startTimer();
    this.startClock();
  }

  disconnectedCallback() {
    window.removeEventListener('bsky-refresh-recent', this._refreshRecentHandler);
    window.removeEventListener('bsky-sync-recent', this._syncRecentHandler);
    window.removeEventListener('bsky-auth-changed', this._authChangedHandler);
    window.removeEventListener('bsky-cache-unavailable', this._cacheUnavailableHandler);
    window.removeEventListener('bsky-open-settings', this._openSettingsHandler);
    try { document.removeEventListener('visibilitychange', this._visHandler); } catch {}
    try { window.removeEventListener('online', this._onlineHandler); } catch {}
    this.stopTimer();
    this.stopClock();
    try { this._listCtl?.disconnect?.(); } catch {}
  }

  setExpanded(v) {
    this.expanded = !!v;
    if (this.expanded && this.mode === 'notifications') {
      this.unseen = 0;
    }
    this.render();
  }

  loadFilters() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_FILTERS);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const hours = Number(parsed?.hours);
      const onlyNotFollowed = !!parsed?.onlyNotFollowed;
      const reasons = Array.isArray(parsed?.reasons) ? parsed.reasons.map(String) : null;

      if (Number.isFinite(hours) && hours > 0) this.filters.hours = hours;
      this.filters.onlyNotFollowed = onlyNotFollowed;
      if (reasons && reasons.length) {
        this.filters.reasons = new Set(reasons.filter((r) => REASONS.includes(r)));
        if (this.filters.reasons.size === 0) this.filters.reasons = new Set(REASONS);
      }
    } catch {
      // ignore
    }
  }

  saveFilters() {
    try {
      localStorage.setItem(STORAGE_KEY_FILTERS, JSON.stringify({
        hours: this.filters.hours,
        onlyNotFollowed: this.filters.onlyNotFollowed,
        reasons: Array.from(this.filters.reasons),
      }));
    } catch {
      // ignore
    }
  }

  async init() {
    try {
      const auth = await getAuthStatusCached();
      this.connected = !!auth?.connected;
      if (this.connected) {
        await this.load(true);
      }
    } catch {
      this.connected = false;
    } finally {
      this.render();
    }
  }

  startTimer() {
    if (this._timer) return;
    this._autoFailures = 0;
    this._scheduleNextAuto({ delaySec: this._autoBasePeriodSec });
  }

  stopTimer() {
    if (!this._timer) return;
    clearTimeout(this._timer);
    this._timer = null;
  }

  startClock() {
    if (this._clockTimer) return;
    this._clockTimer = setInterval(() => this.tickClock(), 1000);
    this.tickClock();
  }

  stopClock() {
    if (!this._clockTimer) return;
    clearInterval(this._clockTimer);
    this._clockTimer = null;
  }

  formatCountdown(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  tickClock() {
    const cd = this.shadowRoot?.querySelector?.('[data-refresh-countdown]');
    if (cd) cd.textContent = this.formatCountdown(this._nextAutoAt - Date.now());
    const un = this.shadowRoot?.querySelector?.('[data-unseen]');
    if (un) un.textContent = String(this.unseen || 0);
  }

  notifKey(n) {
    if (n && typeof n === 'object' && n.__group && n.__key) return String(n.__key);
    const a = n?.author || {};
    return [
      n?.uri || '',
      n?.reason || '',
      n?.reasonSubject || '',
      a?.did || '',
      n?.indexedAt || n?.createdAt || ''
    ].join('|');
  }

  labelFor(n) {
    const reason = String(n?.reason || '').trim();

    if (n && typeof n === 'object' && n.__group) {
      const authors = this._authorsFor(n);
      const names = authors
        .map((a) => a?.displayName || (a?.handle ? `@${a.handle}` : '') || a?.did)
        .filter(Boolean);
      const count = names.length;
      const who = (() => {
        if (count <= 0) return 'Someone';
        if (count === 1) return names[0];
        if (count === 2) return `${names[0]} and ${names[1]}`;
        if (count === 3) return `${names[0]}, ${names[1]}, and ${names[2]}`;
        return `${names[0]} and ${count - 1} others`;
      })();

      switch (reason) {
        case 'like': return `${who} liked your post`;
        case 'repost': return `${who} reposted your post`;
        case 'quote': return `${who} quoted your post`;
        default: return `${who} ${reason}`.trim();
      }
    }

    const who = n?.author?.displayName || (n?.author?.handle ? `@${n.author.handle}` : '') || 'Someone';
    switch (reason) {
      case 'like': return `${who} liked your post`;
      case 'reply': return `${who} replied to your post`;
      case 'repost': return `${who} reposted your post`;
      case 'mention': return `${who} mentioned you`;
      case 'quote': return `${who} quoted your post`;
      case 'follow': return `${who} followed you`;
      case 'subscribed':
      case 'subscribed-post': return `New post from ${who}`;
      default: return `${who} ${reason}`.trim();
    }
  }

  _renderNotifRow(n) {
    const a = n?.author || {};
    const when = fmtAge(n?.indexedAt || n?.createdAt || '');
    const whenAbs = (() => { try { return new Date(n?.indexedAt || n?.createdAt || '').toLocaleString(); } catch { return ''; } })();
    const profileUrl = this.profileUrlForDid(a?.did);
    const subjectUrl = atUriToWebPost(n?.reasonSubject) || atUriToWebProfile(n?.reasonSubject);
    const primaryUrl = this.primaryLinkFor(n);

    const rel = this.followMap[a?.did] || {};
    const following = !!rel.following;
    const followsYou = !!rel.followedBy;
    const mutual = following && followsYou;

    const kf = a?.did ? this._kfState(a.did) : null;
    const kfBtn = a?.did ? `
      <button
        class="mini"
        type="button"
        data-action="known-followers-toggle"
        data-did="${esc(a.did)}"
        ${kf?.loading ? 'disabled' : ''}
      >${kf?.open ? 'Hide followers you know' : 'Followers you know'}</button>
    ` : '';

    const followBtn = a?.did ? `
      <button
        class="follow-ind ${following ? 'following' : 'not-following'}"
        type="button"
        data-action="follow-toggle"
        data-did="${esc(a.did)}"
        title="${following ? 'Following (click to unfollow)' : 'Not following (click to follow)'}"
        aria-label="${following ? 'Unfollow' : 'Follow'} ${esc(a.handle || a.did)}"
      ><span class="follow-dot" aria-hidden="true"></span></button>
    ` : '';

    const chips = [
      mutual ? '<span class="chip ok">Mutual</span>' : '',
      (!mutual && following) ? '<span class="chip ok">Following</span>' : '',
      (!mutual && followsYou) ? '<span class="chip">Follows you</span>' : '',
    ].filter(Boolean).join('');

    const unread = this._isUnread(n);
    const seenIso = this._notifTimeIso(n);
    const markBtn = (unread && seenIso) ? `
      <button
        class="mark"
        type="button"
        data-action="mark-read"
        data-seen-at="${esc(seenIso)}"
        title="Mark read (marks everything up to this time)"
        aria-label="Mark read"
      >✓</button>
    ` : '';

    const title = whenAbs ? `${esc(whenAbs)}` : 'Open in bsky.app';

    const groupCount = (n && typeof n === 'object' && n.__group && Array.isArray(n.notifications)) ? n.notifications.length : 0;
    const groupBadge = groupCount >= 2 ? `<span class="chip">${esc(String(groupCount))}</span>` : '';

    const kfWrap = (() => {
      if (!kf || !kf.open) return '';
      if (kf.loading) return '<div class="kfWrap"><div class="kf muted">Loading followers you know…</div></div>';
      if (kf.error) return `<div class="kfWrap"><div class="kf error">${esc(kf.error)}</div></div>`;
      const items = Array.isArray(kf.followers) ? kf.followers : [];
      if (!items.length) return '<div class="kfWrap"><div class="kf muted">No followers you know found.</div></div>';
      const line = this._fmtKnownFollowersLine(items);
      const list = items.slice(0, 8).map((p) => {
        const url = p?.did ? `https://bsky.app/profile/${encodeURIComponent(p.did)}` : (p?.handle ? `https://bsky.app/profile/${encodeURIComponent(p.handle)}` : '');
        const label = p?.displayName || (p?.handle ? `@${p.handle}` : '') || p?.did;
        return `
          <a class="kfItem" href="${esc(url)}" target="_blank" rel="noopener">
            <img class="kfAv" src="${esc(p?.avatar || '')}" alt="" onerror="this.style.display='none'">
            <span class="kfName">${esc(label)}</span>
          </a>
        `;
      }).join('');
      return `
        <div class="kfWrap">
          ${line ? `<div class="kf muted">${esc(line)}</div>` : ''}
          <div class="kfList">${list}</div>
        </div>
      `;
    })();

    return `
      <div class="row ${unread ? 'unread' : ''}" data-k="${esc(this.notifKey(n))}" data-open="${esc(primaryUrl)}" title="${title}">
        <img class="av" src="${esc(a.avatar || '')}" alt="" onerror="this.style.display='none'">
        <div class="txt">
          <div class="line">
            <span class="id">${identityHtml({ did: a.did, handle: a.handle, displayName: a.displayName }, { showHandle: true, showCopyDid: true })}</span>
            <span class="reason">${esc(n.reason || '')}</span>
            ${followBtn}
            ${kfBtn}
            ${markBtn}
            ${groupBadge}
            ${chips}
          </div>
          <div class="sub">
            ${esc(this.labelFor(n))}
            ${when ? ` • ${esc(when)} ago` : ''}
          </div>
          <div class="links">
            ${profileUrl ? `<a class="lnk" href="${esc(profileUrl)}" target="_blank" rel="noopener" title="Open profile">Profile</a>` : ''}
            ${subjectUrl ? `<a class="lnk" href="${esc(subjectUrl)}" target="_blank" rel="noopener" title="Open item">Item</a>` : ''}
          </div>
          ${kfWrap}
        </div>
      </div>`;
  }

  filteredItems() {
    const onlyNotFollowed = this.filters.onlyNotFollowed;
    const items = this.items.filter((n) => {
      if (!this.filters.reasons.has(n.reason)) return false;
      if (!onlyNotFollowed) return true;
      const did = n.author?.did;
      return did && !this.followMap[did]?.following;
    });
    items.sort((a, b) => new Date(b.indexedAt || b.createdAt || 0) - new Date(a.indexedAt || a.createdAt || 0));
    return items;
  }

  profileUrlForDid(did) {
    return did ? `https://bsky.app/profile/${did}` : '';
  }

  primaryLinkFor(n) {
    // Prefer the thing they interacted with; fallback to the actor profile.
    const subject = atUriToWebPost(n.reasonSubject) || atUriToWebPost(n.uri) || atUriToWebProfile(n.reasonSubject);
    return subject || this.profileUrlForDid(n?.author?.did);
  }

  async populateRelationships(dids) {
    const chunks = [];
    for (let i = 0; i < dids.length; i += 25) chunks.push(dids.slice(i, i + 25));

    const map = { ...this.followMap };
    for (const chunk of chunks) {
      try {
        const rel = await call('getRelationships', { actors: chunk });
        (rel.relationships || []).forEach((r) => {
          map[r.did] = {
            following: !!r.following,
            followedBy: !!r.followedBy,
            muted: !!r.muted,
            blocking: !!r.blockedBy || !!r.blocking
          };
        });
      } catch {
        // Fallback: getProfiles viewer flags
        try {
          const prof = await call('getProfiles', { actors: chunk });
          (prof.profiles || []).forEach((p) => {
            const v = p.viewer || {};
            map[p.did] = {
              following: !!v.following,
              followedBy: !!v.followedBy,
              muted: !!v.muted,
              blocking: !!v.blockedBy || !!v.blocking
            };
          });
        } catch {
          /* ignore */
        }
      }
    }

    this.followMap = map;
  }

  async syncRecentThenRefresh(minutes = 2) {
    const mins = Math.max(1, Number(minutes || 2));

    let error = null;

    try {
      if (window.BSKY?.cacheAvailable !== false) {
        await call('cacheSyncRecent', { minutes: mins });
      }
    } catch (e) {
      error = e;
      // If sqlite isn't available, api.js will flip window.BSKY.cacheAvailable=false.
      console.warn('notif bar cacheSyncRecent failed', e);
    }

    await this.refreshRecent(mins);
    return { ok: !error, error };
  }

  async refreshRecent(minutes = 2) {
    if (this.loading || !this.connected) return;

    const mins = Math.max(1, Number(minutes || 2));
    const sinceMs = Date.now() - (mins * 60 * 1000);

    try {
      const reasons = Array.from(this.filters.reasons);

      let batch = [];
      if (window.BSKY?.cacheAvailable !== false) {
        const data = await call('cacheQueryNotifications', {
          hours: 1,
          reasons,
          limit: 200,
          offset: 0,
          newestFirst: true,
        });
        batch = (data.items || data.notifications || []).map(normalizeNotification);
      } else {
        const data = await call('listNotificationsSince', { hours: 1, reasons, pagesMax: 5 });
        batch = (data.notifications || []).map(normalizeNotification);
      }

      if (!batch.length) return;

      const have = new Set(this.items.map((n) => this.notifKey(n)));
      const fresh = [];
      for (const n of batch) {
        const t = new Date(n.indexedAt || n.createdAt || 0).getTime();
        if (!t || Number.isNaN(t) || t < sinceMs) continue;
        const k = this.notifKey(n);
        if (have.has(k)) continue;
        have.add(k);
        fresh.push(n);
      }

      if (!fresh.length) return;

      this.items = [...fresh, ...this.items].slice(0, 500);

      // Track unseen new notifications when the bar is collapsed or user is in Settings.
      if (!this.expanded || this.mode !== 'notifications') {
        this.unseen += fresh.length;
      } else {
        this.unseen = 0;
      }

      const dids = Array.from(new Set(fresh.map((n) => n?.author?.did).filter(Boolean)))
        .filter((did) => !this.followMap[did])
        .slice(0, 75);
      if (dids.length) await this.populateRelationships(dids);

      this.render();
    } catch (e) {
      // Silent; auto refresh shouldn't disrupt the UI.
      console.warn('notif bar refreshRecent failed', e);
    }
  }

  resetPaging() {
    this._page.cacheOffset = 0;
    this._page.cacheLimit = 50;
    this._page.xrpcCursor = null;
    this._page.done = false;
    this._page.loadingMore = false;
  }

  async loadMore() {
    if (!this.connected) return;
    if (!this.expanded) return;
    if (this.loading) return;
    if (this._page.loadingMore) return;
    if (this._page.done) return;

    this._page.loadingMore = true;
    this.render();

    try {
      const reasons = Array.from(this.filters.reasons);

      // Cache-backed paging is offset/limit.
      if (window.BSKY?.cacheAvailable !== false) {
        const nextOffset = this._page.cacheOffset + this._page.cacheLimit;
        const data = await call('cacheQueryNotifications', {
          hours: this.filters.hours,
          reasons,
          limit: this._page.cacheLimit,
          offset: nextOffset,
          newestFirst: true,
        });

        const batch = (data.items || data.notifications || []).map(normalizeNotification);
        if (!batch.length) {
          this._page.done = true;
          return;
        }

        const have = new Set(this.items.map((n) => this.notifKey(n)));
        const merged = [...this.items];
        for (const n of batch) {
          const k = this.notifKey(n);
          if (have.has(k)) continue;
          have.add(k);
          merged.push(n);
        }

        this.items = merged;
        this._page.cacheOffset = nextOffset;

        const dids = Array.from(new Set(batch.map((n) => n?.author?.did).filter(Boolean)))
          .filter((did) => !this.followMap[did])
          .slice(0, 150);
        if (dids.length) await this.populateRelationships(dids);

        return;
      }

      // Fallback paging (no SQLite): use cursor-based listNotifications and client-side filters.
      const cutoff = Date.now() - (Math.max(1, Number(this.filters.hours || 24)) * 60 * 60 * 1000);
      const out = [];
      let cursor = this._page.xrpcCursor;

      // Grab a few pages per "load more" to keep it responsive.
      for (let i = 0; i < 5; i++) {
        const data = await call('listNotifications', { limit: 50, cursor });
        const batch = (data.notifications || []).map(normalizeNotification);
        cursor = data.cursor || null;
        if (!batch.length) {
          cursor = null;
        }

        for (const n of batch) {
          const ts = new Date(n.indexedAt || n.createdAt || 0).getTime();
          if (ts && ts < cutoff) {
            cursor = null;
            break;
          }
          if (reasons.length && !reasons.includes(n.reason)) continue;
          out.push(n);
        }

        if (!cursor) break;
      }

      if (!out.length) {
        this._page.done = true;
        this._page.xrpcCursor = cursor;
        return;
      }

      const have = new Set(this.items.map((n) => this.notifKey(n)));
      const merged = [...this.items];
      for (const n of out) {
        const k = this.notifKey(n);
        if (have.has(k)) continue;
        have.add(k);
        merged.push(n);
      }
      this.items = merged;
      this._page.xrpcCursor = cursor;
      if (!cursor) this._page.done = true;

      const dids = Array.from(new Set(out.map((n) => n?.author?.did).filter(Boolean)))
        .filter((did) => !this.followMap[did])
        .slice(0, 150);
      if (dids.length) await this.populateRelationships(dids);
    } catch (e) {
      console.warn('notif bar loadMore failed', e);
    } finally {
      this._page.loadingMore = false;
      this.render();
    }
  }

  async load(reset = false) {
    if (this.loading) return;

    this.loading = true;
    if (reset) this.items = [];
    this.render();

    try {
      const auth = await getAuthStatusCached();
      this.connected = !!auth?.connected;
      if (!this.connected) {
        this.items = [];
        this.error = null;
        return;
      }

      const reasons = Array.from(this.filters.reasons);
      let items = [];

      this.resetPaging();

      if (window.BSKY?.cacheAvailable !== false) {
        let data = await call('cacheQueryNotifications', {
          hours: this.filters.hours,
          reasons,
          limit: 250,
          offset: 0,
          newestFirst: true,
        });

        const firstBatch = (data.items || data.notifications || []).map(normalizeNotification);
        if (reset && firstBatch.length === 0) {
          await call('cacheSyncRecent', { minutes: 60 });
          data = await call('cacheQueryNotifications', {
            hours: this.filters.hours,
            reasons,
            limit: 250,
            offset: 0,
            newestFirst: true,
          });
        }

        items = (data.items || data.notifications || []).map(normalizeNotification);
        this._page.cacheOffset = 0;
        this._page.done = items.length < this._page.cacheLimit;
      } else {
        // Cursor-based initial load for better paging.
        const cutoff = Date.now() - (Math.max(1, Number(this.filters.hours || 24)) * 60 * 60 * 1000);
        let cursor = null;
        const out = [];
        for (let i = 0; i < 6; i++) {
          const data = await call('listNotifications', { limit: 50, cursor });
          const batch = (data.notifications || []).map(normalizeNotification);
          cursor = data.cursor || null;
          if (!batch.length) {
            cursor = null;
          }
          for (const n of batch) {
            const ts = new Date(n.indexedAt || n.createdAt || 0).getTime();
            if (ts && ts < cutoff) {
              cursor = null;
              break;
            }
            if (reasons.length && !reasons.includes(n.reason)) continue;
            out.push(n);
          }
          if (!cursor) break;
          if (out.length >= 200) break;
        }
        items = out.map(normalizeNotification);
        this._page.xrpcCursor = cursor;
        this._page.done = !cursor;
      }

      this.items = items;

      const dids = Array.from(new Set(this.items.map((n) => n?.author?.did).filter(Boolean))).slice(0, 100);
      if (dids.length) await this.populateRelationships(dids);

      this.error = null;
    } catch (e) {
      this.error = isNotConnectedError(e) ? 'Not connected. Use the Connect button.' : (e?.message || String(e));
    } finally {
      this.loading = false;
      this.render();
    }
  }

  onChange(e) {
    if (e.target.id === 'range') {
      this.filters.hours = Number(e.target.value || 24);
      this.saveFilters();
      this.load(true);
      return;
    }
    if (e.target.id === 'only-not-followed') {
      this.filters.onlyNotFollowed = !!e.target.checked;
      this.saveFilters();
      this.render();
      return;
    }

    const reason = e.target?.getAttribute?.('data-reason');
    if (reason) {
      if (e.target.checked) this.filters.reasons.add(reason);
      else this.filters.reasons.delete(reason);
      this.saveFilters();
      this.load(true);
    }

    const pf = e.target?.getAttribute?.('data-profile-file');
    if (pf === 'avatar' || pf === 'banner') {
      const file = e.target?.files?.[0] || null;
      if (!file) return;

      const slot = (pf === 'avatar') ? this._profileEdit.avatar : this._profileEdit.banner;
      slot.file = file;
      slot.mime = String(file.type || '').trim();
      slot.clear = false;

      this._profileEdit.error = null;
      this._profileEdit.status = `Reading ${pf}…`;
      this.render();

      readFileAsDataUrl(file).then((dataUrl) => {
        slot.dataUrl = dataUrl;
        this._profileEdit.status = `Selected ${pf}.`;
        this.render();
      }).catch((err) => {
        slot.file = null;
        slot.dataUrl = '';
        slot.mime = '';
        this._profileEdit.error = err?.message || String(err);
        this._profileEdit.status = null;
        this.render();
      });
    }
  }

  async ensureProfileEditLoaded(force = false) {
    if (!force && this._profileEdit.loaded) return;
    if (this._profileEdit.loading) return;

    this._profileEdit.loading = true;
    this._profileEdit.error = null;
    this._profileEdit.status = 'Loading profile…';
    this.render();

    try {
      const prof = await call('getProfile', { staleMinutes: 0 });
      this._profileEdit.loaded = true;
      this._profileEdit.displayName = String(prof?.displayName || '');
      this._profileEdit.description = String(prof?.description || '');
      this._profileEdit.currentAvatar = String(prof?.avatar || '');
      this._profileEdit.currentBanner = String(prof?.banner || '');
      this._profileEdit.avatar = { file: null, dataUrl: '', mime: '', clear: false };
      this._profileEdit.banner = { file: null, dataUrl: '', mime: '', clear: false };
      this._profileEdit.status = null;
    } catch (e) {
      this._profileEdit.error = e?.message || String(e);
      this._profileEdit.status = null;
    } finally {
      this._profileEdit.loading = false;
      this.render();
    }
  }

  async saveProfileEdits() {
    if (this._profileEdit.saving) return;
    this._profileEdit.saving = true;
    this._profileEdit.error = null;
    this._profileEdit.status = 'Saving…';
    this.render();

    try {
      const dnEl = this.shadowRoot?.querySelector?.('[data-profile-display-name]');
      const descEl = this.shadowRoot?.querySelector?.('[data-profile-description]');

      const displayName = String(dnEl?.value ?? this._profileEdit.displayName ?? '').trim();
      const description = String(descEl?.value ?? this._profileEdit.description ?? '').trim();

      let avatarBlob = null;
      let bannerBlob = null;

      if (this._profileEdit.avatar?.file && this._profileEdit.avatar?.dataUrl) {
        this._profileEdit.status = 'Uploading avatar…';
        this.render();
        const mime = this._profileEdit.avatar.mime || 'image/jpeg';
        const dataBase64 = dataUrlToBase64(this._profileEdit.avatar.dataUrl);
        const up = await call('uploadBlob', { mime, dataBase64, maxBytes: 2 * 1024 * 1024 });
        avatarBlob = up?.blob || up?.data?.blob || null;
        if (!avatarBlob) throw new Error('Avatar upload did not return a blob');
      }

      if (this._profileEdit.banner?.file && this._profileEdit.banner?.dataUrl) {
        this._profileEdit.status = 'Uploading banner…';
        this.render();
        const mime = this._profileEdit.banner.mime || 'image/jpeg';
        const dataBase64 = dataUrlToBase64(this._profileEdit.banner.dataUrl);
        const up = await call('uploadBlob', { mime, dataBase64, maxBytes: 4 * 1024 * 1024 });
        bannerBlob = up?.blob || up?.data?.blob || null;
        if (!bannerBlob) throw new Error('Banner upload did not return a blob');
      }

      this._profileEdit.status = 'Updating profile…';
      this.render();

      const res = await call('profileUpdate', {
        displayName,
        description,
        avatarBlob,
        bannerBlob,
        clearAvatar: !!this._profileEdit.avatar?.clear,
        clearBanner: !!this._profileEdit.banner?.clear,
      });

      const prof = res?.profile || null;
      if (prof) {
        this._profileEdit.displayName = String(prof?.displayName || '');
        this._profileEdit.description = String(prof?.description || '');
        this._profileEdit.currentAvatar = String(prof?.avatar || '');
        this._profileEdit.currentBanner = String(prof?.banner || '');
      }

      this._profileEdit.avatar = { file: null, dataUrl: '', mime: '', clear: false };
      this._profileEdit.banner = { file: null, dataUrl: '', mime: '', clear: false };
      this._profileEdit.status = 'Saved.';

      try {
        window.dispatchEvent(new CustomEvent('bsky-auth-changed', { detail: { connected: true, reason: 'profile-updated' } }));
      } catch {}
    } catch (e) {
      this._profileEdit.error = e?.message || String(e);
      this._profileEdit.status = null;
    } finally {
      this._profileEdit.saving = false;
      this.render();
    }
  }

  _activeReasonPreset() {
    const s = this.filters.reasons;
    const only = (k) => (s.size === 1 && s.has(k));
    if (s.size === REASONS.length && REASONS.every((r) => s.has(r))) return 'all';
    if (only('mention')) return 'mention';
    if (only('reply')) return 'reply';
    if (only('follow')) return 'follow';
    if (only('like')) return 'like';
    if (only('repost')) return 'repost';
    if (only('quote')) return 'quote';
    return 'custom';
  }

  _applyReasonPreset(preset) {
    const p = String(preset || '').trim();
    if (!p) return;
    if (p === 'all') {
      this.filters.reasons = new Set(REASONS);
      this.saveFilters();
      this.load(true);
      return;
    }
    const allowed = new Set(['mention','reply','follow','like','repost','quote']);
    if (!allowed.has(p)) return;
    this.filters.reasons = new Set([p]);
    this.saveFilters();
    this.load(true);
  }

  render() {
    // Hide entirely when not connected.
    if (!this.connected) {
      this.style.display = 'none';
      return;
    }
    this.style.display = 'block';

    if (this.expanded && this.mode === 'notifications') {
      this._listCtl.requestRestore({ anchor: true });
    }
    this._listCtl.beforeRender();

    const items = this.filteredItems();
    const displayItems = this._groupNotificationsForDisplay(items);
    const count = displayItems.length;

    // Unread count within the current filter.
    const unreadCount = items.filter((n) => this._isUnread(n)).length;
    this.unseen = unreadCount;

    const refreshCountdown = this.formatCountdown(this._nextAutoAt - Date.now());

    const slice = this.expanded ? displayItems : displayItems.slice(0, 5);
    let rows = '';
    if (this.expanded && this.mode === 'notifications') {
      this._winCtl.setItems(displayItems);
      rows = this._winCtl.innerHtml({
        loadingHtml: '<div class="muted">Loading…</div>',
        emptyHtml: '<div class="muted">No notifications in this range.</div>',
      });
    } else {
      rows = slice.map((n) => this._renderNotifRow(n)).join('')
        || (this.loading ? '<div class="muted">Loading…</div>' : '<div class="muted">No notifications in this range.</div>');
    }

    const reasonsCount = this.filters.reasons.size;

    const filters = (this.expanded && this.mode === 'notifications') ? `
      <div class="filters">
        <label>Range
          <select id="range">
            <option value="6" ${this.filters.hours === 6 ? 'selected' : ''}>6h</option>
            <option value="24" ${this.filters.hours === 24 ? 'selected' : ''}>24h</option>
            <option value="72" ${this.filters.hours === 72 ? 'selected' : ''}>3d</option>
            <option value="168" ${this.filters.hours === 168 ? 'selected' : ''}>7d</option>
            <option value="720" ${this.filters.hours === 720 ? 'selected' : ''}>30d</option>
          </select>
        </label>
        <label class="only"><input type="checkbox" id="only-not-followed" ${this.filters.onlyNotFollowed ? 'checked' : ''}> Only not-followed</label>

        <div class="quick" role="group" aria-label="Activity filters">
          ${(() => {
            const active = this._activeReasonPreset();
            const btn = (id, label) => `
              <button class="q" type="button" data-action="reason-preset" data-preset="${id}" aria-pressed="${active === id ? 'true' : 'false'}">${label}</button>
            `;
            return [
              btn('all', 'All'),
              btn('mention', 'Mentions'),
              btn('reply', 'Replies'),
              btn('follow', 'Follows'),
              btn('like', 'Likes'),
              btn('repost', 'Reposts'),
              btn('quote', 'Quotes'),
            ].join('');
          })()}
        </div>

        <details class="reasons" ${reasonsCount !== REASONS.length ? 'open' : ''}>
          <summary>Reasons (${reasonsCount}/${REASONS.length})</summary>
          <div class="reasons-grid">
            ${REASONS.map((r) => `
              <label><input type="checkbox" data-reason="${r}" ${this.filters.reasons.has(r) ? 'checked' : ''}> ${r}</label>
            `).join('')}
          </div>
        </details>

        <button class="btn" type="button" data-action="refresh" ${this.loading ? 'disabled' : ''}>Refresh</button>
        <button class="btn" type="button" data-action="mark-all-read" ${(this.loading || this._markSeenBusy || unreadCount === 0) ? 'disabled' : ''}>Mark all read</button>
      </div>
    ` : '';

    const settings = (this.expanded && this.mode === 'settings') ? `
      <div class="settings">
        <div class="tabs" role="tablist" aria-label="Notification settings">
          <button class="tab" type="button" data-action="settings-tab" data-tab="cache" aria-pressed="${this.settingsTab === 'cache' ? 'true' : 'false'}">Cache</button>
          <button class="tab" type="button" data-action="settings-tab" data-tab="db" aria-pressed="${this.settingsTab === 'db' ? 'true' : 'false'}">Database</button>
          <button class="tab" type="button" data-action="settings-tab" data-tab="profile" aria-pressed="${this.settingsTab === 'profile' ? 'true' : 'false'}">Profile</button>
        </div>
        <div class="settings-body">
          ${this.settingsTab === 'cache' ? `
            <div class="settings-actions">
              <button class="btn" type="button" data-action="reset-layout">Reset layout</button>
              <button class="btn" type="button" data-action="open-cache-settings">Cache calendar</button>
            </div>
            <bsky-cache-status data-compact="1"></bsky-cache-status>
          ` : ''}
          ${this.settingsTab === 'db' ? '<bsky-db-manager></bsky-db-manager>' : ''}
          ${this.settingsTab === 'profile' ? (() => {
            const p = this._profileEdit;
            const avatarPrev = p.avatar?.dataUrl || p.currentAvatar || '';
            const bannerPrev = p.banner?.dataUrl || p.currentBanner || '';
            const busy = (p.loading || p.saving);
            return `
              <div class="profile-settings">
                <div class="settings-actions">
                  <button class="btn" type="button" data-action="profile-reload" ${busy ? 'disabled' : ''}>Reload</button>
                  <button class="btn" type="button" data-action="profile-save" ${busy ? 'disabled' : ''}>Save</button>
                </div>
                ${p.status ? `<div class="muted">${esc(p.status)}</div>` : ''}
                ${p.error ? `<div class="error">${esc(p.error)}</div>` : ''}

                <label class="field">
                  <span class="lbl">Display name</span>
                  <input type="text" data-profile-display-name value="${esc(p.displayName)}" placeholder="Display name" ${busy ? 'disabled' : ''} />
                </label>

                <label class="field">
                  <span class="lbl">Bio</span>
                  <textarea data-profile-description rows="4" placeholder="Bio" ${busy ? 'disabled' : ''}>${esc(p.description)}</textarea>
                </label>

                <div class="media-grid">
                  <div class="media">
                    <div class="lblrow">
                      <span class="lbl">Avatar</span>
                      <button class="mini" type="button" data-action="profile-clear-avatar" ${busy ? 'disabled' : ''}>Clear</button>
                    </div>
                    ${avatarPrev ? `<img class="av" src="${esc(avatarPrev)}" alt="" onerror="this.style.display='none'">` : `<div class="ph">No avatar</div>`}
                    <input class="file" type="file" accept="image/*" data-profile-file="avatar" ${busy ? 'disabled' : ''} />
                  </div>
                  <div class="media">
                    <div class="lblrow">
                      <span class="lbl">Banner</span>
                      <button class="mini" type="button" data-action="profile-clear-banner" ${busy ? 'disabled' : ''}>Clear</button>
                    </div>
                    ${bannerPrev ? `<img class="banner" src="${esc(bannerPrev)}" alt="" onerror="this.style.display='none'">` : `<div class="ph">No banner</div>`}
                    <input class="file" type="file" accept="image/*" data-profile-file="banner" ${busy ? 'disabled' : ''} />
                  </div>
                </div>
              </div>
            `;
          })() : ''}
        </div>
      </div>
    ` : '';

    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{
          position:fixed;
          right:12px;
          bottom:12px;
          z-index:9999;
          width:min(420px, calc(100vw - 16px));
          font-family: var(--bsky-font-family, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif);
        }
        .wrap{
          border:1px solid var(--bsky-border, #2b2b2b);
          border-radius: var(--bsky-radius, 0px);
          background:var(--bsky-surface, rgba(10,10,10,.92));
          color:var(--bsky-fg, #fff);
          box-shadow: 0 18px 60px rgba(0,0,0,.6);
          overflow:hidden;
          backdrop-filter: blur(10px);
        }
        .head{
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:10px;
          padding:10px 12px;
          background: var(--bsky-surface-2, rgba(20,20,20,.85));
          border-bottom:1px solid var(--bsky-border, #2b2b2b);
          cursor:pointer;
          user-select:none;
        }
        .title{display:flex;align-items:center;gap:10px;min-width:0}
        .title strong{white-space:nowrap}
        .badge{
          background:#1d2a41;
          border:1px solid #2f4b7a;
          padding:2px 8px;
          border-radius: var(--bsky-radius, 0px);
          font-weight:700;
          font-size:.85rem;
        }
        .badge.new{
          background:#1e2e1e;
          border-color:#2e5a3a;
          color:#89f0a2;
        }
        .pill{
          display:inline-flex;
          align-items:center;
          gap:6px;
          border:1px solid var(--bsky-border, #2b2b2b);
          border-radius: var(--bsky-radius, 0px);
          padding:2px 8px;
          color:var(--bsky-muted-fg, #ddd);
          font-size:.85rem;
          background:rgba(0,0,0,.25);
          white-space:nowrap;
        }
        .meta{color:var(--bsky-muted-fg, #bbb);font-size:.85rem;white-space:nowrap}
        .toggle{
          appearance:none;
          border:1px solid var(--bsky-border-soft, #3a3a3a);
          background:var(--bsky-btn-bg, #111);
          color:var(--bsky-fg, #fff);
          border-radius: var(--bsky-radius, 0px);
          padding:6px 10px;
          cursor:pointer;
          font-weight:700;
        }
        .gear{
          appearance:none;
          border:1px solid var(--bsky-border-soft, #3a3a3a);
          background:transparent;
          color:var(--bsky-fg, #fff);
          border-radius: var(--bsky-radius, 0px);
          padding:6px 10px;
          cursor:pointer;
          font-weight:700;
        }
        .gear:hover{background:#1b1b1b}
        .body{padding:10px 12px;}
        .filters{
          display:flex;
          flex-wrap:wrap;
          gap:10px;
          align-items:center;
          margin-bottom:10px;
        }
        .quick{display:flex;gap:6px;flex-wrap:wrap;width:100%}
        .q{background:var(--bsky-btn-bg, #111);border:1px solid var(--bsky-border, #333);color:var(--bsky-fg, #fff);padding:5px 8px;border-radius: var(--bsky-radius, 0px);cursor:pointer;font-size:.82rem}
        .q[aria-pressed="true"]{background:#1d2a41;border-color:#2f4b7a}
        select{background:var(--bsky-input-bg, #0f0f0f);color:var(--bsky-fg, #fff);border:1px solid var(--bsky-border, #333);border-radius: var(--bsky-radius, 0px);padding:6px 10px}
        .only{color:var(--bsky-muted-fg, #ddd)}
        .btn{background:var(--bsky-btn-bg, #111);border:1px solid var(--bsky-border-soft, #555);color:var(--bsky-fg, #fff);padding:6px 10px;border-radius: var(--bsky-radius, 0px);cursor:pointer}
        .btn:disabled{opacity:.6;cursor:not-allowed}

        .mini{appearance:none;background:transparent;border:1px solid var(--bsky-border-soft, #555);color:var(--bsky-fg, #fff);border-radius: var(--bsky-radius, 0px);padding:4px 8px;cursor:pointer;font-size:.78rem;font-weight:800}
        .mini:hover{background:#1b1b1b}
        .mini:disabled{opacity:.6;cursor:not-allowed}

        details.reasons{border:1px solid var(--bsky-border, #2b2b2b);border-radius: var(--bsky-radius, 0px);padding:6px 8px;max-width:100%}
        details.reasons summary{cursor:pointer;color:var(--bsky-muted-fg, #ddd)}
        .reasons-grid{display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:6px 10px;margin-top:6px;color:var(--bsky-muted-fg, #ddd)}

        .list{display:flex;flex-direction:column;gap:0;max-height:${this.expanded ? '52vh' : '160px'};overflow:auto;padding-right:4px;}
        .row{display:flex;gap:10px;align-items:flex-start;padding:2px;border:1px solid var(--bsky-border, #2b2b2b);border-radius: var(--bsky-radius, 0px);background:var(--bsky-input-bg, #0f0f0f);cursor:pointer}
        .row.unread{border-color:#2f4b7a;background:rgba(29,42,65,.35)}
        /* Lightweight “windowing”: skip rendering offscreen entries (big perf win on long lists). */
        .row{content-visibility:auto;contain-intrinsic-size:350px 84px}
        .row:hover{border-color:var(--bsky-border-soft, #3a3a3a);background:var(--bsky-btn-bg, #121212)}
        .av{width:28px;height:28px;border-radius: var(--bsky-radius, 0px);background:var(--bsky-surface-2, #222);object-fit:cover;flex:0 0 auto}
        .txt{min-width:0;flex:1 1 auto}
        .line{font-weight:800;line-height:1.2;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
        .id{min-width:0;max-width:100%}
        .reason{color:#9cd3ff;font-weight:800;text-transform:uppercase;font-size:.75rem;letter-spacing:.06em}
        .sub{color:var(--bsky-muted-fg, #bbb);font-size:.85rem;line-height:1.2;margin-top:2px}
        .links{display:flex;gap:10px;margin-top:4px}
        .lnk{color:#9cd3ff;text-decoration:none;font-size:.85rem}
        .lnk:hover{text-decoration:underline}

        .kfWrap{margin-top:6px;padding-left:8px;border-left:2px solid #2f4b7a}
        .kf{font-size:.85rem;line-height:1.2}
        .kfList{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
        .kfItem{display:inline-flex;align-items:center;gap:6px;max-width:100%;border:1px solid var(--bsky-border, #333);border-radius: var(--bsky-radius, 0px);padding:4px 6px;background:rgba(0,0,0,.15);color:var(--bsky-fg, #fff);text-decoration:none}
        .kfItem:hover{background:rgba(0,0,0,.25);border-color:var(--bsky-border-soft, #3a3a3a)}
        .kfAv{width:18px;height:18px;border-radius: var(--bsky-radius, 0px);object-fit:cover;background:var(--bsky-surface-2, #222)}
        .kfName{font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
        .chip{background:#1d2a41;color:#cfe5ff;border:1px solid #2f4b7a;border-radius: var(--bsky-radius, 0px);padding:1px 6px;font-size:.72rem;font-weight:800}
        .chip.ok{background:#1e2e1e;color:#89f0a2;border-color:#2e5a3a}

        .mark{
          appearance:none;
          border:1px solid #2f4b7a;
          background:rgba(29,42,65,.35);
          color:#cfe5ff;
          border-radius: var(--bsky-radius, 0px);
          width:22px;
          height:22px;
          padding:0;
          cursor:pointer;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          font-weight:900;
        }
        .mark:hover{background:rgba(29,42,65,.55)}
        .mark:disabled{opacity:.6;cursor:not-allowed}

        .follow-ind{
          appearance:none;
          border:1px solid transparent;
          background:transparent;
          border-radius: var(--bsky-radius, 0px);
          width:22px;
          height:22px;
          padding:0;
          cursor:pointer;
          display:inline-flex;
          align-items:center;
          justify-content:center;
        }
        .follow-dot{width:12px;height:12px;border-radius: var(--bsky-radius, 0px);display:block;}
        .follow-ind.not-following{border-color:#5a1f1f}
        .follow-ind.not-following .follow-dot{background:transparent;border:2px solid #ff9a9a}
        .follow-ind.not-following:hover{background:#1a0f0f}
        .follow-ind.following{border-color:#1f5a2a}
        .follow-ind.following .follow-dot{background:#89f0a2;border:2px solid #89f0a2}
        .follow-ind.following:hover{background:#0f1a12}
        .muted{color:var(--bsky-muted-fg, #aaa);font-size:.9rem}
        .error{color:var(--bsky-danger-fg, #f88);margin-top:8px}

        .settings .tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
        .settings .tab{appearance:none;background:var(--bsky-btn-bg, #111);color:var(--bsky-fg, #fff);border:1px solid var(--bsky-border, #333);border-radius: var(--bsky-radius, 0px);padding:8px 12px;cursor:pointer;font-weight:700}
        .settings .tab[aria-pressed="true"]{background:#1d2a41;border-color:#2f4b7a}
        .settings-actions{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px 0}
        .settings-actions .btn{appearance:none;background:var(--bsky-btn-bg, #111);border:1px solid var(--bsky-border-soft, #555);color:var(--bsky-fg, #fff);padding:8px 10px;border-radius: var(--bsky-radius, 0px);cursor:pointer}
        .settings-actions .btn:hover{background:#1b1b1b}
        .settings-body{max-height:52vh;overflow:auto;padding-right:4px}

        .profile-settings{display:flex;flex-direction:column;gap:10px}
        .profile-settings .field{display:flex;flex-direction:column;gap:6px}
        .profile-settings .lbl{color:var(--bsky-muted-fg, #bbb);font-weight:700;font-size:.9rem}
        .profile-settings input[type="text"], .profile-settings textarea{width:100%;background:var(--bsky-input-bg, #0f0f0f);color:var(--bsky-fg, #fff);border:1px solid var(--bsky-border, #333);border-radius: var(--bsky-radius, 0px);padding:8px 10px;font:inherit}
        .profile-settings textarea{resize:vertical;min-height:92px}
        .media-grid{display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:10px}
        .media{border:1px solid var(--bsky-border, #333);border-radius: var(--bsky-radius, 0px);padding:10px;background:var(--bsky-input-bg, #0f0f0f);display:flex;flex-direction:column;gap:8px}
        .media .lblrow{display:flex;align-items:center;justify-content:space-between;gap:10px}
        .media .mini{appearance:none;background:transparent;border:1px solid var(--bsky-border-soft, #555);color:var(--bsky-fg, #fff);border-radius: var(--bsky-radius, 0px);padding:4px 8px;cursor:pointer}
        .media .mini:hover{background:#1b1b1b}
        .media .mini:disabled{opacity:.6;cursor:not-allowed}
        .media .av{width:72px;height:72px;border-radius: var(--bsky-radius, 0px);object-fit:cover;background:#222}
        .media .banner{width:100%;height:72px;border-radius: var(--bsky-radius, 0px);object-fit:cover;background:#222}
        .media .ph{color:var(--bsky-muted-fg, #aaa);border:1px dashed rgba(255,255,255,.18);border-radius: var(--bsky-radius, 0px);padding:10px;text-align:center}
        .media .file{color:var(--bsky-muted-fg, #bbb)}
        @media (max-width: 520px){
          .media-grid{grid-template-columns:1fr}
        }

        @media (max-width: 380px){
          :host{right:8px;bottom:8px;width:calc(100vw - 16px)}
          .title{flex-wrap:wrap}
          .meta{display:none}
          .pill{font-size:.8rem}
        }

        ${identityCss}

        .win-spacer{width:100%;pointer-events:none;contain:layout size style}

        @media (prefers-reduced-motion: reduce){
          *{scroll-behavior:auto}
        }
      </style>

      <div class="wrap">
        <div class="head" data-action="toggle" role="button" aria-expanded="${this.expanded ? 'true' : 'false'}" tabindex="0">
          <div class="title">
            <strong>${this.mode === 'settings' ? 'Settings' : 'Notifications'}</strong>
            <span class="badge new" title="Unread notifications"><span data-unseen>${this.unseen || 0}</span></span>
            <span class="badge" title="Total in current filter">${count}</span>
          </div>
          <span class="pill" title="Next auto refresh">⟳ <span data-refresh-countdown>${esc(refreshCountdown)}</span></span>
          <button class="gear" type="button" data-action="settings" title="${this.mode === 'settings' ? 'Back to notifications' : 'Open settings'}">⚙</button>
          <button class="toggle" type="button" data-action="toggle">${this.expanded ? '▾' : '▴'}</button>
        </div>

        <div class="body" ${this.expanded ? '' : 'hidden'}>
          ${this.mode === 'notifications' ? filters : ''}
          ${this.mode === 'settings' ? settings : ''}
          ${this.mode === 'notifications' ? `
            <div class="list" data-list>
              <div class="rows" data-win>
                ${rows}
              </div>
              ${renderListEndcap({
                loading: this.loading,
                loadingMore: this._page.loadingMore,
                hasMore: !this._page.done,
                count: items.length,
              })}
            </div>
          ` : ''}
          ${this.error ? `<div class="error">Error: ${esc(this.error)}</div>` : ''}
        </div>
      </div>
    `;

    this._winCtl.afterRender();
    this._listCtl.afterRender();
  }

  onClick(e) {
    if (e.target && e.target.closest && e.target.closest('a')) return;

    const act = e.target?.getAttribute?.('data-action') || e.target?.closest?.('[data-action]')?.getAttribute?.('data-action');

		if (act === 'follow-toggle') {
			e.preventDefault();
			e.stopPropagation();
			const did = e.target?.getAttribute?.('data-did') || e.target?.closest?.('[data-did]')?.getAttribute?.('data-did');
			this.toggleFollow(did);
			return;
		}

    if (act === 'known-followers-toggle') {
      e.preventDefault();
      e.stopPropagation();
      const did = e.target?.getAttribute?.('data-did') || e.target?.closest?.('[data-did]')?.getAttribute?.('data-did');
      this._toggleKnownFollowers(did);
      return;
    }

    if (act === 'mark-all-read') {
      e.preventDefault();
      e.stopPropagation();
      this.markAllRead();
      return;
    }

    if (act === 'mark-read') {
      e.preventDefault();
      e.stopPropagation();
      const iso = e.target?.getAttribute?.('data-seen-at') || e.target?.closest?.('[data-seen-at]')?.getAttribute?.('data-seen-at');
      this.markReadThrough(iso);
      return;
    }

    if (act === 'reason-preset') {
      e.preventDefault();
      e.stopPropagation();
      const preset = e.target?.getAttribute?.('data-preset') || e.target?.closest?.('[data-preset]')?.getAttribute?.('data-preset');
      this._applyReasonPreset(preset);
      return;
    }

    if (act === 'toggle') {
      this.setExpanded(!this.expanded);
      return;
    }
    if (act === 'settings') {
      this.mode = (this.mode === 'settings') ? 'notifications' : 'settings';
      this.setExpanded(true);
      this.render();
      return;
    }
    if (act === 'settings-tab') {
      const tab = e.target?.getAttribute?.('data-tab') || e.target?.closest?.('[data-tab]')?.getAttribute?.('data-tab');
      if (tab) {
        this.settingsTab = tab;
        if (tab === 'profile') {
          this.ensureProfileEditLoaded(false);
        }
        this.render();
      }
      return;
    }

    if (act === 'profile-reload') {
      e.preventDefault();
      e.stopPropagation();
      this.ensureProfileEditLoaded(true);
      return;
    }

    if (act === 'profile-save') {
      e.preventDefault();
      e.stopPropagation();
      this.saveProfileEdits();
      return;
    }

    if (act === 'profile-clear-avatar') {
      e.preventDefault();
      e.stopPropagation();
      this._profileEdit.avatar = { file: null, dataUrl: '', mime: '', clear: true };
      this._profileEdit.status = 'Avatar will be cleared on save.';
      this._profileEdit.error = null;
      this.render();
      return;
    }

    if (act === 'profile-clear-banner') {
      e.preventDefault();
      e.stopPropagation();
      this._profileEdit.banner = { file: null, dataUrl: '', mime: '', clear: true };
      this._profileEdit.status = 'Banner will be cleared on save.';
      this._profileEdit.error = null;
      this.render();
      return;
    }

    if (act === 'reset-layout') {
      try {
        const ok = window.confirm('Reset panel layout?');
        if (!ok) return;
      } catch {
        // ignore
      }
      try {
        window.dispatchEvent(new CustomEvent('bsky-reset-layout'));
      } catch {
        // ignore
      }
      return;
    }

    if (act === 'open-cache-settings') {
      try {
        window.dispatchEvent(new CustomEvent('bsky-open-cache-settings', { detail: { tab: 'calendar' } }));
      } catch {
        // ignore
      }
      return;
    }

    // Existing click handling.
    const row = e.target?.closest?.('[data-open]');
    if (row) {
      const url = row.getAttribute('data-open');
      if (url) window.open(url, '_blank', 'noopener');
      return;
    }

    if (act === 'refresh') {
      this.load(true);
      return;
    }
  }
}

customElements.define('bsky-notification-bar', BskyNotificationBar);
