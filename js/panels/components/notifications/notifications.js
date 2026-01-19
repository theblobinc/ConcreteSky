import { call } from '../../../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../../../auth_state.js';
import { PanelListController } from '../../../controllers/panel_list_controller.js';
import { syncRecent } from '../../../controllers/cache_sync_controller.js';
import { renderListEndcap } from '../../panel_api.js';
import { BSKY_SEARCH_EVENT } from '../../../search/search_bus.js';
import { SEARCH_TARGETS } from '../../../search/constants.js';
import { compileSearchMatcher } from '../../../search/query.js';
import { queueFollows, startFollowQueueProcessor } from '../../../controllers/follow_queue_controller.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) =>
  ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[m])
);
const fmtTime = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return ''; } };

function normalizeNotification(n) {
  const base = (n && typeof n === 'object') ? n : {};
  const rawAuthor = (base.author && typeof base.author === 'object') ? base.author : {};

  const did = rawAuthor.did || base.authorDid || base.author_did || '';
  const handle = rawAuthor.handle || base.authorHandle || base.author_handle || '';
  const displayName = rawAuthor.displayName || base.authorDisplayName || base.author_display_name || '';
  const avatar = rawAuthor.avatar || base.authorAvatar || base.author_avatar || '';

  // Keep original keys for back-compat; provide the nested shape used by UI.
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

// Convert at://did/app.bsky.feed.post/rkey → https://bsky.app/profile/did/post/rkey
const atUriToWebPost = (uri) => {
  const m = String(uri || '').match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)/);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : '';
};

const REASONS = ['follow','like','reply','repost','mention','quote','subscribed-post','subscribed'];

const atUriDid = (uri) => {
  const m = String(uri || '').match(/^at:\/\/([^/]+)/);
  return m ? m[1] : '';
};

class BskyNotifications extends HTMLElement {
  constructor(){
    super();
    this.attachShadow({mode:'open'});
    this.items = [];
    this.loading = false;
    this.error = null;
    this.view = 'list'; // 'list' | 'masonry'
    this.limit = 100;
    this.offset = 0;
    this.hasMore = false;

    // True windowing (DOM-size reduction): render only a slice of rows plus
    // top/bottom spacers to approximate the full scroll height.
    this._win = {
      enabled: true,
      estimatePx: 72,
      overscanItems: 30,
      minItemsToWindow: 220,
      start: 0,
      end: 0,
    };
    this._winScroller = null;
    this._unbindWinScroll = null;
    this._winScrollRaf = 0;
    this._shownItemsCache = null;
    this._keyToIndex = null;

    this._listCtl = new PanelListController(this, {
      itemSelector: '.n[data-k]',
      keyAttr: 'data-k',
      onLoadMore: () => this.load(false),
      onExhausted: () => this.queueOlderFromServer?.(),
      enabled: () => true,
      isLoading: () => !!this.loading,
      hasMore: () => !!this.hasMore,
      threshold: 220,
      exhaustedCooldownMs: 5000,
      ensureKeyVisible: (key) => this._ensureWindowContainsKey(key),
    });

    this._backfillInFlight = false;
    this._backfillDone = false;

    // followMap[did] = { following:boolean, followedBy:boolean, muted:boolean, blocking:boolean }
    this.followMap = {};
    this.filters = { hours:24, reasons:new Set(REASONS), onlyNotFollowed:false };
    this._bulkState = { running:false, done:0, total:0 };
    this._bulkFollowTargets = null; // Set<string>
    this._onFollowQueueProcessed = null;
    this._onFollowQueueStatus = null;

    this._searchSpec = null;
    this._searchMatcher = null;
    this._onSearchChanged = null;

    this._searchApiTimer = null;
    this._searchApiInFlight = false;
    this._searchApiError = null;
    this._searchApiItems = null;

    this._prefs = {
      open: false,
      loading: false,
      saving: false,
      error: null,
      raw: null,
      priority: null,
    };

    this._markSeenBusy = false;

    // Inline post actions (like/repost) state for notifications referencing posts.
    // postAction[uri] = { cid, liked, reposted, likeCount, repostCount, busyLike, busyRepost }
    this._postAction = new Map();
    this._postViewCache = new Map();
    this._postViewInFlight = new Map();

    this._refreshRecentHandler = (e) => {
      const mins = Number(e?.detail?.minutes ?? 2);
      this.refreshRecent(mins);
    };

    // Keyed by actor DID: { open, loading, error, followers, fetchedAt }
    this._knownFollowers = new Map();
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
    this._scheduleWindowRerender();
    this.render();

    if (!nextOpen) return;
    if (cur.loading) return;
    if (Array.isArray(cur.followers)) return;

    this._setKfState(did, { loading: true, error: '' });
    this._scheduleWindowRerender();
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
      this._scheduleWindowRerender();
      this.render();
    }
  }

  _activeReasonPreset(reasonsSet) {
    const s = (reasonsSet instanceof Set) ? reasonsSet : this.filters.reasons;
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
      this.load(true);
      return;
    }
    const allowed = new Set(['mention','reply','follow','like','repost','quote']);
    if (!allowed.has(p)) return;
    this.filters.reasons = new Set([p]);
    this.load(true);
  }

  async openPrefs() {
    if (this._prefs.open) return;
    this._prefs.open = true;
    this._prefs.error = null;
    this.render();
    if (!this._prefs.raw && !this._prefs.loading) {
      await this.loadPrefs();
    }
  }

  closePrefs() {
    if (!this._prefs.open) return;
    this._prefs.open = false;
    this._prefs.error = null;
    this.render();
  }

  async loadPrefs() {
    if (this._prefs.loading) return;
    this._prefs.loading = true;
    this._prefs.error = null;
    this.render();
    try {
      const res = await call('getNotificationPreferences', {});
      const prefs = res?.preferences || null;
      this._prefs.raw = prefs;
      this._prefs.priority = (prefs && typeof prefs === 'object' && typeof prefs.priority === 'boolean') ? prefs.priority : null;
    } catch (e) {
      this._prefs.error = e?.message || String(e || 'Failed to load preferences');
    } finally {
      this._prefs.loading = false;
      this.render();
    }
  }

  async savePrefs() {
    if (this._prefs.saving) return;
    if (typeof this._prefs.priority !== 'boolean') return;
    this._prefs.saving = true;
    this._prefs.error = null;
    this.render();
    try {
      await call('putNotificationPreferences', { priority: this._prefs.priority });
      this._listCtl.toastError('Saved notification preferences', { kind: 'info', dedupe: false });
      await this.loadPrefs();
    } catch (e) {
      this._prefs.error = e?.message || String(e || 'Failed to save preferences');
      this._listCtl.toastError(this._prefs.error, { kind: 'error', dedupe: false });
    } finally {
      this._prefs.saving = false;
      this.render();
    }
  }

  _isUnread(n) {
    if (!n || typeof n !== 'object') return false;
    if (n.__group && Array.isArray(n.notifications)) {
      return n.notifications.some((x) => this._isUnread(x));
    }
    if (typeof n.isRead === 'boolean') return !n.isRead;
    if (typeof n.isRead === 'number') return n.isRead === 0;
    return false;
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

  _authorsFor(n) {
    if (!n || typeof n !== 'object') return [];
    if (n.__group && Array.isArray(n.authors)) return n.authors.filter(Boolean);
    return [n.author].filter(Boolean);
  }

  _groupKeyFor(n) {
    try {
      const reason = String(n?.reason || '').trim();
      if (!reason) return '';
      // Group only the high-volume, post-centric reasons to avoid weird follow/mention UX.
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
      // Only keep as a group if it actually grouped multiple items.
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

  async markAllRead() {
    if (this._markSeenBusy) return;
    this._markSeenBusy = true;
    this.render();
    try {
      const seenAt = new Date().toISOString();
      await call('updateSeenNotifications', { seenAt });
      try { await syncRecent({ minutes: 60, refreshMinutes: 30, allowDirectFallback: true }); } catch {}
      await this.load(true);
    } catch (e) {
      this._listCtl.toastError(e?.message || String(e || 'Mark all read failed'), { kind: 'error', dedupe: false });
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
      try { await syncRecent({ minutes: 60, refreshMinutes: 30, allowDirectFallback: true }); } catch {}
      await this.load(true);
    } catch (e) {
      this._listCtl.toastError(e?.message || String(e || 'Mark read failed'), { kind: 'error', dedupe: false });
    } finally {
      this._markSeenBusy = false;
      this.render();
    }
  }

  _rerenderAfterAction() {
    try {
      if (String(this.view || 'list') === 'list') this._rerenderWindowOnly({ force: true });
      else this.render();
    } catch {
      this.render();
    }
  }

  async _getPostViewCached(uri) {
    const u = String(uri || '').trim();
    if (!u) return null;
    if (this._postViewCache.has(u)) return this._postViewCache.get(u);
    if (this._postViewInFlight.has(u)) return this._postViewInFlight.get(u);

    const p = (async () => {
      try {
        const res = await call('getPosts', { uris: [u] });
        const post = (res?.posts || [])[0] || null;
        if (post) this._postViewCache.set(u, post);
        return post;
      } catch {
        return null;
      } finally {
        try { this._postViewInFlight.delete(u); } catch {}
      }
    })();

    this._postViewInFlight.set(u, p);
    return p;
  }

  async _ensurePostActionState(uri) {
    const u = String(uri || '').trim();
    if (!u) return null;

    const prev = this._postAction.get(u) || {};
    const hasViewerBits = (typeof prev?.liked === 'boolean') && (typeof prev?.reposted === 'boolean');
    if (prev?.cid && hasViewerBits) return prev;

    const post = await this._getPostViewCached(u);
    if (!post) return prev;

    const next = {
      ...prev,
      cid: String(post?.cid || prev?.cid || ''),
      liked: !!(post?.viewer && post.viewer.like),
      reposted: !!(post?.viewer && post.viewer.repost),
      likeCount: (typeof post?.likeCount === 'number') ? post.likeCount : (prev?.likeCount ?? null),
      repostCount: (typeof post?.repostCount === 'number') ? post.repostCount : (prev?.repostCount ?? null),
    };
    this._postAction.set(u, next);
    return next;
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

  async _backoffIfRateLimited(e, { quiet = false } = {}) {
    if (!this._isRateLimitError(e)) return false;
    const sec = this._retryAfterSeconds(e);
    const waitSec = Number.isFinite(sec) ? Math.min(3600, Math.max(1, sec)) : 10;

    if (!quiet) {
      this.error = `Rate limited. Waiting ${waitSec}s…`;
      this.render();
    }
    await new Promise((r) => setTimeout(r, waitSec * 1000));
    return true;
  }

  connectedCallback(){
    this.render();
    this.load(true);
    this.shadowRoot.addEventListener('change', (e) => this.onChange(e));
    this.shadowRoot.addEventListener('click',  (e) => this.onClick(e));

    this._bindWindowingScroller();
    this._onWinResize = () => this._scheduleWindowRerender();
    window.addEventListener('resize', this._onWinResize);

    window.addEventListener('bsky-refresh-recent', this._refreshRecentHandler);

    this._onKeyDown = (e) => {
      try {
        if (e?.key === 'Escape' && this._prefs?.open) {
          this.closePrefs();
        }
      } catch {
        // ignore
      }
    };
    window.addEventListener('keydown', this._onKeyDown);

    this._onFollowQueueProcessed = (e) => {
      try {
        if (!this._bulkState?.running || !this._bulkFollowTargets) return;
        const out = e?.detail || {};
        const results = out?.results || {};
        Object.keys(results).forEach((did) => {
          if (results[did]?.ok) this.followMap[did] = { ...(this.followMap[did] || {}), following: true, queued: false };
        });
        const done = Array.from(this._bulkFollowTargets).filter((did) => !!this.followMap?.[did]?.following).length;
        this._bulkState.done = done;

        const pending = Number(out?.status?.pending || out?.status?.counts?.pending || 0);
        if (done >= this._bulkState.total || pending === 0) {
          this._bulkState.running = false;
          this._bulkFollowTargets = null;
        }
        this.render();
      } catch {
        // ignore
      }
    };

    this._onFollowQueueStatus = (e) => {
      try {
        if (!this._bulkState?.running) return;
        const st = e?.detail || {};
        const pending = Number(st?.pending || st?.counts?.pending || 0);
        const rateUntil = st?.rateLimitedUntil;
        if (rateUntil && pending > 0) {
          this.error = `Bulk follow queued. Rate limited until ${rateUntil}`;
        }
        if (pending === 0 && this._bulkFollowTargets) {
          const done = Array.from(this._bulkFollowTargets).filter((did) => !!this.followMap?.[did]?.following).length;
          this._bulkState.done = done;
          this._bulkState.running = false;
          this._bulkFollowTargets = null;
        }
        this.render();
      } catch {
        // ignore
      }
    };

    window.addEventListener('bsky-follow-queue-processed', this._onFollowQueueProcessed);
    window.addEventListener('bsky-follow-queue-status', this._onFollowQueueStatus);

    this._likeChangedHandler = (e) => {
      try {
        const uri = String(e?.detail?.uri || '').trim();
        if (!uri) return;
        const prev = this._postAction.get(uri) || {};
        const next = {
          ...prev,
          cid: String(e?.detail?.cid || prev?.cid || ''),
          liked: !!e?.detail?.liked,
        };
        if (typeof e?.detail?.likeCount === 'number') next.likeCount = e.detail.likeCount;
        this._postAction.set(uri, next);
        this._rerenderAfterAction();
      } catch {
        // ignore
      }
    };
    this._repostChangedHandler = (e) => {
      try {
        const uri = String(e?.detail?.uri || '').trim();
        if (!uri) return;
        const prev = this._postAction.get(uri) || {};
        const next = {
          ...prev,
          cid: String(e?.detail?.cid || prev?.cid || ''),
          reposted: !!e?.detail?.reposted,
        };
        if (typeof e?.detail?.repostCount === 'number') next.repostCount = e.detail.repostCount;
        this._postAction.set(uri, next);
        this._rerenderAfterAction();
      } catch {
        // ignore
      }
    };
    window.addEventListener('bsky-like-changed', this._likeChangedHandler);
    window.addEventListener('bsky-repost-changed', this._repostChangedHandler);

    this._authChangedHandler = (e) => {
      const connected = !!e?.detail?.connected;
      if (!connected) {
        this.items = [];
        this.error = 'Bluesky not connected.';
        this.render();
        return;
      }
      this.error = null;
      this.load(true);
    };
    window.addEventListener('bsky-auth-changed', this._authChangedHandler);

    if (!this._onSearchChanged) {
      this._onSearchChanged = (e) => {
        const spec = e?.detail || null;
        const targets = Array.isArray(spec?.targets) ? spec.targets : [];
        const isTargeted = targets.includes(SEARCH_TARGETS.NOTIFICATIONS);

        if (!isTargeted) {
          if (this._searchSpec || this._searchMatcher) {
            this._searchSpec = null;
            this._searchMatcher = null;
            this._searchApiError = null;
            this._searchApiItems = null;
            if (this._searchApiTimer) { try { clearTimeout(this._searchApiTimer); } catch {} this._searchApiTimer = null; }
            this.render();
          }
          return;
        }

        const q = String(spec?.query || '').trim();
        if (q.length < 2) {
          this._searchSpec = null;
          this._searchMatcher = null;
          this._searchApiError = null;
          this._searchApiItems = null;
          if (this._searchApiTimer) { try { clearTimeout(this._searchApiTimer); } catch {} this._searchApiTimer = null; }
          this.render();
          return;
        }

        this._searchSpec = spec;
        try {
          this._searchMatcher = compileSearchMatcher(spec.parsed);
        } catch {
          this._searchMatcher = null;
        }

        // Full-DB search for notifications (cache mode only).
        if (String(spec?.mode || 'cache') === 'cache') {
          if (this._searchApiTimer) { try { clearTimeout(this._searchApiTimer); } catch {} this._searchApiTimer = null; }
          this._searchApiTimer = setTimeout(() => {
            this._searchApiTimer = null;
            this._fetchSearchResultsFromApi(spec);
          }, 250);
        } else {
          this._searchApiError = null;
          this._searchApiItems = null;
        }
        this.render();

          this.mode = 'notifications'; // 'notifications' | 'activity'
          this.activityTab = 'on-my-posts'; // 'on-my-posts' | 'my-actions'
          this._myDid = null;

          this._activity = {
            actions: {
              items: [],
              likeCursor: null,
              repostCursor: null,
              loading: false,
              error: null,
              done: false,
            },
          };
      };
      window.addEventListener(BSKY_SEARCH_EVENT, this._onSearchChanged);
    }
  }

  async loadMyActions(reset = false) {
    const st = this._activity.actions;
    if (st.loading) return;
    if (st.done && !reset) return;

    st.loading = true;
    st.error = null;
    if (reset) {
      st.items = [];
      st.likeCursor = null;
      st.repostCursor = null;
      st.done = false;
    }
    this.render();

    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) throw new Error('Not connected');

      const limit = 50;
      const [likesRes, repostsRes] = await Promise.all([
        call('listMyLikeRecords', { limit, cursor: st.likeCursor }),
        call('listMyRepostRecords', { limit, cursor: st.repostCursor }),
      ]);

      const likes = Array.isArray(likesRes?.records) ? likesRes.records : [];
      const reposts = Array.isArray(repostsRes?.records) ? repostsRes.records : [];
      st.likeCursor = likesRes?.cursor || null;
      st.repostCursor = repostsRes?.cursor || null;

      const out = [];
      for (const r of likes) {
        const v = r?.value || {};
        const subj = v?.subject || {};
        out.push({
          kind: 'like',
          createdAt: String(v?.createdAt || ''),
          subjectUri: String(subj?.uri || ''),
          subjectCid: String(subj?.cid || ''),
          record: r,
        });
      }
      for (const r of reposts) {
        const v = r?.value || {};
        const subj = v?.subject || {};
        out.push({
          kind: 'repost',
          createdAt: String(v?.createdAt || ''),
          subjectUri: String(subj?.uri || ''),
          subjectCid: String(subj?.cid || ''),
          record: r,
        });
      }

      // Sort newest first.
      out.sort((a, b) => (new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()));

      const have = new Set(st.items.map((a) => `${a.kind}|${a.createdAt}|${a.subjectUri}`));
      const fresh = [];
      for (const a of out) {
        const k = `${a.kind}|${a.createdAt}|${a.subjectUri}`;
        if (!a.subjectUri || have.has(k)) continue;
        have.add(k);
        fresh.push(a);
      }
      st.items = [...st.items, ...fresh];

      // Best-effort hydrate post views in batch for display.
      try {
        const uris = Array.from(new Set(fresh.map((a) => a.subjectUri).filter(Boolean)));
        for (let i = 0; i < uris.length; i += 25) {
          const chunk = uris.slice(i, i + 25);
          const res = await call('getPosts', { uris: chunk });
          const posts = Array.isArray(res?.posts) ? res.posts : [];
          for (const p of posts) {
            const u = String(p?.uri || '').trim();
            if (u) this._postViewCache.set(u, p);
          }
        }
      } catch {
        // ignore
      }

      if (!st.likeCursor && !st.repostCursor) {
        st.done = true;
      }
    } catch (e) {
      st.error = e?.message || String(e || 'Failed to load activity');
    } finally {
      st.loading = false;
      this.render();
    }
  }

  _renderMyActionRow(a) {
    const kind = a?.kind === 'repost' ? 'Reposted' : 'Liked';
    const when = fmtTime(a?.createdAt || '');
    const uri = String(a?.subjectUri || '').trim();
    const post = uri ? (this._postViewCache.get(uri) || null) : null;
    const text = String(post?.record?.text || '').trim();
    const author = post?.author || {};
    const who = author?.displayName || author?.handle || author?.did || '';
    const sub = [who ? `by ${who}` : '', when ? `• ${when}` : ''].filter(Boolean).join(' ');
    const excerpt = text ? esc(text.length > 180 ? (text.slice(0, 177) + '…') : text) : '<span class="muted">(post preview unavailable)</span>';

    return `
      <div class="actrow" data-k="${esc(`${kind}|${a?.createdAt || ''}|${uri}`)}">
        <div class="actleft">
          <div class="actkind"><b>${esc(kind)}</b> ${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</div>
          <div class="acttext">${excerpt}</div>
        </div>
        <div class="actright">
          ${uri ? `<button class="mini" type="button" data-open-content data-uri="${esc(uri)}">Open</button>` : ''}
        </div>
      </div>
    `;
  }

  disconnectedCallback(){
    if (this._onWinResize) window.removeEventListener('resize', this._onWinResize);
    this._onWinResize = null;

    try { this._unbindWinScroll?.(); } catch {}
    this._unbindWinScroll = null;
    this._winScroller = null;
    if (this._winScrollRaf) { try { cancelAnimationFrame(this._winScrollRaf); } catch {} this._winScrollRaf = 0; }

    window.removeEventListener('bsky-refresh-recent', this._refreshRecentHandler);
    try { window.removeEventListener('keydown', this._onKeyDown); } catch {}
    if (this._onFollowQueueProcessed) window.removeEventListener('bsky-follow-queue-processed', this._onFollowQueueProcessed);
    if (this._onFollowQueueStatus) window.removeEventListener('bsky-follow-queue-status', this._onFollowQueueStatus);
    if (this._authChangedHandler) window.removeEventListener('bsky-auth-changed', this._authChangedHandler);
    if (this._likeChangedHandler) window.removeEventListener('bsky-like-changed', this._likeChangedHandler);
    if (this._repostChangedHandler) window.removeEventListener('bsky-repost-changed', this._repostChangedHandler);
    this._likeChangedHandler = null;
    this._repostChangedHandler = null;
    if (this._onSearchChanged) {
      try { window.removeEventListener(BSKY_SEARCH_EVENT, this._onSearchChanged); } catch {}
      this._onSearchChanged = null;
    }
    if (this._searchApiTimer) { try { clearTimeout(this._searchApiTimer); } catch {} this._searchApiTimer = null; }

    try { this._listCtl?.disconnect?.(); } catch {}
  }

  _bindWindowingScroller() {
    try {
      const scroller = this._listCtl?.getScroller?.() || null;
      if (!scroller || scroller === this._winScroller) return;

      try { this._unbindWinScroll?.(); } catch {}
      this._winScroller = scroller;

      const onScroll = () => this._scheduleWindowRerender();
      scroller.addEventListener('scroll', onScroll, { passive: true });
      this._unbindWinScroll = () => {
        try { scroller.removeEventListener('scroll', onScroll); } catch {}
      };
    } catch {
      // ignore
    }
  }

  _scheduleWindowRerender() {
    if (!this._win?.enabled) return;
    if (String(this.view || 'list') !== 'list') return;
    if (this._winScrollRaf) return;
    this._winScrollRaf = requestAnimationFrame(() => {
      this._winScrollRaf = 0;
      this._bindWindowingScroller();
      this._rerenderWindowOnly();
    });
  }

  _computeWindow(total) {
    try {
      if (!this._win?.enabled) return { start: 0, end: total, topPx: 0, bottomPx: 0, windowed: false };
      if (!Number.isFinite(total) || total <= 0) return { start: 0, end: 0, topPx: 0, bottomPx: 0, windowed: false };

      const view = String(this.view || 'list');
      if (view !== 'list') return { start: 0, end: total, topPx: 0, bottomPx: 0, windowed: false };

      const min = Number(this._win.minItemsToWindow || 0);
      if (total < min) return { start: 0, end: total, topPx: 0, bottomPx: 0, windowed: false };

      const est = Math.max(28, Number(this._win.estimatePx || 72));
      const overscan = Math.max(10, Number(this._win.overscanItems || 30));

      const scroller = this._winScroller || this._listCtl?.getScroller?.() || null;
      const st = Math.max(0, Number(scroller?.scrollTop || 0));
      const vh = Math.max(200, Number(scroller?.clientHeight || 800));

      const approxFirst = Math.floor(st / est);
      let start = Math.max(0, approxFirst - overscan);
      const want = Math.ceil(vh / est) + (overscan * 2);
      let end = Math.min(total, start + Math.max(50, want));

      const maxRender = Math.max(120, overscan * 8);
      if ((end - start) > maxRender) end = Math.min(total, start + maxRender);
      if (end <= start) {
        start = Math.max(0, total - Math.min(total, maxRender));
        end = total;
      }

      const topPx = start * est;
      const bottomPx = Math.max(0, (total - end) * est);

      this._win.start = start;
      this._win.end = end;

      return { start, end, topPx, bottomPx, windowed: true };
    } catch {
      return { start: 0, end: total, topPx: 0, bottomPx: 0, windowed: false };
    }
  }

  _ensureWindowContainsKey(key) {
    try {
      const k = String(key || '').trim();
      if (!k) return;
      if (!this._win?.enabled) return;
      const items = Array.isArray(this._shownItemsCache) ? this._shownItemsCache : null;
      if (!items || !items.length) return;

      const idx = this._keyToIndex?.get?.(k);
      if (!Number.isFinite(idx) || idx < 0) return;

      const total = items.length;
      const start = Number(this._win.start || 0);
      const end = Number(this._win.end || 0);
      if (idx >= start && idx < end) return;

      const overscan = Math.max(10, Number(this._win.overscanItems || 30));
      const maxRender = Math.max(120, overscan * 8);

      let newStart = Math.max(0, idx - overscan);
      let newEnd = Math.min(total, newStart + maxRender);
      if (newEnd - newStart < maxRender) newStart = Math.max(0, newEnd - maxRender);

      this._win.start = newStart;
      this._win.end = newEnd;

      this._rerenderWindowOnly({ force: true });
    } catch {
      // ignore
    }
  }

  _renderRow(n) {
    const a = n.author || {};
    const t = fmtTime(n.indexedAt || n.createdAt || '');
    const rel = this.followMap[a.did] || {};
    const following = !!rel.following;
    const followsYou = !!rel.followedBy;
    const queued = !!rel.queued;
    const open = atUriToWebPost(n.reasonSubject);
    const canView = !!open && String(n.reasonSubject || '').startsWith('at://');
    const cta = a.did && !following && !queued
      ? `<button class="follow-btn" data-follow-did="${esc(a.did)}">${followsYou ? 'Follow back' : 'Follow'}</button>`
      : queued
        ? `<span class="following-badge">Queued</span>`
        : `<span class="following-badge" ${following?'':'style="display:none"'}>${followsYou ? 'Mutuals' : 'Following'}</span>`;

    const postUri = String(n.reasonSubject || '').trim();
    const hasPost = !!(canView && postUri);

    const st = hasPost ? (this._postAction.get(postUri) || {}) : null;
    const liked = !!st?.liked;
    const reposted = !!st?.reposted;
    const busyLike = !!st?.busyLike;
    const busyRepost = !!st?.busyRepost;

    const likeBtn = hasPost && ['like','repost','reply','mention','quote','subscribed-post','subscribed'].includes(String(n.reason || ''))
      ? `<button class="mini" type="button" data-like-uri="${esc(postUri)}" data-liked="${liked ? '1' : '0'}" ${busyLike ? 'disabled' : ''}>${liked ? 'Unlike' : 'Like'}</button>`
      : '';

    const repostBtn = hasPost && ['like','repost','reply','mention','quote','subscribed-post','subscribed'].includes(String(n.reason || ''))
      ? `<button class="mini" type="button" data-repost-uri="${esc(postUri)}" data-reposted="${reposted ? '1' : '0'}" ${busyRepost ? 'disabled' : ''}>${reposted ? 'Undo repost' : 'Repost'}</button>`
      : '';

    const viewBtn = hasPost
      ? `<button class="view-btn" type="button" data-open-content data-uri="${esc(postUri)}">View</button>`
      : '';

    const unread = this._isUnread(n);
    const seenIso = unread ? this._notifTimeIso(n) : '';
    const markBtn = (unread && seenIso)
      ? `<button class="mini" type="button" data-mark-read="1" data-seen-at="${esc(seenIso)}" ${this._markSeenBusy ? 'disabled' : ''}>Mark read</button>`
      : '';

    const did = String(a.did || '').trim();
    const kf = did ? this._kfState(did) : null;
    const kfBtn = did
      ? `<button class="mini" type="button" data-known-followers="${esc(did)}" ${kf?.loading ? 'disabled' : ''}>${kf?.open ? 'Hide followers you know' : 'Followers you know'}</button>`
      : '';

    const kfBody = (kf && kf.open) ? (() => {
      if (kf.loading) return '<div class="kf muted">Loading followers you know…</div>';
      if (kf.error) return `<div class="kf err">${esc(kf.error)}</div>`;
      const items = Array.isArray(kf.followers) ? kf.followers : [];
      if (!items.length) return '<div class="kf muted">No followers you know found.</div>';
      const line = this._fmtKnownFollowersLine(items);
      const rows = items.slice(0, 8).map((p) => {
        const url = p.did ? `https://bsky.app/profile/${encodeURIComponent(p.did)}` : (p.handle ? `https://bsky.app/profile/${encodeURIComponent(p.handle)}` : '');
        const title = p.displayName || (p.handle ? `@${p.handle}` : '') || p.did;
        const sub = p.handle ? `@${p.handle}` : p.did;
        return `
          <div class="kfItem">
            ${p.avatar ? `<img class="kfAv" src="${esc(p.avatar)}" alt="" loading="lazy" />` : `<div class="kfAv ph"></div>`}
            <div class="kfMeta">
              <div class="kfTitle">${esc(title)}</div>
              <div class="kfSub muted">${esc(sub)}</div>
            </div>
            ${url ? `<a class="open" href="${esc(url)}" target="_blank" rel="noopener">Open</a>` : ''}
          </div>
        `;
      }).join('');
      return `
        ${line ? `<div class="kfLine muted">${esc(line)}</div>` : ''}
        <div class="kfList">${rows}</div>
      `;
    })() : '';

    return `<div class="n" data-k="${esc(this.notifKey(n))}">
      <img class="av" src="${esc(a.avatar || '')}" alt="" onerror="this.style.display='none'">
      <div class="txt">
        <div class="line">${esc(this.labelFor(n))} ${followsYou ? '<span class="chip">Follows you</span>' : ''}</div>
        <div class="sub">@${esc(a.handle || '')} • ${esc(t)}${open ? ` • <a class="open" href="${esc(open)}" target="_blank" rel="noopener">Open</a>` : ''}</div>
        ${kf && kf.open ? `<div class="kfWrap">${kfBody}</div>` : ''}
      </div>
      <div class="act">${markBtn}${likeBtn}${repostBtn}${viewBtn}${kfBtn}${cta}</div>
    </div>`;
  }

  _windowedListInnerHtml(items, { loading = false } = {}) {
    const total = Array.isArray(items) ? items.length : 0;
    if (!total) {
      return loading ? '<div class="muted">Loading…</div>' : '<div class="muted">No notifications in this range.</div>';
    }

    const w = this._computeWindow(total);
    const slice = w.windowed ? items.slice(w.start, w.end) : items;
    const rows = slice.map((n) => this._renderRow(n)).join('');

    if (!w.windowed) return rows;

    return `
      <div class="win-spacer" aria-hidden="true" style="height:${Math.max(0, Math.round(w.topPx))}px"></div>
      ${rows}
      <div class="win-spacer" aria-hidden="true" style="height:${Math.max(0, Math.round(w.bottomPx))}px"></div>
    `;
  }

  _rerenderWindowOnly({ force = false } = {}) {
    try {
      const items = Array.isArray(this._shownItemsCache) ? this._shownItemsCache : null;
      if (!items) return;
      if (String(this.view || 'list') !== 'list') return;

      const list = this.shadowRoot?.querySelector?.('.list');
      if (!list) return;

      const total = items.length;
      const prevStart = Number(this._win?.start || 0);
      const prevEnd = Number(this._win?.end || 0);
      const w = this._computeWindow(total);
      if (!force && w.windowed && w.start === prevStart && w.end === prevEnd) return;

      list.innerHTML = this._windowedListInnerHtml(items, { loading: !!this.loading });
      this._updateWindowEstimateFromDom();
    } catch {
      // ignore
    }
  }

  _updateWindowEstimateFromDom() {
    try {
      if (!this._win?.enabled) return;
      if (String(this.view || 'list') !== 'list') return;

      const els = Array.from(this.shadowRoot?.querySelectorAll?.('.list .n') || []);
      if (!els.length) return;
      const sample = els.slice(0, 8)
        .map((el) => el.getBoundingClientRect?.().height || 0)
        .filter((h) => Number.isFinite(h) && h > 20);
      if (!sample.length) return;

      const avg = sample.reduce((a, b) => a + b, 0) / sample.length;
      const clamped = Math.max(28, Math.min(180, avg));
      const old = Math.max(28, Number(this._win.estimatePx || 72));
      const next = (old * 0.85) + (clamped * 0.15);
      this._win.estimatePx = Math.max(28, Math.min(180, next));
    } catch {
      // ignore
    }
  }

  async _fetchSearchResultsFromApi(spec) {
    if (this._searchApiInFlight) return;
    if (window.BSKY?.cacheAvailable === false) return;

    const q = String(spec?.query || '').trim();
    if (q.length < 2) return;

    // If the HUD provides an explicit (possibly empty) reasons list, honor it.
    const reasonsFromHud = (() => {
      try {
        const r = spec?.filters?.notifications?.reasons;
        if (Array.isArray(r)) return r.map(String).map(s => s.trim()).filter(Boolean);
      } catch {}
      return null;
    })();

    // Empty selection means "show none".
    if (Array.isArray(reasonsFromHud) && reasonsFromHud.length === 0) {
      this._searchApiError = null;
      this._searchApiItems = [];
      this.render();
      return;
    }

    this._searchApiInFlight = true;
    this._searchApiError = null;
    this.render();

    try {
      const payload = {
        q,
        mode: 'cache',
        targets: ['notifications'],
        limit: 200,
        hours: 24 * 365 * 5,
      };
      if (Array.isArray(reasonsFromHud)) payload.reasons = reasonsFromHud;

      const res = await call('search', payload);
      const items = Array.isArray(res?.results?.notifications) ? res.results.notifications.map(normalizeNotification) : [];
      this._searchApiItems = items;

      const dids = Array.from(new Set(items.map(n => n?.author?.did).filter(Boolean)))
        .filter(did => !this.followMap[did]);
      if (dids.length) {
        await this.populateRelationships(dids);
      }
    } catch (e) {
      this._searchApiError = (e && e.message) ? e.message : String(e || 'Search failed');
      this._searchApiItems = [];
    } finally {
      this._searchApiInFlight = false;
      this.render();
    }
  }

  async queueOlderFromServer(){
    if (this._backfillInFlight) return;
    if (this._backfillDone) return;

    this._backfillInFlight = true;
    try {
      let res;
      for (;;) {
        try {
          res = await call('cacheBackfillNotifications', {
            hours: this.filters.hours,
            // One page per request keeps UI responsive.
            pagesMax: 1,
          });
          break;
        } catch (e) {
          const waited = await this._backoffIfRateLimited(e, { quiet: true });
          if (waited) continue;
          throw e;
        }
      }

      const cursor = String(res?.cursor || '');
      const r = res?.result || {};
      const done = !!r?.done || !cursor;
      const stoppedEarly = !!r?.stoppedEarly;
      const retentionLimited = !!r?.retentionLimited;
      if (done || stoppedEarly || retentionLimited) {
        // If the server can't advance any further, stop trying.
        // (Cache will still be kept warm by periodic syncs.)
        this._backfillDone = true;
      }
    } catch {
      // Silent; next query will reflect whether anything changed.
    } finally {
      this._backfillInFlight = false;
    }
  }

  notifKey(n){
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

  async refreshRecent(minutes=2){
    if (this.loading) return;
    const mins = Math.max(1, Number(minutes || 2));
    const since = Date.now() - (mins * 60 * 1000);

    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) return;

      const reasons = Array.from(this.filters.reasons);
      // DB-first: query cached notifications (cache_status auto-sync keeps DB warm).
      const data = await call('cacheQueryNotifications', {
        hours: 1,
        reasons,
        limit: 200,
        offset: 0,
        newestFirst: true,
      });

      const batch = data.items || data.notifications || [];
      const normalizedBatch = batch.map(normalizeNotification);
      if (!normalizedBatch.length) return;

      const have = new Set(this.items.map(n => this.notifKey(n)));
      const fresh = [];
      for (const n of normalizedBatch) {
        const t = new Date(n.indexedAt || n.createdAt || 0).getTime();
        if (!t || Number.isNaN(t) || t < since) continue;
        const k = this.notifKey(n);
        if (have.has(k)) continue;
        have.add(k);
        fresh.push(n);
      }

      if (fresh.length) {
        this._listCtl.requestRestore({ anchor: true });
        this.items = [...fresh, ...this.items];

        const dids = Array.from(new Set(fresh.map(n => n?.author?.did).filter(Boolean)))
          .filter(did => !this.followMap[did]);
        if (dids.length) {
          await this.populateRelationships(dids);
        }

        this.render();
      }
    } catch (e) {
      // Silent; auto refresh shouldn't disrupt the UI.
      console.warn('notifications refreshRecent failed', e);
    }
  }

  onChange(e){
    if (e.target.id === 'range') {
      this.filters.hours = Number(e.target.value || 24);
      this.load(true);
      return;
    }
    if (e.target.id === 'only-not-followed') {
      this.filters.onlyNotFollowed = !!e.target.checked;
      this.render();
      return;
    }
    const reason = e.target?.getAttribute?.('data-reason');
    if (reason) {
      if (e.target.checked) this.filters.reasons.add(reason);
      else this.filters.reasons.delete(reason);
      this.load(true);
    }

    if (e.target.id === 'view') {
      this.view = String(e.target.value || 'list');
      this.render();
      return;
    }

    if (e.target.id === 'mode') {
      this.mode = String(e.target.value || 'notifications');
      if (this.mode !== 'activity') {
        this.render();
        return;
      }
      // Entering Activity view: preload my-actions if selected.
      if (this.activityTab === 'my-actions') {
        this.loadMyActions(true);
      } else {
        this.render();
      }
      return;
    }
  }

  async onClick(e){
    if (e.target.closest('#reload'))      { this.load(true); return; }
    if (e.target.closest('#follow-all'))  { this.followAll(e.target.closest('#follow-all')); return; }
    if (e.target.closest('#mark-all-read')) { this.markAllRead(); return; }
    if (e.target.closest('#prefs')) { this.openPrefs(); return; }

    const actTab = e.target?.closest?.('[data-activity-tab]');
    if (actTab) {
      const t = String(actTab.getAttribute('data-activity-tab') || '').trim();
      if (t === 'on-my-posts' || t === 'my-actions') {
        this.activityTab = t;
        if (t === 'my-actions') this.loadMyActions(true);
        else this.render();
      }
      return;
    }

    if (e.target.closest('[data-load-more-actions]')) {
      this.loadMyActions(false);
      return;
    }

    const presetBtn = e.target?.closest?.('[data-reason-preset]');
    if (presetBtn) {
      this._applyReasonPreset(presetBtn.getAttribute('data-reason-preset'));
      return;
    }

    const prefsAct = e.target?.getAttribute?.('data-prefs-action') || e.target?.closest?.('[data-prefs-action]')?.getAttribute?.('data-prefs-action');
    if (prefsAct) {
      if (prefsAct === 'close') { this.closePrefs(); return; }
      if (prefsAct === 'reload') { this.loadPrefs(); return; }
      if (prefsAct === 'save') { this.savePrefs(); return; }
    }

    const mark = e.target?.closest?.('[data-mark-read]');
    if (mark) {
      const iso = mark.getAttribute('data-seen-at') || '';
      this.markReadThrough(iso);
      return;
    }
    const openBtn = e.target.closest?.('[data-open-content][data-uri]');
    if (openBtn) {
      const uri = openBtn.getAttribute('data-uri') || '';
      if (uri) {
        this.dispatchEvent(new CustomEvent('bsky-open-content', {
          detail: { uri, cid: '' },
          bubbles: true,
          composed: true,
        }));
      }
      return;
    }
    const followBtn = e.target.closest('[data-follow-did]');
    if (followBtn) { this.followOne(followBtn.getAttribute('data-follow-did'), followBtn); return; }

    const knownBtn = e.target?.closest?.('[data-known-followers]');
    if (knownBtn) {
      const did = String(knownBtn.getAttribute('data-known-followers') || '').trim();
      if (did) this._toggleKnownFollowers(did);
      return;
    }

    const rep = e.target?.closest?.('[data-repost-uri]');
    if (rep) {
      const uri = String(rep.getAttribute('data-repost-uri') || '').trim();
      const hintedReposted = rep.getAttribute('data-reposted') === '1';
      if (!uri) return;

      const prev = this._postAction.get(uri) || {};
      if (prev?.busyRepost) return;
      this._postAction.set(uri, { ...prev, busyRepost: true });
      this._rerenderAfterAction();

      try {
        const st = await this._ensurePostActionState(uri);
        const cid = String(st?.cid || '').trim();
        if (!cid) throw new Error('Missing CID for post');

        const reposted = (typeof st?.reposted === 'boolean') ? st.reposted : hintedReposted;

        await call(reposted ? 'unrepost' : 'repost', { uri, cid });

        const next = {
          ...(this._postAction.get(uri) || {}),
          cid,
          reposted: !reposted,
          busyRepost: false,
        };
        if (typeof next.repostCount === 'number') next.repostCount = reposted ? Math.max(0, next.repostCount - 1) : (next.repostCount + 1);
        this._postAction.set(uri, next);

        this.dispatchEvent(new CustomEvent('bsky-repost-changed', {
          detail: {
            uri,
            cid,
            reposted: !reposted,
            repostCount: (typeof next.repostCount === 'number') ? next.repostCount : null,
          },
          bubbles: true,
          composed: true,
        }));

        try { await syncRecent({ minutes: 5, refreshMinutes: 30, allowDirectFallback: false }); } catch {}
      } catch (err) {
        const msg = err?.message || String(err || 'Repost failed');
        this._listCtl.toastError(msg, { kind: 'error', dedupe: false });
      } finally {
        const cur = this._postAction.get(uri) || {};
        this._postAction.set(uri, { ...cur, busyRepost: false });
        this._rerenderAfterAction();
      }
      return;
    }

    const likeBtn = e.target?.closest?.('[data-like-uri]');
    if (likeBtn) {
      const uri = String(likeBtn.getAttribute('data-like-uri') || '').trim();
      const hintedLiked = likeBtn.getAttribute('data-liked') === '1';
      if (!uri) return;

      const prev = this._postAction.get(uri) || {};
      if (prev?.busyLike) return;
      this._postAction.set(uri, { ...prev, busyLike: true });
      this._rerenderAfterAction();

      try {
        const st = await this._ensurePostActionState(uri);
        const cid = String(st?.cid || '').trim();
        if (!cid) throw new Error('Missing CID for post');

        const liked = (typeof st?.liked === 'boolean') ? st.liked : hintedLiked;

        await call(liked ? 'unlike' : 'like', { uri, cid });

        const next = {
          ...(this._postAction.get(uri) || {}),
          cid,
          liked: !liked,
          busyLike: false,
        };
        if (typeof next.likeCount === 'number') next.likeCount = liked ? Math.max(0, next.likeCount - 1) : (next.likeCount + 1);
        this._postAction.set(uri, next);

        this.dispatchEvent(new CustomEvent('bsky-like-changed', {
          detail: {
            uri,
            cid,
            liked: !liked,
            likeCount: (typeof next.likeCount === 'number') ? next.likeCount : null,
          },
          bubbles: true,
          composed: true,
        }));

        try { await syncRecent({ minutes: 5, refreshMinutes: 30, allowDirectFallback: false }); } catch {}
      } catch (err) {
        const msg = err?.message || String(err || 'Like failed');
        this._listCtl.toastError(msg, { kind: 'error', dedupe: false });
      } finally {
        const cur = this._postAction.get(uri) || {};
        this._postAction.set(uri, { ...cur, busyLike: false });
        this._rerenderAfterAction();
      }
      return;
    }
  }

  async load(reset=false){
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    if (reset) {
      this.items = [];
      this.offset = 0;
      this.hasMore = false;
      this._backfillDone = false;
    }
    if (!reset) this._listCtl.requestRestore({ anchor: true });
    this.render();

    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this.items = [];
        this.error = 'Not connected. Use the Connect button.';
        return;
      }
      this._myDid = auth?.did || null;

      const reasons = Array.from(this.filters.reasons);
      // DB-first: query cached notifications.
      let data = await call('cacheQueryNotifications', {
        hours: this.filters.hours,
        reasons,
        limit: this.limit,
        offset: this.offset,
        newestFirst: true,
      });

      // If cache is empty on a reset load, seed with a recent sync.
      const firstBatch = (data.items || data.notifications || []).map(normalizeNotification);
      if (reset && firstBatch.length === 0) {
        for (;;) {
          try {
            await call('cacheSyncRecent', { minutes: 60 });
            break;
          } catch (e) {
            const waited = await this._backoffIfRateLimited(e, { quiet: false });
            if (waited) continue;
            throw e;
          }
        }
        data = await call('cacheQueryNotifications', {
          hours: this.filters.hours,
          reasons,
          limit: this.limit,
          offset: this.offset,
          newestFirst: true,
        });
      }

      const batch = (data.items || data.notifications || []).map(normalizeNotification);
      const have = new Set(this.items.map(n => this.notifKey(n)));
      const fresh = [];
      for (const n of batch) {
        const k = this.notifKey(n);
        if (have.has(k)) continue;
        have.add(k);
        fresh.push(n);
      }

      if (reset) this.items = fresh;
      else this.items = [...this.items, ...fresh];

      this.offset = this.items.length;
      this.hasMore = !!data.hasMore;

      // collect unique DIDs we need relationship info for
      const dids = Array.from(new Set(this.items.map(n => n?.author?.did).filter(Boolean)));
      if (dids.length) {
        await this.populateRelationships(dids);
      }

      this.error = null;
    } catch(e) {
      this.error = isNotConnectedError(e) ? 'Not connected. Use the Connect button.' : e.message;
      if (this.error) this._listCtl.toastError(this.error, { kind: 'error', dedupe: true });
    } finally {
      this.loading = false;
      this.render();
    }
  }

  async populateRelationships(dids){
    // client-side chunking (≤25) in case the server ever changes or other endpoints call it
    const chunks = [];
    for (let i = 0; i < dids.length; i += 25) chunks.push(dids.slice(i, i+25));

    const map = {...this.followMap};
    for (const chunk of chunks) {
      try {
        const rel = await call('getRelationships', { actors: chunk });
        (rel.relationships || []).forEach(r => {
          map[r.did] = {
            following: !!r.following,
            followedBy: !!r.followedBy,
            muted: !!r.muted,
            blocking: !!r.blockedBy || !!r.blocking
          };
        });
      } catch (err) {
        // Fallback: use profiles.viewer flags (server also chunks getProfiles)
        try {
          const prof = await call('getProfiles', { actors: chunk });
          (prof.profiles || []).forEach(p => {
            const v = p.viewer || {};
            map[p.did] = {
              following: !!v.following,
              followedBy: !!v.followedBy,
              muted: !!v.muted,
              blocking: !!v.blockedBy || !!v.blocking
            };
          });
        } catch (_) { /* swallow; we’ll just show raw notifications */ }
      }
    }
    this.followMap = map;
  }

  async followOne(did, btn){
    if (!did) return;
    btn?.setAttribute('disabled','disabled');
    try {
      await call('follow', { did });
      this.followMap[did] = { ...(this.followMap[did] || {}), following: true };
      btn.textContent = 'Following';
      btn.classList.add('following');
    } catch(e) {
      alert('Follow failed: ' + e.message);
      btn?.removeAttribute('disabled');
    }
  }

  async followAll(btn){
    const searchQ = String(this._searchSpec?.query || '').trim();
    const searchMatcher = this._searchMatcher;
    const searchActive = !!(searchMatcher && searchQ.length >= 2);

    const hudReasons = (() => {
      try {
        const r = this._searchSpec?.filters?.notifications?.reasons;
        if (Array.isArray(r)) return new Set(r.map(String));
      } catch {}
      return null;
    })();

    const baseItems = this.filteredItems({ reasons: hudReasons || this.filters.reasons });
    const sourceItems = (searchActive && String(this._searchSpec?.mode || 'cache') === 'cache' && Array.isArray(this._searchApiItems))
      ? this._searchApiItems
      : baseItems;

    const shown = searchActive
      ? sourceItems.filter((n) => {
          try {
            const authors = this._authorsFor(n);
            const a = authors[0] || {};
            const text = [
              this.labelFor(n),
              ...authors.flatMap((x) => {
                const xx = x || {};
                return [
                  xx.displayName || '',
                  xx.handle ? `@${xx.handle}` : '',
                  xx.did || '',
                ];
              }),
              n.reason || '',
              n.reasonSubject || '',
            ].filter(Boolean).join(' ');
            const fields = {
              reason: n.reason || '',
              uri: n.uri || '',
              subject: n.reasonSubject || '',
              handle: a.handle || '',
              did: a.did || '',
            };
            return !!searchMatcher(text, fields);
          } catch {
            return true;
          }
        })
      : sourceItems;

    const display = this._groupNotificationsForDisplay(shown);
    const toFollow = Array.from(new Set(
      display
        .flatMap((n) => this._authorsFor(n).map((a) => a?.did).filter(Boolean))
        .filter((did) => did && !this.followMap[did]?.following && !this.followMap[did]?.queued)
    ));
    if (!toFollow.length) return;

    this._bulkState = { running:true, done:0, total:toFollow.length };
    this._bulkFollowTargets = new Set(toFollow);
    this.render();

    try {
      // Mark as queued immediately to avoid re-enqueue spam while processing.
      toFollow.forEach((did) => {
        this.followMap[did] = { ...(this.followMap[did] || {}), queued: true };
      });

      const res = await queueFollows(toFollow, { processNow: true, maxNow: 50, maxPerTick: 50 });
      const results = res?.processed?.results || {};
      Object.keys(results).forEach((did) => {
        if (results[did]?.ok) this.followMap[did] = { ...(this.followMap[did] || {}), following: true, queued: false };
      });

      this._bulkState.done = Array.from(this._bulkFollowTargets).filter((did) => !!this.followMap?.[did]?.following).length;
      startFollowQueueProcessor({ maxPerTick: 50 });
      this.render();
    } catch (e) {
      this._bulkState.running = false;
      this._bulkFollowTargets = null;
      this.error = 'Bulk follow failed: ' + (e?.message || String(e || 'unknown'));
      this.render();
    }
  }

  labelFor(n){
    const reason = String(n?.reason || '').trim();

    if (n && typeof n === 'object' && n.__group) {
      const authors = this._authorsFor(n);
      const names = authors
        .map((a) => a?.displayName || a?.handle || a?.did)
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

    const who = n?.author?.displayName || n?.author?.handle || n?.author?.did || 'Someone';
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

  filteredItems(opts = {}){
    const reasonsSet = (opts?.reasons instanceof Set) ? opts.reasons : this.filters.reasons;
    const onlyNotFollowed = this.filters.onlyNotFollowed;
    const items = this.items.filter(n => {
      if (!reasonsSet.has(n.reason)) return false;
      if (!onlyNotFollowed) return true;
      const did = n.author?.did;
      return did && !this.followMap[did]?.following && !this.followMap[did]?.queued;
    });
    // Newest first
    items.sort((a,b) => new Date(b.indexedAt || b.createdAt || 0) - new Date(a.indexedAt || a.createdAt || 0));
    return items;
  }

  render(){
    this._listCtl.beforeRender();

    const embedded = this.hasAttribute('embedded');
    const bulkBadge = this._bulkState.running
      ? `<span class="bulk-progress">Following ${this._bulkState.done}/${this._bulkState.total}…</span>`
      : '';

    const filters = `
      <div class="filters">
        <label>Range:
          <select id="range">
            <option value="24" ${this.filters.hours===24?'selected':''}>Last 24h</option>
            <option value="72" ${this.filters.hours===72?'selected':''}>Last 3 days</option>
            <option value="168" ${this.filters.hours===168?'selected':''}>Last 7 days</option>
            <option value="720" ${this.filters.hours===720?'selected':''}>Last 30 days</option>
          </select>
        </label>
        <label class="only-not"><input type="checkbox" id="only-not-followed" ${this.filters.onlyNotFollowed?'checked':''}> Only not-followed</label>
        <div class="reasons">
          <div class="quick" role="group" aria-label="Activity filters">
            ${(() => {
              const active = this._activeReasonPreset(this.filters.reasons);
              const btn = (id, label) => `
                <button type="button" class="q" data-reason-preset="${id}" aria-pressed="${active === id ? 'true' : 'false'}">${label}</button>
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
          ${REASONS.map(r => `
            <label><input type="checkbox" data-reason="${r}" ${this.filters.reasons.has(r)?'checked':''}> ${r}</label>
          `).join('')}
        </div>
        <div class="bulk">
          <label>Mode:
            <select id="mode">
              <option value="notifications" ${this.mode === 'notifications' ? 'selected' : ''}>Notifications</option>
              <option value="activity" ${this.mode === 'activity' ? 'selected' : ''}>Activity</option>
            </select>
          </label>
          <label>View:
            <select id="view">
              <option value="list" ${this.view==='list'?'selected':''}>List</option>
              <option value="masonry" ${this.view==='masonry'?'selected':''}>Masonry</option>
            </select>
          </label>
          <button id="reload" ${this.loading?'disabled':''}>Refresh</button>
          <button id="follow-all" ${this.loading || this._bulkState.running?'disabled':''}>Follow all shown</button>
          <button id="mark-all-read" ${this.loading || this._markSeenBusy ? 'disabled' : ''}>Mark all read</button>
          <button id="prefs" ${this._prefs?.loading || this._prefs?.saving ? 'disabled' : ''}>Preferences</button>
          ${bulkBadge}
        </div>
      </div>
    `;

    const prefsModal = (() => {
      if (!this._prefs?.open) return '';
      const rawJson = (() => {
        try {
          if (!this._prefs.raw) return '';
          return esc(JSON.stringify(this._prefs.raw, null, 2));
        } catch {
          return '';
        }
      })();
      const priorityKnown = (typeof this._prefs.priority === 'boolean');
      const busy = !!(this._prefs.loading || this._prefs.saving);
      return `
        <div class="prefs-host" role="dialog" aria-modal="true" aria-label="Notification preferences">
          <div class="prefs-backdrop" data-prefs-action="close"></div>
          <div class="prefs-card">
            <div class="prefs-hd">
              <div class="prefs-title">Notification preferences</div>
              <div class="prefs-actions">
                <button class="mini" type="button" data-prefs-action="reload" ${busy ? 'disabled' : ''}>Reload</button>
                <button class="mini" type="button" data-prefs-action="close">Close</button>
              </div>
            </div>
            <div class="prefs-bd">
              ${this._prefs.loading ? '<div class="muted">Loading…</div>' : ''}
              ${this._prefs.error ? `<div class="prefs-err">${esc(this._prefs.error)}</div>` : ''}

              <div class="prefs-sec">
                <div class="prefs-sec-title">Priority</div>
                <label class="prefs-row">
                  <input type="checkbox" id="prefs-priority" ${priorityKnown && this._prefs.priority ? 'checked' : ''} ${busy || !priorityKnown ? 'disabled' : ''}>
                  <span>Priority notifications</span>
                </label>
                <div class="muted" style="margin-top:6px">
                  This maps to <code>app.bsky.notification.putPreferences</code> (currently exposes only the <code>priority</code> toggle).
                </div>
                <div style="margin-top:10px; display:flex; gap:8px;">
                  <button type="button" data-prefs-action="save" ${busy || !priorityKnown ? 'disabled' : ''}>Save</button>
                </div>
              </div>

              ${rawJson ? `
                <details class="prefs-sec">
                  <summary class="prefs-sec-title">Raw preferences</summary>
                  <pre class="prefs-pre">${rawJson}</pre>
                </details>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    })();

    const hudReasons = (() => {
      try {
        const r = this._searchSpec?.filters?.notifications?.reasons;
        if (Array.isArray(r)) return new Set(r.map(String));
      } catch {}
      return null;
    })();
    const baseItems = this.filteredItems({ reasons: hudReasons || this.filters.reasons });
    const searchQ = String(this._searchSpec?.query || '').trim();
    const searchMatcher = this._searchMatcher;
    const searchActive = !!(searchMatcher && searchQ.length >= 2);

    const searchStatus = (() => {
      if (!searchActive) return '';
      const src = Array.isArray(this._searchApiItems) ? 'db' : 'loaded';
      const err = this._searchApiError ? ` · Error: ${esc(this._searchApiError)}` : '';
      const loading = this._searchApiInFlight ? ' · Searching…' : '';
      return `<div class="search-status">Search: <b>${esc(searchQ)}</b> · Source: ${esc(src)}${loading}${err}</div>`;
    })();

    const sourceItems = (searchActive && String(this._searchSpec?.mode || 'cache') === 'cache' && Array.isArray(this._searchApiItems))
      ? this._searchApiItems
      : baseItems;

    const shownItems = searchActive
      ? sourceItems.filter((n) => {
          try {
            const authors = this._authorsFor(n);
            const a = authors[0] || {};
            const text = [
              this.labelFor(n),
              ...authors.flatMap((x) => {
                const xx = x || {};
                return [
                  xx.displayName || '',
                  xx.handle ? `@${xx.handle}` : '',
                  xx.did || '',
                ];
              }),
              n.reason || '',
              n.reasonSubject || '',
            ].filter(Boolean).join(' ');
            const fields = {
              reason: n.reason || '',
              uri: n.uri || '',
              subject: n.reasonSubject || '',
              handle: a.handle || '',
              did: a.did || '',
            };
            return !!searchMatcher(text, fields);
          } catch {
            return true;
          }
        })
      : sourceItems;

    const displayItems = this._groupNotificationsForDisplay(shownItems);

    this._shownItemsCache = displayItems;
    this._keyToIndex = new Map();
    try {
      for (let i = 0; i < displayItems.length; i++) {
        this._keyToIndex.set(String(this.notifKey(displayItems[i]) || ''), i);
      }
    } catch {
      // ignore
    }

    const listInner = this._windowedListInnerHtml(displayItems, { loading: !!this.loading });

    const activityUi = (() => {
      if (this.mode !== 'activity') return '';
      const active = this.activityTab;
      const myDid = String(this._myDid || '').trim();

      const tabBtn = (id, label) => `
        <button type="button" class="tab" data-activity-tab="${id}" aria-pressed="${active === id ? 'true' : 'false'}">${label}</button>
      `;

      const tabs = `
        <div class="activity-tabs" role="tablist" aria-label="Activity tabs">
          ${tabBtn('on-my-posts', 'On my posts')}
          ${tabBtn('my-actions', 'My actions')}
        </div>
      `;

      if (active === 'on-my-posts') {
        const reasons = new Set(['like','repost','reply','quote']);
        const rows = shownItems
          .filter((n) => reasons.has(String(n?.reason || '')))
          .filter((n) => {
            if (!myDid) return true;
            const subjDid = atUriDid(n?.reasonSubject || '');
            return subjDid ? (subjDid === myDid) : true;
          });

        return `
          <div class="activity">
            ${tabs}
            <div class="muted" style="margin:6px 0 10px 0">Engagement on your posts inferred from notifications (likes/reposts/replies/quotes).</div>
            <div class="activity-list">
              ${rows.length ? this._windowedListInnerHtml(rows, { loading: !!this.loading }) : '<div class="muted">No activity in the current range.</div>'}
            </div>
          </div>
        `;
      }

      const st = this._activity.actions;
      const acts = Array.isArray(st?.items) ? st.items : [];
      const list = acts.map((a) => this._renderMyActionRow(a)).join('') || (st.loading ? '<div class="muted">Loading…</div>' : '<div class="muted">No recent actions found.</div>');
      const loadMoreDisabled = !!(st.loading || st.done);

      return `
        <div class="activity">
          ${tabs}
          <div class="muted" style="margin:6px 0 10px 0">Your own likes/reposts (repo records).</div>
          ${st.error ? `<div class="muted" style="color:#f88">Error: ${esc(st.error)}</div>` : ''}
          <div class="activity-list">
            ${list}
          </div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button type="button" data-load-more-actions ${loadMoreDisabled ? 'disabled' : ''}>Load more</button>
          </div>
        </div>
      `;
    })();

    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{display:block;margin:${embedded ? '0' : '12px 0'}}
        .wrap{border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:10px;background:#070707;color:#fff}
        .wrap.embedded{border:0;border-radius:0;padding:0;background:transparent}
        .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
        .head.embedded{display:none}
        .filters{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
        .filters label{color:#ddd}
        .only-not{margin-left:6px}
        .reasons{display:flex;gap:10px;flex-wrap:wrap}
        .quick{display:flex;gap:6px;flex-wrap:wrap;width:100%;margin-bottom:6px}
        .q{background:#111;border:1px solid #555;color:#fff;padding:5px 8px;border-radius: var(--bsky-radius, 0px);cursor:pointer;font-size:.82rem}
        .q[aria-pressed="true"]{background:#1d2a41;border-color:#2f4b7a}
        .bulk{margin-left:auto;display:flex;gap:8px;align-items:center}
        .bulk-progress{color:#bbb;font-size:.9rem}
        .search-status{color:#aaa;font-size:.85rem;margin:6px 0 8px 0}

        .activity{border:1px solid #2b2b2b;border-radius: var(--bsky-radius, 0px);padding:10px;background:#0a0a0a;margin:10px 0}
        .activity-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
        .tab{appearance:none;background:var(--bsky-btn-bg, #111);color:var(--bsky-fg, #fff);border:1px solid var(--bsky-border, #333);border-radius: var(--bsky-radius, 0px);padding:6px 10px;cursor:pointer;font-weight:800}
        .tab[aria-pressed="true"]{background:#1d2a41;border-color:#2f4b7a}
        .actrow{display:flex;gap:10px;align-items:flex-start;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:8px;background:#0f0f0f;margin:6px 0}
        .actleft{flex:1 1 auto;min-width:0}
        .actright{flex:0 0 auto}
        .actkind{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
        .acttext{color:#ddd;font-size:.92rem;margin-top:4px;white-space:pre-wrap;word-break:break-word}

        .list{width:100%}
        .list.masonry{column-width:var(--bsky-card-min-w, 350px); column-gap:var(--bsky-grid-gutter, 24px)}
        .list.masonry .n{break-inside:avoid; display:inline-flex; width:100%}

        .win-spacer{width:100%;pointer-events:none;contain:layout size style}

        .n{display:flex;align-items:center;gap:10px;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:2px;margin:0;background:#0f0f0f}
        /* Lightweight “windowing”: skip rendering offscreen entries (huge perf win on long lists). */
        .n{content-visibility:auto;contain-intrinsic-size:350px 72px}
        .av{width:32px;height:32px;border-radius: var(--bsky-radius, 0px);background:#222;object-fit:cover}
        .sub{color:#bbb;font-size:.9rem}
        .kfWrap{margin-top:8px;border-top:1px solid rgba(255,255,255,.10);padding-top:8px}
        .kf{font-size:.9rem}
        .kf.err{color:#ffb3b3}
        .kfLine{font-size:.86rem}
        .kfList{display:flex;flex-direction:column;gap:6px;margin-top:6px}
        .kfItem{display:flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);padding:6px 8px;border-radius: var(--bsky-radius, 0px)}
        .kfAv{width:26px;height:26px;border-radius: var(--bsky-radius, 0px);background:#222;object-fit:cover;flex:0 0 auto}
        .kfAv.ph{display:inline-block}
        .kfMeta{min-width:0;flex:1 1 auto}
        .kfTitle{font-weight:800;word-break:break-word;font-size:.9rem}
        .kfSub{font-size:.82rem}
        .chip{background:#1e2e1e;color:#89f0a2;border:1px solid #2e5a3a;border-radius: var(--bsky-radius, 0px);padding:1px 6px;font-size:.75rem;margin-left:6px}
        .following-badge{color:#7bdc86;font-size:.9rem}
        .open{color:#9cd3ff}
        .muted{color:#aaa}
        button{background:#111;border:1px solid #555;color:#fff;padding:6px 10px;border-radius: var(--bsky-radius, 0px);cursor:pointer}
        button:disabled{opacity:.6;cursor:not-allowed}
        .act{display:flex;gap:8px;align-items:center;justify-content:flex-end}
        .mini{padding:4px 8px;font-size:.85rem}
        .view-btn{margin-left:2px}
        select{background:#0f0f0f;color:#fff;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:6px 10px}

        .prefs-host{position:fixed;inset:0;z-index:100003;display:flex;align-items:center;justify-content:center}
        .prefs-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.72)}
        .prefs-card{position:relative;width:min(860px, calc(100vw - 20px));max-height:min(86vh, 860px);overflow:auto;background:var(--bsky-surface, #0b0b0b);border:1px solid var(--bsky-border, #2b2b2b);border-radius: var(--bsky-radius, 0px);box-shadow:0 18px 60px rgba(0,0,0,.65);color:var(--bsky-fg, #fff)}
        .prefs-hd{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.10);position:sticky;top:0;background:var(--bsky-surface, #0b0b0b)}
        .prefs-title{font-weight:900}
        .prefs-actions{display:flex;gap:8px;align-items:center}
        .prefs-bd{padding:12px 14px}
        .prefs-sec{margin:10px 0;padding:10px;border:1px solid #2b2b2b;border-radius: var(--bsky-radius, 0px);background:#0a0a0a}
        .prefs-sec-title{font-weight:800}
        .prefs-row{display:flex;gap:10px;align-items:center;margin-top:8px}
        .prefs-err{color:#f88;margin:8px 0}
        .prefs-pre{white-space:pre-wrap;word-break:break-word;color:#ddd;margin:10px 0 0 0}
        code{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;color:#cfe3ff}
      </style>
      <div class="wrap ${embedded ? 'embedded' : ''}">
        <div class="head ${embedded ? 'embedded' : ''}"><div><strong>Notifications</strong></div></div>
        ${filters}
        ${searchStatus}
        ${this.mode === 'activity' ? activityUi : `
          <div class="list ${esc(this.view)}">
            ${listInner}
          </div>
        `}
        ${!searchActive ? renderListEndcap({
          loading: this.loading,
          hasMore: this.hasMore,
          count: shownItems.length,
        }) : ''}
        ${this.error ? `<div class="muted" style="color:#f88">Error: ${esc(this.error)}</div>` : ''}
      </div>`;

    if (this._prefs?.open) {
      // Render modal overlay after base UI to keep it on top.
      this.shadowRoot.insertAdjacentHTML('beforeend', prefsModal);

      // Keep local state in sync with checkbox.
      const cb = this.shadowRoot.querySelector('#prefs-priority');
      if (cb) {
        cb.addEventListener('change', () => {
          this._prefs.priority = !!cb.checked;
        });
      }
    }

    this._bindWindowingScroller();
    this._updateWindowEstimateFromDom();
    this._listCtl.afterRender();
  }
}
customElements.define('bsky-notifications', BskyNotifications);
