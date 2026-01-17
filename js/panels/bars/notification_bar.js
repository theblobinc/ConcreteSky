import { call } from '../../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../../auth_state.js';
import { identityCss, identityHtml, bindCopyClicks } from '../../lib/identity.js';
import { bindInfiniteScroll, captureScrollAnchor, applyScrollAnchor } from '../panel_api.js';

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

    this._page = {
      cacheOffset: 0,
      cacheLimit: 50,
      xrpcCursor: null,
      done: false,
      loadingMore: false,
    };

    this._timer = null;
    this._autoPeriodSec = 60;
    this._lookbackMinutes = 2;

    this._nextAutoAt = Date.now() + (this._autoPeriodSec * 1000);
    this._clockTimer = null;

    this._unbindListScroll = null;
    this._listScrollEl = null;
    this._restoreListScrollNext = false;
    this._listAnchor = null;
    this._listScrollTop = 0;

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
    this.stopTimer();
    this.stopClock();
    if (this._unbindListScroll) { try { this._unbindListScroll(); } catch {} this._unbindListScroll = null; }
    this._listScrollEl = null;
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
    this._nextAutoAt = Date.now() + (this._autoPeriodSec * 1000);
    this._timer = setInterval(() => {
      if (!this.connected) return;
      this.syncRecentThenRefresh(this._lookbackMinutes);
      this._nextAutoAt = Date.now() + (this._autoPeriodSec * 1000);
    }, this._autoPeriodSec * 1000);
  }

  stopTimer() {
    if (!this._timer) return;
    clearInterval(this._timer);
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
    const who = n.author?.displayName || (n.author?.handle ? `@${n.author.handle}` : '') || 'Someone';
    switch (n.reason) {
      case 'like': return `${who} liked your post`;
      case 'reply': return `${who} replied`;
      case 'repost': return `${who} reposted you`;
      case 'mention': return `${who} mentioned you`;
      case 'quote': return `${who} quoted you`;
      case 'follow': return `${who} followed you`;
      case 'subscribed':
      case 'subscribed-post': return `New post from ${who}`;
      default: return `${who} ${n.reason || ''}`.trim();
    }
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

    try {
      if (window.BSKY?.cacheAvailable !== false) {
        await call('cacheSyncRecent', { minutes: mins });
      }
    } catch (e) {
      // If sqlite isn't available, api.js will flip window.BSKY.cacheAvailable=false.
      console.warn('notif bar cacheSyncRecent failed', e);
    }

    await this.refreshRecent(mins);
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
  }

  render() {
    // Hide entirely when not connected.
    if (!this.connected) {
      this.style.display = 'none';
      return;
    }
    this.style.display = 'block';

    // Preserve list scroll position across re-renders when expanded.
    try {
      const prevList = this.shadowRoot?.querySelector?.('[data-list]');
      if (prevList && this.expanded && this.mode === 'notifications') {
        this._listScrollTop = prevList.scrollTop || 0;
        this._listAnchor = captureScrollAnchor({
          scroller: prevList,
          root: this.shadowRoot,
          itemSelector: '.row[data-k]',
          keyAttr: 'data-k',
        });
        this._restoreListScrollNext = true;
      } else {
        this._restoreListScrollNext = false;
        this._listAnchor = null;
      }
    } catch {
      // ignore
    }

    const items = this.filteredItems();
    const count = items.length;

    const refreshCountdown = this.formatCountdown(this._nextAutoAt - Date.now());

    const slice = this.expanded ? items : items.slice(0, 5);
    const rows = slice.map((n) => {
      const a = n.author || {};
      const when = fmtAge(n.indexedAt || n.createdAt || '');
      const whenAbs = (() => { try { return new Date(n.indexedAt || n.createdAt || '').toLocaleString(); } catch { return ''; } })();
      const profileUrl = this.profileUrlForDid(a.did);
      const subjectUrl = atUriToWebPost(n.reasonSubject) || atUriToWebProfile(n.reasonSubject);
      const primaryUrl = this.primaryLinkFor(n);

      const rel = this.followMap[a.did] || {};
      const following = !!rel.following;
      const followsYou = !!rel.followedBy;
      const mutual = following && followsYou;

    const followBtn = a.did ? `
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

      const title = whenAbs ? `${esc(whenAbs)}` : 'Open in bsky.app';

      return `
        <div class="row" data-k="${esc(this.notifKey(n))}" data-open="${esc(primaryUrl)}" title="${title}">
          <img class="av" src="${esc(a.avatar || '')}" alt="" onerror="this.style.display='none'">
          <div class="txt">
            <div class="line">
              <span class="id">${identityHtml({ did: a.did, handle: a.handle, displayName: a.displayName }, { showHandle: true, showCopyDid: true })}</span>
              <span class="reason">${esc(n.reason || '')}</span>
              ${followBtn}
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
          </div>
        </div>`;
    }).join('');

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

        <details class="reasons" ${reasonsCount !== REASONS.length ? 'open' : ''}>
          <summary>Reasons (${reasonsCount}/${REASONS.length})</summary>
          <div class="reasons-grid">
            ${REASONS.map((r) => `
              <label><input type="checkbox" data-reason="${r}" ${this.filters.reasons.has(r) ? 'checked' : ''}> ${r}</label>
            `).join('')}
          </div>
        </details>

        <button class="btn" type="button" data-action="refresh" ${this.loading ? 'disabled' : ''}>Refresh</button>
      </div>
    ` : '';

    const settings = (this.expanded && this.mode === 'settings') ? `
      <div class="settings">
        <div class="tabs" role="tablist" aria-label="Notification settings">
          <button class="tab" type="button" data-action="settings-tab" data-tab="cache" aria-pressed="${this.settingsTab === 'cache' ? 'true' : 'false'}">Cache</button>
          <button class="tab" type="button" data-action="settings-tab" data-tab="db" aria-pressed="${this.settingsTab === 'db' ? 'true' : 'false'}">Database</button>
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
          font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        }
        .wrap{
          border:1px solid #2b2b2b;
          border-radius: var(--bsky-radius, 0px);
          background:rgba(10,10,10,.92);
          color:#fff;
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
          background: rgba(20,20,20,.85);
          border-bottom:1px solid #2b2b2b;
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
          border:1px solid #2b2b2b;
          border-radius: var(--bsky-radius, 0px);
          padding:2px 8px;
          color:#ddd;
          font-size:.85rem;
          background:rgba(0,0,0,.25);
          white-space:nowrap;
        }
        .meta{color:#bbb;font-size:.85rem;white-space:nowrap}
        .toggle{
          appearance:none;
          border:1px solid #3a3a3a;
          background:#111;
          color:#fff;
          border-radius: var(--bsky-radius, 0px);
          padding:6px 10px;
          cursor:pointer;
          font-weight:700;
        }
        .gear{
          appearance:none;
          border:1px solid #3a3a3a;
          background:transparent;
          color:#fff;
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
        select{background:#0f0f0f;color:#fff;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:6px 10px}
        .only{color:#ddd}
        .btn{background:#111;border:1px solid #555;color:#fff;padding:6px 10px;border-radius: var(--bsky-radius, 0px);cursor:pointer}
        .btn:disabled{opacity:.6;cursor:not-allowed}

        details.reasons{border:1px solid #2b2b2b;border-radius: var(--bsky-radius, 0px);padding:6px 8px;max-width:100%}
        details.reasons summary{cursor:pointer;color:#ddd}
        .reasons-grid{display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:6px 10px;margin-top:6px;color:#ddd}

        .list{display:flex;flex-direction:column;gap:0;max-height:${this.expanded ? '52vh' : '160px'};overflow:auto;padding-right:4px;}
        .row{display:flex;gap:10px;align-items:flex-start;padding:2px;border:1px solid #2b2b2b;border-radius: var(--bsky-radius, 0px);background:#0f0f0f;cursor:pointer}
        .row:hover{border-color:#3a3a3a;background:#121212}
        .av{width:28px;height:28px;border-radius: var(--bsky-radius, 0px);background:#222;object-fit:cover;flex:0 0 auto}
        .txt{min-width:0;flex:1 1 auto}
        .line{font-weight:800;line-height:1.2;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
        .id{min-width:0;max-width:100%}
        .reason{color:#9cd3ff;font-weight:800;text-transform:uppercase;font-size:.75rem;letter-spacing:.06em}
        .sub{color:#bbb;font-size:.85rem;line-height:1.2;margin-top:2px}
        .links{display:flex;gap:10px;margin-top:4px}
        .lnk{color:#9cd3ff;text-decoration:none;font-size:.85rem}
        .lnk:hover{text-decoration:underline}
        .chip{background:#1d2a41;color:#cfe5ff;border:1px solid #2f4b7a;border-radius: var(--bsky-radius, 0px);padding:1px 6px;font-size:.72rem;font-weight:800}
        .chip.ok{background:#1e2e1e;color:#89f0a2;border-color:#2e5a3a}

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
        .muted{color:#aaa;font-size:.9rem}
        .error{color:#f88;margin-top:8px}

        .settings .tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
        .settings .tab{appearance:none;background:#111;color:#fff;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:8px 12px;cursor:pointer;font-weight:700}
        .settings .tab[aria-pressed="true"]{background:#1d2a41;border-color:#2f4b7a}
        .settings-actions{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px 0}
        .settings-actions .btn{appearance:none;background:#111;border:1px solid #555;color:#fff;padding:8px 10px;border-radius: var(--bsky-radius, 0px);cursor:pointer}
        .settings-actions .btn:hover{background:#1b1b1b}
        .settings-body{max-height:52vh;overflow:auto;padding-right:4px}

        @media (max-width: 380px){
          :host{right:8px;bottom:8px;width:calc(100vw - 16px)}
          .title{flex-wrap:wrap}
          .meta{display:none}
          .pill{font-size:.8rem}
        }

        ${identityCss}

        @media (prefers-reduced-motion: reduce){
          *{scroll-behavior:auto}
        }
      </style>

      <div class="wrap">
        <div class="head" data-action="toggle" role="button" aria-expanded="${this.expanded ? 'true' : 'false'}" tabindex="0">
          <div class="title">
            <strong>${this.mode === 'settings' ? 'Settings' : 'Notifications'}</strong>
            <span class="badge new" title="Unseen notifications"><span data-unseen>${this.unseen || 0}</span></span>
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
              ${rows || (this.loading ? '<div class="muted">Loading…</div>' : '<div class="muted">No notifications in this range.</div>')}
              ${this._page.loadingMore ? '<div class="muted">Loading more…</div>' : ''}
              ${this._page.done && rows ? '<div class="muted">End of list.</div>' : ''}
            </div>
          ` : ''}
          ${this.error ? `<div class="error">Error: ${esc(this.error)}</div>` : ''}
        </div>
      </div>
    `;

    // Restore list scroll anchor after DOM rebuild.
    if (this._restoreListScrollNext) {
      queueMicrotask(() => {
        requestAnimationFrame(() => {
          const list = this.shadowRoot?.querySelector?.('[data-list]');
          if (!list) return;
          if (this._listAnchor) {
            applyScrollAnchor({ scroller: list, root: this.shadowRoot, anchor: this._listAnchor, keyAttr: 'data-k' });
            setTimeout(() => applyScrollAnchor({ scroller: list, root: this.shadowRoot, anchor: this._listAnchor, keyAttr: 'data-k' }), 120);
          } else {
            list.scrollTop = Math.max(0, this._listScrollTop || 0);
          }
          this._restoreListScrollNext = false;
          this._listAnchor = null;
        });
      });
    }

    // Hook infinite scroll (expanded notifications view only), de-duped across renders.
    const list = this.shadowRoot?.querySelector?.('[data-list]');
    if (list && list !== this._listScrollEl) {
      try { this._unbindListScroll?.(); } catch {}
      this._listScrollEl = list;
      this._unbindListScroll = bindInfiniteScroll(list, () => this.loadMore(), {
        threshold: 200,
        enabled: () => this.expanded && this.mode === 'notifications',
        isLoading: () => !!this.loading || !!this._page.loadingMore,
        hasMore: () => !this._page.done,
        cooldownMs: 250,
        anchor: {
          getRoot: () => this.shadowRoot,
          itemSelector: '.row[data-k]',
          keyAttr: 'data-k',
        },
        initialTick: false,
      });
    }
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
        this.render();
      }
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
