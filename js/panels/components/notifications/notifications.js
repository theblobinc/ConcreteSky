import { call } from '../../../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../../../auth_state.js';
import { bindInfiniteScroll, resolvePanelScroller, captureScrollAnchor, applyScrollAnchor } from '../../panel_api.js';
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
    this._backfillInFlight = false;
    this._backfillDone = false;
    this._unbindInfiniteScroll = null;
    this._infiniteScrollEl = null;

    this._restoreScrollNext = false;
    this._scrollAnchor = null;
    this._scrollTop = 0;
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

    this._refreshRecentHandler = (e) => {
      const mins = Number(e?.detail?.minutes ?? 2);
      this.refreshRecent(mins);
    };
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

    window.addEventListener('bsky-refresh-recent', this._refreshRecentHandler);

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
      };
      window.addEventListener(BSKY_SEARCH_EVENT, this._onSearchChanged);
    }
  }

  disconnectedCallback(){
    window.removeEventListener('bsky-refresh-recent', this._refreshRecentHandler);
    if (this._onFollowQueueProcessed) window.removeEventListener('bsky-follow-queue-processed', this._onFollowQueueProcessed);
    if (this._onFollowQueueStatus) window.removeEventListener('bsky-follow-queue-status', this._onFollowQueueStatus);
    if (this._authChangedHandler) window.removeEventListener('bsky-auth-changed', this._authChangedHandler);
    if (this._onSearchChanged) {
      try { window.removeEventListener(BSKY_SEARCH_EVENT, this._onSearchChanged); } catch {}
      this._onSearchChanged = null;
    }
    if (this._searchApiTimer) { try { clearTimeout(this._searchApiTimer); } catch {} this._searchApiTimer = null; }
    if (this._unbindInfiniteScroll) { try { this._unbindInfiniteScroll(); } catch {} this._unbindInfiniteScroll = null; }
    this._infiniteScrollEl = null;
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
        this._restoreScrollNext = true;
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
  }

  onClick(e){
    if (e.target.closest('#reload'))      { this.load(true); return; }
    if (e.target.closest('#follow-all'))  { this.followAll(e.target.closest('#follow-all')); return; }
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
      this._restoreScrollNext = false;
    }
    if (!reset) this._restoreScrollNext = true;
    this.render();

    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this.items = [];
        this.error = 'Not connected. Use the Connect button.';
        return;
      }

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
            const a = n.author || {};
            const text = [
              this.labelFor(n),
              a.displayName || '',
              a.handle ? `@${a.handle}` : '',
              a.did || '',
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

    const toFollow = Array.from(new Set(
      shown
        .map(n => n?.author?.did)
        .filter(did => did && !this.followMap[did]?.following && !this.followMap[did]?.queued)
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
    const who = n.author?.displayName || n.author?.handle || n.author?.did || 'Someone';
    switch (n.reason) {
      case 'like': return `${who} liked your post`;
      case 'reply': return `${who} replied to you`;
      case 'repost': return `${who} reposted you`;
      case 'mention': return `${who} mentioned you`;
      case 'quote': return `${who} quoted your post`;
      case 'follow': return `${who} started following you`;
      case 'subscribed':
      case 'subscribed-post': return `New post from ${who}`;
      default: return `${who} ${n.reason || ''}`.trim();
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
    // Preserve scroll position across re-renders when embedded in a panel shell.
    try {
      const scroller = resolvePanelScroller(this);
      if (scroller) {
        this._scrollTop = scroller.scrollTop || 0;
        if (this._restoreScrollNext) {
          this._scrollAnchor = captureScrollAnchor({
            scroller,
            root: this.shadowRoot,
            itemSelector: '.n[data-k]',
            keyAttr: 'data-k',
          });
        }
      }
    } catch {
      // ignore
    }

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
          ${REASONS.map(r => `
            <label><input type="checkbox" data-reason="${r}" ${this.filters.reasons.has(r)?'checked':''}> ${r}</label>
          `).join('')}
        </div>
        <div class="bulk">
          <label>View:
            <select id="view">
              <option value="list" ${this.view==='list'?'selected':''}>List</option>
              <option value="masonry" ${this.view==='masonry'?'selected':''}>Masonry</option>
            </select>
          </label>
          <button id="reload" ${this.loading?'disabled':''}>Refresh</button>
          <button id="follow-all" ${this.loading || this._bulkState.running?'disabled':''}>Follow all shown</button>
          ${bulkBadge}
        </div>
      </div>
    `;

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
            const a = n.author || {};
            const text = [
              this.labelFor(n),
              a.displayName || '',
              a.handle ? `@${a.handle}` : '',
              a.did || '',
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

    const rows = shownItems.map(n => {
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

      const viewBtn = canView
        ? `<button class="view-btn" type="button" data-open-content data-uri="${esc(String(n.reasonSubject || ''))}">View</button>`
        : '';

      return `<div class="n" data-k="${esc(this.notifKey(n))}">
        <img class="av" src="${esc(a.avatar || '')}" alt="" onerror="this.style.display='none'">
        <div class="txt">
          <div class="line">${esc(this.labelFor(n))} ${followsYou ? '<span class="chip">Follows you</span>' : ''}</div>
          <div class="sub">@${esc(a.handle || '')} • ${esc(t)}${open ? ` • <a class="open" href="${esc(open)}" target="_blank" rel="noopener">Open</a>` : ''}</div>
        </div>
        <div class="act">${viewBtn}${cta}</div>
      </div>`;
    }).join('');

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
        .bulk{margin-left:auto;display:flex;gap:8px;align-items:center}
        .bulk-progress{color:#bbb;font-size:.9rem}
        .search-status{color:#aaa;font-size:.85rem;margin:6px 0 8px 0}

        .list{width:100%}
        .list.masonry{column-width:var(--bsky-card-min-w, 350px); column-gap:var(--bsky-grid-gutter, 24px)}
        .list.masonry .n{break-inside:avoid; display:inline-flex; width:100%}

        .n{display:flex;align-items:center;gap:10px;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:2px;margin:0;background:#0f0f0f}
        .av{width:32px;height:32px;border-radius: var(--bsky-radius, 0px);background:#222;object-fit:cover}
        .sub{color:#bbb;font-size:.9rem}
        .chip{background:#1e2e1e;color:#89f0a2;border:1px solid #2e5a3a;border-radius: var(--bsky-radius, 0px);padding:1px 6px;font-size:.75rem;margin-left:6px}
        .following-badge{color:#7bdc86;font-size:.9rem}
        .open{color:#9cd3ff}
        .muted{color:#aaa}
        button{background:#111;border:1px solid #555;color:#fff;padding:6px 10px;border-radius: var(--bsky-radius, 0px);cursor:pointer}
        button:disabled{opacity:.6;cursor:not-allowed}
        .view-btn{margin-right:8px}
        select{background:#0f0f0f;color:#fff;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:6px 10px}
      </style>
      <div class="wrap ${embedded ? 'embedded' : ''}">
        <div class="head ${embedded ? 'embedded' : ''}"><div><strong>Notifications</strong></div></div>
        ${filters}
        ${searchStatus}
        <div class="list ${esc(this.view)}">
          ${rows || (this.loading ? '<div class="muted">Loading…</div>' : '<div class="muted">No notifications in this range.</div>')}
        </div>
        ${this.error ? `<div class="muted" style="color:#f88">Error: ${esc(this.error)}</div>` : ''}
      </div>`;

    // Restore scroll anchor after DOM rebuild.
    if (this._restoreScrollNext) {
      queueMicrotask(() => {
        requestAnimationFrame(() => {
          const scroller = resolvePanelScroller(this);
          if (!scroller) return;
          if (this._scrollAnchor) {
            applyScrollAnchor({ scroller, root: this.shadowRoot, anchor: this._scrollAnchor, keyAttr: 'data-k' });
            setTimeout(() => applyScrollAnchor({ scroller, root: this.shadowRoot, anchor: this._scrollAnchor, keyAttr: 'data-k' }), 160);
          } else {
            scroller.scrollTop = Math.max(0, this._scrollTop || 0);
          }
          this._restoreScrollNext = false;
          this._scrollAnchor = null;
        });
      });
    }
  }
}
customElements.define('bsky-notifications', BskyNotifications);
