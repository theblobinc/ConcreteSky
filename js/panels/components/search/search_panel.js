import { call } from '../../../api.js';
import { dispatchToast, openContentPanel } from '../../panel_api.js';
import { BSKY_SEARCH_EVENT } from '../../../search/search_bus.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));
const escAttr = (s) => String(s || '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));

function atUriParts(uri) {
  try {
    const s = String(uri || '').trim();
    if (!s.startsWith('at://')) return null;
    // at://did/collection/rkey
    const rest = s.slice(5);
    const idx1 = rest.indexOf('/');
    if (idx1 < 0) return null;
    const did = rest.slice(0, idx1);
    const rest2 = rest.slice(idx1 + 1);
    const idx2 = rest2.indexOf('/');
    if (idx2 < 0) return null;
    const collection = rest2.slice(0, idx2);
    const rkey = rest2.slice(idx2 + 1);
    if (!did || !collection || !rkey) return null;
    return { did, collection, rkey };
  } catch {
    return null;
  }
}

function bskyProfileUrl(actor) {
  const a = String(actor || '').trim();
  if (!a) return '';
  return `https://bsky.app/profile/${encodeURIComponent(a)}`;
}

function bskyPostUrl(uri) {
  const p = atUriParts(uri);
  if (!p) return '';
  // https://bsky.app/profile/{did}/post/{rkey}
  if (p.collection !== 'app.bsky.feed.post') return '';
  return `https://bsky.app/profile/${encodeURIComponent(p.did)}/post/${encodeURIComponent(p.rkey)}`;
}

function bskyFeedUrl(uri) {
  const p = atUriParts(uri);
  if (!p) return '';
  // https://bsky.app/profile/{did}/feed/{rkey}
  if (p.collection !== 'app.bsky.feed.generator') return '';
  return `https://bsky.app/profile/${encodeURIComponent(p.did)}/feed/${encodeURIComponent(p.rkey)}`;
}

function bskyListUrl(uri) {
  const p = atUriParts(uri);
  if (!p) return '';
  // https://bsky.app/profile/{did}/lists/{rkey}
  if (p.collection !== 'app.bsky.graph.list') return '';
  return `https://bsky.app/profile/${encodeURIComponent(p.did)}/lists/${encodeURIComponent(p.rkey)}`;
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
}

export class BskySearchPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this.loading = false;
    this.error = '';

    this.query = '';
    this.mode = 'network'; // 'network' | 'cache'

    this.targets = new Set(['people', 'posts', 'feeds']);
    this.targets = new Set(['people', 'posts', 'feeds', 'lists']);
    this.limit = 25;

    this.results = {
      people: [],
      posts: [],
      feeds: [],
      lists: [],
    };

    this.trendingLoading = false;
    this.trendingError = '';
    this.trendingHours = 24 * 7;
    this.trending = {
      hashtags: [],
      links: [],
    };

    this.starterPackInput = '';
    this.starterPackLoading = false;
    this.starterPackError = '';
    this.starterPack = null;
    this.starterPackMembers = [];
    this.starterPackQueue = null;

    /** @type {{id:string,label:string,query:string,mode:string,targets:string[],limit:number,pinned:boolean,order:number,createdAt:string,lastUsedAt:string}[]} */
    this.saved = [];

    this._runSeq = 0;
    this._trendSeq = 0;
    this._debouncedRun = debounce(() => this.runSearch(true), 260);

    this.listViewLoading = false;
    this.listViewError = '';
    this.listView = null;

    this.actorListsLoading = false;
    this.actorListsError = '';
    this.actorListsActor = null;
    this.actorLists = [];
    this.actorListsIncluding = null;

    // Keyed by actor DID/handle: { open, loading, error, followers, fetchedAt }
    this._knownFollowers = new Map();
  }

  connectedCallback() {
    this._loadPrefs();
    this._loadSaved();
    this.render();

    // Load trending on the empty state.
    this._maybeLoadTrending(false);

    if (!this._onExternalSearch) {
      this._onExternalSearch = (e) => {
        try {
          const d = e?.detail || {};
          // Support both our lightweight payload ({query,mode,targets,limit})
          // and full search specs produced by createSearchSpec({query,...}).
          const q = String(d?.query || d?.q || '').trim();
          if (!q) return;

          this._applySearchSpec({
            query: q,
            mode: d?.mode,
            targets: d?.targets,
            limit: d?.limit,
            run: true,
            focus: true,
          });

        } catch {
          // ignore
        }
      };
    }
    window.addEventListener(BSKY_SEARCH_EVENT, this._onExternalSearch);

    this.shadowRoot.addEventListener('submit', (e) => {
      const form = e.target.closest('form[data-search]');
      if (!form) return;
      e.preventDefault();
      this.runSearch(true);
    });

    this.shadowRoot.addEventListener('input', (e) => {
      const q = e.target?.closest?.('input[name="q"]');
      if (q) {
        this.query = String(q.value || '');
        this._savePrefs();
        this._debouncedRun();

        if (String(this.query || '').trim() === '') {
          this._maybeLoadTrending(false);
        }
      }

      const sp = e.target?.closest?.('input[name="starterPackInput"]');
      if (sp) {
        this.starterPackInput = String(sp.value || '');
        this._savePrefs();
      }
    });

    this.shadowRoot.addEventListener('change', (e) => {
      const mode = e.target?.closest?.('select[name="mode"]');
      if (mode) {
        this.mode = String(mode.value || 'network');
        this._savePrefs();
        this.runSearch(true);
        this._maybeLoadTrending(false);
      }

      const lim = e.target?.closest?.('select[name="limit"]');
      if (lim) {
        this.limit = Math.max(5, Math.min(100, Number(lim.value || 25)));
        this._savePrefs();
        this.runSearch(true);
        this._maybeLoadTrending(false);
      }

      const th = e.target?.closest?.('select[name="trendingHours"]');
      if (th) {
        this.trendingHours = Math.max(1, Math.min(24 * 365 * 5, Number(th.value || (24 * 7))));
        this._savePrefs();
        this._maybeLoadTrending(true);
      }

      const tgt = e.target?.closest?.('input[data-target]');
      if (tgt) {
        const k = String(tgt.getAttribute('data-target') || '');
        if (!k) return;
        if (tgt.checked) this.targets.add(k);
        else this.targets.delete(k);
        if (!this.targets.size) this.targets.add('people');
        this._savePrefs();
        this.runSearch(true);
      }
    });

    this.shadowRoot.addEventListener('click', (e) => {
      const btnOpenPost = e.target?.closest?.('button[data-open-post]');
      if (btnOpenPost) {
        e.preventDefault();
        const uri = String(btnOpenPost.getAttribute('data-uri') || '');
        const cid = String(btnOpenPost.getAttribute('data-cid') || '');
        if (!uri) return;
        openContentPanel({ uri, cid, spawnAfter: 'search' }, this);
        return;
      }

      const btnCopy = e.target?.closest?.('button[data-copy]');
      if (btnCopy) {
        e.preventDefault();
        const val = String(btnCopy.getAttribute('data-copy') || '');
        if (!val) return;
        navigator.clipboard?.writeText?.(val);
        dispatchToast(this, { message: 'Copied', kind: 'info', timeoutMs: 1200 });
        return;
      }

      const btnRun = e.target?.closest?.('button[data-action="run"]');
      if (btnRun) {
        e.preventDefault();
        this.runSearch(true);
      }

      const btnSave = e.target?.closest?.('button[data-action="save-search"]');
      if (btnSave) {
        e.preventDefault();
        this.saveCurrentSearch({ promptLabel: true, pin: false });
        return;
      }

      const btnPinCur = e.target?.closest?.('button[data-action="pin-current"]');
      if (btnPinCur) {
        e.preventDefault();
        this.togglePinForCurrent();
        return;
      }

      const savedBtn = e.target?.closest?.('[data-saved-id][data-saved-action]');
      if (savedBtn) {
        e.preventDefault();
        const id = String(savedBtn.getAttribute('data-saved-id') || '');
        const action = String(savedBtn.getAttribute('data-saved-action') || '');
        this._handleSavedAction(id, action);
        return;
      }

      const btnClear = e.target?.closest?.('button[data-action="clear"]');
      if (btnClear) {
        e.preventDefault();
        this.query = '';
        this.error = '';
        this.results = { people: [], posts: [], feeds: [], lists: [] };
        this._savePrefs();
        this._maybeLoadTrending(true);
        this.render();
      }

      const btnRefreshTrending = e.target?.closest?.('button[data-action="refresh-trending"]');
      if (btnRefreshTrending) {
        e.preventDefault();
        this._maybeLoadTrending(true);
        return;
      }

      const btnLoadSp = e.target?.closest?.('button[data-action="load-starter-pack"]');
      if (btnLoadSp) {
        e.preventDefault();
        this._loadStarterPack();
        return;
      }

      const btnQueueSp = e.target?.closest?.('button[data-action="queue-starter-pack-follows"]');
      if (btnQueueSp) {
        e.preventDefault();
        this._queueStarterPackFollows();
        return;
      }

      const btnProcessQueue = e.target?.closest?.('button[data-action="process-follow-queue"]');
      if (btnProcessQueue) {
        e.preventDefault();
        this._processFollowQueue();
        return;
      }

      const trendHash = e.target?.closest?.('button[data-trend-hashtag]');
      if (trendHash) {
        e.preventDefault();
        const tag = String(trendHash.getAttribute('data-trend-hashtag') || '').trim();
        if (!tag) return;
        const q2 = tag.startsWith('#') ? tag : `#${tag}`;
        this._applySearchSpec({ query: q2, mode: 'network', targets: ['posts'], limit: this.limit, run: true, focus: true });
        return;
      }

      const trendHost = e.target?.closest?.('button[data-trend-host]');
      if (trendHost) {
        e.preventDefault();
        const host = String(trendHost.getAttribute('data-trend-host') || '').trim();
        if (!host) return;
        this._applySearchSpec({ query: host, mode: 'network', targets: ['posts'], limit: this.limit, run: true, focus: true });
        return;
      }
      const btnActorLists = e.target?.closest?.('button[data-action="actor-lists"]');
      if (btnActorLists) {
        e.preventDefault();
        const actor = String(btnActorLists.getAttribute('data-actor') || '').trim();
        if (!actor) return;
        this._loadActorLists(actor);
        return;
      }

      const btnActorListsIncluding = e.target?.closest?.('button[data-action="actor-lists-including"]');
      if (btnActorListsIncluding) {
        e.preventDefault();
        const actor = String(btnActorListsIncluding.getAttribute('data-actor') || '').trim();
        if (!actor) return;
        this._loadActorListsIncluding(actor);
        return;
      }

      const btnKnown = e.target?.closest?.('button[data-action="known-followers"]');
      if (btnKnown) {
        e.preventDefault();
        const actor = String(btnKnown.getAttribute('data-actor') || '').trim();
        if (!actor) return;
        this._toggleKnownFollowers(actor);
        return;
      }

      const btnViewList = e.target?.closest?.('button[data-action="view-list"]');
      if (btnViewList) {
        e.preventDefault();
        const uri = String(btnViewList.getAttribute('data-uri') || '').trim();
        if (!uri) return;
        this._loadList(uri, true);
        return;
      }

      const btnListFollowAll = e.target?.closest?.('button[data-action="queue-list-follows"]');
      if (btnListFollowAll) {
        e.preventDefault();
        this._queueListFollows();
        return;
      }

      const btnCloseList = e.target?.closest?.('button[data-action="close-list"]');
      if (btnCloseList) {
        e.preventDefault();
        this.listView = null;
        this.listViewError = '';
        this.render();
        return;
      }
    });
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

  async _toggleKnownFollowers(actor) {
    const key = String(actor || '').trim();
    if (!key) return;

    const cur = this._kfState(key);
    const nextOpen = !cur.open;
    this._setKfState(key, { open: nextOpen, error: cur.error || '' });
    this.render();

    if (!nextOpen) return;
    if (cur.loading) return;
    if (Array.isArray(cur.followers)) return;

    this._setKfState(key, { loading: true, error: '' });
    this.render();
    try {
      const res = await call('getKnownFollowers', { actor: key, limit: 10, pagesMax: 10 });
      const followers = Array.isArray(res?.followers) ? res.followers : [];
      const mapped = followers.map((p) => ({
        did: String(p?.did || ''),
        handle: String(p?.handle || ''),
        displayName: String(p?.displayName || p?.display_name || ''),
        avatar: String(p?.avatar || ''),
      })).filter((p) => p.did || p.handle);
      this._setKfState(key, { followers: mapped, loading: false, error: '', fetchedAt: new Date().toISOString() });
    } catch (e) {
      const msg = e?.message || String(e || 'Failed to load known followers');
      this._setKfState(key, { loading: false, error: msg, followers: [] });
      dispatchToast(this, { message: msg, kind: 'error', timeoutMs: 6000 });
    } finally {
      this.render();
    }
  }

  disconnectedCallback() {
    try {
      if (this._onExternalSearch) window.removeEventListener(BSKY_SEARCH_EVENT, this._onExternalSearch);
    } catch {
      // ignore
    }
  }

  _savedKey() {
    return 'bsky_saved_searches_v1';
  }

  _prefsKey() {
    return 'bsky_search_panel_prefs_v2';
  }

  _nowIso() {
    try { return new Date().toISOString(); } catch { return ''; }
  }

  _newId() {
    try { return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`; } catch { return `s_${Date.now()}`; }
  }

  _loadPrefs() {
    try {
      const raw = localStorage.getItem(this._prefsKey());
      if (!raw) return;
      const p = JSON.parse(raw);
      if (typeof p?.query === 'string') this.query = p.query;
      if (p?.mode === 'cache' || p?.mode === 'network') this.mode = p.mode;
      if (Array.isArray(p?.targets)) this.targets = new Set(this._normalizeTargets(p.targets));
      if (typeof p?.limit === 'number') this.limit = Math.max(5, Math.min(100, p.limit));
      if (typeof p?.trendingHours === 'number') this.trendingHours = Math.max(1, Math.min(24 * 365 * 5, p.trendingHours));
      if (typeof p?.starterPackInput === 'string') this.starterPackInput = p.starterPackInput;
    } catch {
      // ignore
    }
  }

  _savePrefs() {
    try {
      const p = {
        query: String(this.query || ''),
        mode: String(this.mode || 'network'),
        targets: Array.from(this.targets || []),
        limit: Number(this.limit || 25),
        trendingHours: Number(this.trendingHours || (24 * 7)),
        starterPackInput: String(this.starterPackInput || ''),
      };
      localStorage.setItem(this._prefsKey(), JSON.stringify(p));
    } catch {
      // ignore
    }
  }

  _starterPackTitle(sp) {
    try {
      return String(sp?.starterPack?.displayName || sp?.starterPack?.name || sp?.starterPack?.title || sp?.displayName || sp?.name || '').trim();
    } catch {
      return '';
    }
  }

  _starterPackDesc(sp) {
    try {
      return String(sp?.starterPack?.description || sp?.description || '').trim();
    } catch {
      return '';
    }
  }

  _memberDid(m) {
    try {
      return String(m?.did || m?.profile?.did || m?.subject?.did || '').trim();
    } catch {
      return '';
    }
  }

  _memberHandle(m) {
    try {
      return String(m?.handle || m?.profile?.handle || m?.subject?.handle || '').trim();
    } catch {
      return '';
    }
  }

  _memberName(m) {
    try {
      return String(m?.displayName || m?.profile?.displayName || m?.subject?.displayName || '').trim();
    } catch {
      return '';
    }
  }

  async _loadStarterPack() {
    if (this.starterPackLoading) return;

    const input = String(this.starterPackInput || '').trim();
    if (!input) {
      this.starterPackError = 'Paste a starter pack URL or at:// URI.';
      this.render();
      return;
    }

    this.starterPackLoading = true;
    this.starterPackError = '';
    this.starterPackQueue = null;
    this.render();

    try {
      const res = await call('starterPackGet', { input, limit: 100 });
      this.starterPack = res || null;

      const mem = Array.isArray(res?.members)
        ? res.members
        : (Array.isArray(res?.starterPack?.members) ? res.starterPack.members : []);
      this.starterPackMembers = Array.isArray(mem) ? mem : [];
    } catch (e) {
      const msg = e?.message || String(e || 'Failed to load starter pack');
      this.starterPackError = msg;
      this.starterPack = null;
      this.starterPackMembers = [];
    } finally {
      this.starterPackLoading = false;
      this.render();
    }
  }

  async _queueStarterPackFollows() {
    if (this.starterPackLoading) return;
    const dids = Array.from(new Set((this.starterPackMembers || []).map((m) => this._memberDid(m)).filter(Boolean)));
    if (!dids.length) {
      this.starterPackError = 'No members found to follow.';
      this.render();
      return;
    }

    this.starterPackLoading = true;
    this.starterPackError = '';
    this.starterPackQueue = null;
    this.render();

    try {
      const out = await call('queueFollows', { dids, processNow: true, maxNow: 50 });
      this.starterPackQueue = out || null;
    } catch (e) {
      const msg = e?.message || String(e || 'Queue follows failed');
      this.starterPackError = msg;
    } finally {
      this.starterPackLoading = false;
      this.render();
    }
  }

  async _processFollowQueue() {
    if (this.starterPackLoading) return;
    this.starterPackLoading = true;
    this.starterPackError = '';
    this.render();
    try {
      const out = await call('processFollowQueue', { max: 50 });
      this.starterPackQueue = { ...(this.starterPackQueue || {}), processed: out, status: out?.status || out?.status?.status || out?.status || null };
    } catch (e) {
      const msg = e?.message || String(e || 'Process queue failed');
      this.starterPackError = msg;
    } finally {
      this.starterPackLoading = false;
      this.render();
    }
  }

  async _maybeLoadTrending(force = false) {
    const empty = (String(this.query || '').trim() === '');
    if (!empty) return;
    if (this.trendingLoading) return;
    if (!force && (Array.isArray(this.trending?.hashtags) && this.trending.hashtags.length)) return;

    const seq = ++this._trendSeq;
    this.trendingLoading = true;
    this.trendingError = '';
    this.render();

    try {
      const res = await call('trending', {
        mode: this.mode,
        hours: this.trendingHours,
        limit: 20,
        maxPosts: 2000,
      });

      if (seq !== this._trendSeq) return;

      const hashtags = Array.isArray(res?.hashtags) ? res.hashtags : [];
      const links = Array.isArray(res?.links) ? res.links : [];
      this.trending = { hashtags, links };
    } catch (e) {
      const msg = e?.message || String(e || 'Trending failed');
      this.trendingError = msg;
    } finally {
      if (seq !== this._trendSeq) return;
      this.trendingLoading = false;
      this.render();
    }
  }

  _normalizeTargets(arr) {
    const allowed = new Set(['people', 'posts', 'feeds', 'lists']);
    const list = Array.isArray(arr) ? arr.map(String) : [];
    const out = Array.from(new Set(list.filter((t) => allowed.has(t))));
    return out.length ? out : ['posts'];
  }

  async _loadActorLists(actor) {
    if (this.actorListsLoading) return;
    this.actorListsLoading = true;
    this.actorListsError = '';
    this.actorListsActor = actor;
    this.actorLists = [];
    this.actorListsIncluding = null;
    this.render();
    try {
      const res = await call('getLists', { actor, limit: 50 });
      this.actorLists = Array.isArray(res?.lists) ? res.lists : [];
    } catch (e) {
      this.actorListsError = e?.message || String(e || 'Failed to load lists');
    } finally {
      this.actorListsLoading = false;
      this.render();
    }
  }

  async _loadActorListsIncluding(actor) {
    if (this.actorListsLoading) return;
    this.actorListsLoading = true;
    this.actorListsError = '';
    this.actorListsActor = actor;
    this.actorListsIncluding = null;
    this.render();
    try {
      const res = await call('listsIncludingActor', { actor, limit: 50 });
      this.actorListsIncluding = res || null;
    } catch (e) {
      this.actorListsIncluding = null;
      this.actorListsError = e?.message || String(e || 'Lists-including lookup failed');
    } finally {
      this.actorListsLoading = false;
      this.render();
    }
  }

  async _loadList(listUri, reset = true) {
    if (this.listViewLoading) return;
    this.listViewLoading = true;
    this.listViewError = '';
    this.render();
    try {
      const res = await call('getList', { list: listUri, limit: 50, cursor: reset ? null : (this.listView?.cursor || null) });
      const items = Array.isArray(res?.items) ? res.items : [];
      this.listView = {
        uri: listUri,
        list: res?.list || null,
        items: reset ? items : [...(this.listView?.items || []), ...items],
        cursor: res?.cursor || null,
      };
    } catch (e) {
      this.listViewError = e?.message || String(e || 'Failed to load list');
    } finally {
      this.listViewLoading = false;
      this.render();
    }
  }

  async _queueListFollows() {
    const dids = Array.from(new Set((this.listView?.items || [])
      .map((it) => String(it?.subject?.did || it?.did || '').trim())
      .filter(Boolean)));
    if (!dids.length) {
      this.listViewError = 'No list members found to follow.';
      this.render();
      return;
    }
    try {
      await call('queueFollows', { dids, processNow: true, maxNow: 50 });
      dispatchToast(this, { message: `Queued ${dids.length} follows`, kind: 'info', timeoutMs: 3500 });
    } catch (e) {
      const msg = e?.message || String(e || 'Queue follows failed');
      this.listViewError = msg;
      dispatchToast(this, { message: msg, kind: 'error', timeoutMs: 6000 });
    } finally {
      this.render();
    }
  }

  _specKey(spec) {
    const q = String(spec?.query || '').trim();
    const mode = String(spec?.mode || 'network');
    const targets = this._normalizeTargets(spec?.targets);
    const limit = Math.max(5, Math.min(100, Number(spec?.limit || 25)));
    return `${mode}|${limit}|${targets.slice().sort().join(',')}|${q}`;
  }

  _currentSpec() {
    return {
      query: String(this.query || '').trim(),
      mode: String(this.mode || 'network'),
      targets: Array.from(this.targets),
      limit: Number(this.limit || 25),
    };
  }

  _loadSaved() {
    try {
      const raw = localStorage.getItem(this._savedKey());
      if (!raw) { this.saved = []; return; }
      const j = JSON.parse(raw);
      const arr = Array.isArray(j) ? j : (Array.isArray(j?.items) ? j.items : []);
      const now = this._nowIso();
      const norm = (arr || []).map((x, i) => {
        const id = String(x?.id || '').trim() || this._newId();
        const query = String(x?.query || x?.q || '').trim();
        if (!query) return null;
        const mode = (String(x?.mode || 'network') === 'cache') ? 'cache' : 'network';
        const targets = this._normalizeTargets(x?.targets);
        const limit = Math.max(5, Math.min(100, Number(x?.limit || 25)));
        const pinned = !!x?.pinned;
        const order = Number.isFinite(Number(x?.order)) ? Number(x.order) : i;
        const createdAt = String(x?.createdAt || '') || now;
        const lastUsedAt = String(x?.lastUsedAt || '') || createdAt;
        const label = String(x?.label || x?.name || '').trim() || query;
        return { id, label, query, mode, targets, limit, pinned, order, createdAt, lastUsedAt };
      }).filter(Boolean);
      this.saved = norm;
    } catch {
      this.saved = [];
    }
  }

  _saveSaved() {
    try {
      localStorage.setItem(this._savedKey(), JSON.stringify(this.saved || []));
    } catch {
      // ignore
    }
  }

  _sortedSaved() {
    const arr = Array.isArray(this.saved) ? this.saved.slice() : [];
    arr.sort((a, b) => {
      const ap = a?.pinned ? 1 : 0;
      const bp = b?.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      const ao = Number(a?.order ?? 0);
      const bo = Number(b?.order ?? 0);
      if (ao !== bo) return ao - bo;
      const at = String(a?.lastUsedAt || '');
      const bt = String(b?.lastUsedAt || '');
      return bt.localeCompare(at);
    });
    return arr;
  }

  _findSavedByKey(key) {
    const list = Array.isArray(this.saved) ? this.saved : [];
    return list.find((s) => this._specKey(s) === key) || null;
  }

  _touchSaved(id) {
    const list = Array.isArray(this.saved) ? this.saved : [];
    const idx = list.findIndex((s) => String(s?.id || '') === String(id || ''));
    if (idx < 0) return;
    list[idx] = { ...list[idx], lastUsedAt: this._nowIso() };
    this.saved = list;
    this._saveSaved();
  }

  _applySearchSpec({ query, mode, targets, limit, run = false, focus = false } = {}) {
    const q = String(query || '').trim();
    if (q) this.query = q;

    const m = String(mode || '').trim();
    if (m) this.mode = (m === 'cache') ? 'cache' : 'network';

    if (targets) {
      const next = this._normalizeTargets(targets);
      this.targets = new Set(next);
    }

    const lim = Number(limit);
    if (Number.isFinite(lim)) this.limit = Math.max(5, Math.min(100, lim));

    this._savePrefs();
    this.render();
    if (run) this.runSearch(true);

    if (focus) {
      requestAnimationFrame(() => {
        try {
          const input = this.shadowRoot?.querySelector?.('input[name="q"]');
          input?.focus?.();
          input?.select?.();
        } catch {
          // ignore
        }
      });
    }
  }

  saveCurrentSearch({ promptLabel = true, pin = false } = {}) {
    const spec = this._currentSpec();
    if (!spec.query) {
      dispatchToast(this, { message: 'Nothing to save (empty query).', kind: 'info', timeoutMs: 2000 });
      return;
    }

    const key = this._specKey(spec);
    const existing = this._findSavedByKey(key);
    const now = this._nowIso();

    let label = existing ? String(existing.label || '') : '';
    if (promptLabel) {
      const next = prompt('Saved search name:', label || spec.query);
      if (next === null) return;
      label = String(next || '').trim();
    }
    if (!label) label = spec.query;

    if (existing) {
      existing.label = label;
      existing.pinned = pin ? true : !!existing.pinned;
      existing.lastUsedAt = now;
    } else {
      const orderBase = (Array.isArray(this.saved) ? this.saved.length : 0);
      const item = {
        id: this._newId(),
        label,
        query: spec.query,
        mode: (spec.mode === 'cache') ? 'cache' : 'network',
        targets: this._normalizeTargets(spec.targets),
        limit: Math.max(5, Math.min(100, Number(spec.limit || 25))),
        pinned: !!pin,
        order: orderBase,
        createdAt: now,
        lastUsedAt: now,
      };
      this.saved = (Array.isArray(this.saved) ? this.saved : []).concat([item]);
    }

    this._saveSaved();
    this.render();
    dispatchToast(this, { message: pin ? 'Pinned search saved.' : 'Search saved.', kind: 'info', timeoutMs: 1600 });
  }

  togglePinForCurrent() {
    const spec = this._currentSpec();
    if (!spec.query) {
      dispatchToast(this, { message: 'Nothing to pin (empty query).', kind: 'info', timeoutMs: 2000 });
      return;
    }
    const key = this._specKey(spec);
    const existing = this._findSavedByKey(key);
    if (!existing) {
      this.saveCurrentSearch({ promptLabel: false, pin: true });
      return;
    }
    existing.pinned = !existing.pinned;
    existing.lastUsedAt = this._nowIso();
    this._saveSaved();
    this.render();
    dispatchToast(this, { message: existing.pinned ? 'Pinned.' : 'Unpinned.', kind: 'info', timeoutMs: 1400 });
  }

  _handleSavedAction(id, action) {
    const list = Array.isArray(this.saved) ? this.saved.slice() : [];
    const idx = list.findIndex((s) => String(s?.id || '') === String(id || ''));
    if (idx < 0) return;
    const item = list[idx];
    const act = String(action || '');
    if (act === 'run') {
      this._applySearchSpec({ query: item.query, mode: item.mode, targets: item.targets, limit: item.limit, run: true, focus: true });
      this._touchSaved(item.id);
      return;
    }
    if (act === 'toggle-pin') {
      list[idx] = { ...item, pinned: !item.pinned, lastUsedAt: this._nowIso() };
      this.saved = list;
      this._saveSaved();
      this.render();
      return;
    }
    if (act === 'rename') {
      const next = prompt('Saved search name:', String(item.label || item.query || ''));
      if (next === null) return;
      list[idx] = { ...item, label: String(next || '').trim() || String(item.query || ''), lastUsedAt: this._nowIso() };
      this.saved = list;
      this._saveSaved();
      this.render();
      return;
    }
    if (act === 'delete') {
      if (!confirm('Delete this saved search?')) return;
      list.splice(idx, 1);
      // Repack order so arrows stay intuitive.
      this.saved = list.map((s, i) => ({ ...s, order: i }));
      this._saveSaved();
      this.render();
      return;
    }
    if (act === 'up' || act === 'down') {
      const dir = (act === 'up') ? -1 : 1;
      const sorted = this._sortedSaved();
      const pos = sorted.findIndex((s) => String(s?.id || '') === String(id || ''));
      const swapWith = pos + dir;
      if (pos < 0 || swapWith < 0 || swapWith >= sorted.length) return;
      // Only reorder within the same pinned group.
      if (!!sorted[pos].pinned !== !!sorted[swapWith].pinned) return;

      const aId = String(sorted[pos].id);
      const bId = String(sorted[swapWith].id);
      const byId = new Map(list.map((s) => [String(s.id), s]));
      const a = byId.get(aId);
      const b = byId.get(bId);
      if (!a || !b) return;
      const ao = Number(a.order ?? 0);
      const bo = Number(b.order ?? 0);
      byId.set(aId, { ...a, order: bo });
      byId.set(bId, { ...b, order: ao });
      this.saved = Array.from(byId.values());
      this._saveSaved();
      this.render();
      return;
    }
  }

  _extractSnippet(post) {
    try {
      const text = post?.record?.text || post?.post?.record?.text || post?.text || '';
      const s = String(text || '').trim().replace(/\s+/g, ' ');
      return s.length > 240 ? `${s.slice(0, 237)}…` : s;
    } catch {
      return '';
    }
  }

  _postUri(post) {
    try {
      return String(post?.uri || post?.post?.uri || '');
    } catch {
      return '';
    }
  }

  _postCid(post) {
    try {
      return String(post?.cid || post?.post?.cid || '');
    } catch {
      return '';
    }
  }

  _postAuthor(post) {
    try {
      return post?.author || post?.post?.author || null;
    } catch {
      return null;
    }
  }

  async runSearch(reset = true) {
    if (this.loading) return;

    const q = String(this.query || '').trim();
    const targets = Array.from(this.targets);

    if (q.length < 2) {
      this.error = q.length ? 'Type at least 2 characters.' : '';
      if (reset) this.results = { people: [], posts: [], feeds: [], lists: [] };
      this.render();
      return;
    }

    this.loading = true;
    this.error = '';
    this.render();

    const seq = ++this._runSeq;

    try {
      const res = await call('search', {
        q,
        mode: this.mode,
        targets,
        limit: this.limit,
        hours: 24 * 365 * 5,
      });

      // Ignore stale results.
      if (seq !== this._runSeq) return;

      const people = Array.isArray(res?.results?.people) ? res.results.people : [];
      const posts = Array.isArray(res?.results?.posts) ? res.results.posts : [];
      const feeds = Array.isArray(res?.results?.feeds) ? res.results.feeds : [];
      const lists = Array.isArray(res?.results?.lists) ? res.results.lists : [];

      this.results = { people, posts, feeds, lists };

      if (this.mode === 'cache' && this.targets.has('feeds')) {
        // Cache mode currently does not support feed search.
        dispatchToast(this, { message: 'Feeds search uses network mode (cache currently returns none).', kind: 'info', timeoutMs: 3500 });
      }
    } catch (e) {
      const msg = e?.message || String(e || 'Search failed');
      this.error = msg;
      dispatchToast(this, { message: msg, kind: 'error', timeoutMs: 6000 });
    } finally {
      this.loading = false;
      this.render();
    }
  }

  render() {
    const q = String(this.query || '');
    const mode = String(this.mode || 'network');
    const limit = Number(this.limit || 25);

    const showTrending = (q.trim() === '');
    const trendingHashtags = Array.isArray(this.trending?.hashtags) ? this.trending.hashtags : [];
    const trendingLinks = Array.isArray(this.trending?.links) ? this.trending.links : [];

    const people = Array.isArray(this.results?.people) ? this.results.people : [];
    const posts = Array.isArray(this.results?.posts) ? this.results.posts : [];
    const feeds = Array.isArray(this.results?.feeds) ? this.results.feeds : [];
    const lists = Array.isArray(this.results?.lists) ? this.results.lists : [];

    const tgt = (k) => this.targets.has(k);

    const curKey = this._specKey(this._currentSpec());
    const curSaved = this._findSavedByKey(curKey);
    const pinnedNow = !!curSaved?.pinned;

    const savedSorted = this._sortedSaved();
    const pinned = savedSorted.filter((s) => !!s?.pinned);

    const pills = pinned.length
      ? `<div class="pills" role="list" aria-label="Pinned searches">
          ${pinned.slice(0, 10).map((s) => `
            <button type="button" class="pillBtn" role="listitem" data-saved-id="${escAttr(s.id)}" data-saved-action="run" title="Run ${escAttr(s.label || s.query)}">${esc(s.label || s.query)}</button>
          `).join('')}
        </div>`
      : '<div class="muted">No pinned searches yet.</div>';

    const savedRows = savedSorted.length
      ? savedSorted.map((s, i) => {
        const isPinned = !!s?.pinned;
        const canUp = i > 0 && (!!savedSorted[i - 1]?.pinned === isPinned);
        const canDown = i < savedSorted.length - 1 && (!!savedSorted[i + 1]?.pinned === isPinned);
        const label = String(s?.label || s?.query || '');
        const meta = `${String(s?.mode || 'network')} • ${Array.isArray(s?.targets) ? s.targets.join(',') : ''} • ${Number(s?.limit || 25)}/target`;
        return `
          <div class="savedRow">
            <div class="savedMeta">
              <div class="savedTitle">${esc(label)}</div>
              <div class="savedSub muted">${esc(meta)}</div>
              <div class="savedQ mono">${esc(String(s?.query || ''))}</div>
            </div>
            <div class="savedActions">
              <button type="button" class="mini" data-saved-id="${escAttr(s.id)}" data-saved-action="run">Run</button>
              <button type="button" class="mini" data-saved-id="${escAttr(s.id)}" data-saved-action="toggle-pin">${isPinned ? 'Unpin' : 'Pin'}</button>
              <button type="button" class="mini" data-saved-id="${escAttr(s.id)}" data-saved-action="rename">Rename</button>
              <button type="button" class="mini" data-saved-id="${escAttr(s.id)}" data-saved-action="up" ${canUp ? '' : 'disabled'}>↑</button>
              <button type="button" class="mini" data-saved-id="${escAttr(s.id)}" data-saved-action="down" ${canDown ? '' : 'disabled'}>↓</button>
              <button type="button" class="mini danger" data-saved-id="${escAttr(s.id)}" data-saved-action="delete">Delete</button>
            </div>
          </div>
        `;
      }).join('')
      : '<div class="muted">No saved searches yet.</div>';

    const peopleRows = people.map((p) => {
      const did = String(p?.did || '');
      const handle = String(p?.handle || '');
      const name = String(p?.displayName || p?.display_name || handle || did || '');
      const desc = String(p?.description || '');
      const avatar = String(p?.avatar || '');
      const prof = did ? bskyProfileUrl(did) : (handle ? bskyProfileUrl(handle) : '');

      const actorKey = did || handle;
      const kf = this._kfState(actorKey);
      const kfLine = (kf.open && Array.isArray(kf.followers) && kf.followers.length)
        ? this._fmtKnownFollowersLine(kf.followers)
        : '';

      const kfBody = kf.open ? (() => {
        if (kf.loading) return '<div class="kf muted">Loading followers you know…</div>';
        if (kf.error) return `<div class="kf err">${esc(kf.error)}</div>`;
        const items = Array.isArray(kf.followers) ? kf.followers : [];
        if (!items.length) return '<div class="kf muted">No followers you know found.</div>';
        const rows = items.slice(0, 10).map((f) => {
          const t = String(f.displayName || (f.handle ? `@${f.handle}` : '') || f.did || '');
          const sub = f.handle ? `@${f.handle}` : (f.did || '');
          const url = f.did ? bskyProfileUrl(f.did) : (f.handle ? bskyProfileUrl(f.handle) : '');
          return `
            <div class="kfItem">
              ${f.avatar ? `<img class="kfAv" src="${escAttr(f.avatar)}" alt="" loading="lazy" />` : `<div class="kfAv ph"></div>`}
              <div class="kfMeta">
                <div class="kfTitle">${esc(t)}</div>
                <div class="kfSub muted">${esc(sub)}</div>
              </div>
              ${url ? `<a class="lnk" href="${escAttr(url)}" target="_blank" rel="noopener">Open</a>` : ''}
            </div>
          `;
        }).join('');
        return `
          ${kfLine ? `<div class="kfLine muted">${esc(kfLine)}</div>` : ''}
          <div class="kfList">${rows}</div>
        `;
      })() : '';

      return `
        <div class="row">
          <div class="rowMain">
            ${avatar ? `<img class="av" src="${escAttr(avatar)}" alt="" loading="lazy" />` : `<div class="av ph"></div>`}
            <div class="meta">
              <div class="title">${esc(name)}</div>
              <div class="sub">${esc(handle ? `@${handle}` : did)}</div>
              ${desc ? `<div class="snippet">${esc(desc)}</div>` : ''}
              ${kf.open ? `<div class="kfWrap">${kfBody}</div>` : ''}
            </div>
          </div>
          <div class="rowActions">
            ${did ? `<button type="button" class="mini" data-copy="${escAttr(did)}">Copy DID</button>` : ''}
            ${(did || handle) ? `<button type="button" class="mini" data-action="known-followers" data-actor="${escAttr(did || handle)}" ${kf.loading ? 'disabled' : ''}>${kf.open ? 'Hide followers you know' : 'Followers you know'}</button>` : ''}
            ${(did || handle) ? `<button type="button" class="mini" data-action="actor-lists" data-actor="${escAttr(did || handle)}" title="Lists by this actor">Lists</button>` : ''}
            ${(did || handle) ? `<button type="button" class="mini" data-action="actor-lists-including" data-actor="${escAttr(did || handle)}" title="Lists that include this actor (if supported)">Lists incl.</button>` : ''}
            ${prof ? `<a class="lnk" href="${escAttr(prof)}" target="_blank" rel="noopener">Open</a>` : ''}
          </div>
        </div>
      `;
    }).join('') || '<div class="muted">No people results.</div>';

    const postRows = posts.map((p) => {
      const uri = this._postUri(p);
      const cid = this._postCid(p);
      const snip = this._extractSnippet(p) || '(no text)';
      const author = this._postAuthor(p) || {};
      const handle = String(author?.handle || '');
      const name = String(author?.displayName || handle || author?.did || '');
      const when = String(p?.indexedAt || p?.post?.indexedAt || p?.record?.createdAt || p?.post?.record?.createdAt || '');
      const open = uri ? (bskyPostUrl(uri) || '') : '';

      return `
        <div class="row">
          <div class="meta">
            <div class="title">${esc(name)}${handle ? ` <span class="muted">@${esc(handle)}</span>` : ''}</div>
            <div class="sub">${when ? esc(when) : ''}</div>
            <div class="snippet">${esc(snip)}</div>
            ${uri ? `<div class="tiny muted">${esc(uri)}</div>` : ''}
          </div>
          <div class="rowActions">
            ${uri ? `<button type="button" class="mini" data-open-post data-uri="${escAttr(uri)}" data-cid="${escAttr(cid)}">Open panel</button>` : ''}
            ${open ? `<a class="lnk" href="${escAttr(open)}" target="_blank" rel="noopener">Open</a>` : ''}
            ${uri ? `<button type="button" class="mini" data-copy="${escAttr(uri)}">Copy URI</button>` : ''}
          </div>
        </div>
      `;
    }).join('') || '<div class="muted">No post results.</div>';

    const feedRows = feeds.map((f) => {
      const uri = String(f?.uri || f?.did || '');
      const name = String(f?.displayName || f?.name || '');
      const desc = String(f?.description || '');
      const creator = f?.creator || {};
      const creatorDid = String(creator?.did || '');
      const creatorHandle = String(creator?.handle || '');
      const open = uri ? (bskyFeedUrl(uri) || '') : '';

      return `
        <div class="row">
          <div class="meta">
            <div class="title">${esc(name || uri)}</div>
            <div class="sub">${creatorHandle ? esc(`by @${creatorHandle}`) : (creatorDid ? esc(`by ${creatorDid}`) : '')}</div>
            ${desc ? `<div class="snippet">${esc(desc)}</div>` : ''}
            ${uri ? `<div class="tiny muted">${esc(uri)}</div>` : ''}
          </div>
          <div class="rowActions">
            ${open ? `<a class="lnk" href="${escAttr(open)}" target="_blank" rel="noopener">Open</a>` : ''}
            ${uri ? `<button type="button" class="mini" data-copy="${escAttr(uri)}">Copy URI</button>` : ''}
          </div>
        </div>
      `;
    }).join('') || '<div class="muted">No feed results.</div>';

    const listRows = lists.map((l) => {
      const uri = String(l?.uri || '');
      const name = String(l?.name || l?.displayName || '').trim();
      const desc = String(l?.description || '').trim();
      const creator = l?.creator || {};
      const creatorDid = String(creator?.did || '');
      const creatorHandle = String(creator?.handle || '');
      const open = uri ? (bskyListUrl(uri) || '') : '';

      return `
        <div class="row">
          <div class="meta">
            <div class="title">${esc(name || uri)}</div>
            <div class="sub">${creatorHandle ? esc(`by @${creatorHandle}`) : (creatorDid ? esc(`by ${creatorDid}`) : '')}</div>
            ${desc ? `<div class="snippet">${esc(desc)}</div>` : ''}
            ${uri ? `<div class="tiny muted">${esc(uri)}</div>` : ''}
          </div>
          <div class="rowActions">
            ${uri ? `<button type="button" class="mini" data-action="view-list" data-uri="${escAttr(uri)}">View members</button>` : ''}
            ${open ? `<a class="lnk" href="${escAttr(open)}" target="_blank" rel="noopener">Open</a>` : ''}
            ${uri ? `<button type="button" class="mini" data-copy="${escAttr(uri)}">Copy URI</button>` : ''}
          </div>
        </div>
      `;
    }).join('') || '<div class="muted">No list results.</div>';

    const actorListsSection = (this.actorListsActor || this.actorListsIncluding || this.actorListsError)
      ? `
        <div class="sec">
          <div class="sech"><b>Actor lists</b><span class="pill">${this.actorListsLoading ? 'Loading…' : ''}</span></div>
          ${this.actorListsActor ? `<div class="muted">Actor: ${esc(this.actorListsActor)}</div>` : ''}
          ${this.actorListsError ? `<div class="err">${esc(this.actorListsError)}</div>` : ''}
          <div class="sech" style="margin-top:10px"><b>Lists by actor</b><span class="pill">${Array.isArray(this.actorLists) ? this.actorLists.length : 0}</span></div>
          ${(Array.isArray(this.actorLists) && this.actorLists.length) ? this.actorLists.map((l) => {
            const uri = String(l?.uri || '');
            const name = String(l?.name || l?.displayName || '').trim();
            const desc = String(l?.description || '').trim();
            const open = uri ? (bskyListUrl(uri) || '') : '';
            return `
              <div class="row">
                <div class="meta">
                  <div class="title">${esc(name || uri)}</div>
                  ${desc ? `<div class="snippet">${esc(desc)}</div>` : ''}
                  ${uri ? `<div class="tiny muted">${esc(uri)}</div>` : ''}
                </div>
                <div class="rowActions">
                  ${uri ? `<button type="button" class="mini" data-action="view-list" data-uri="${escAttr(uri)}">View members</button>` : ''}
                  ${open ? `<a class="lnk" href="${escAttr(open)}" target="_blank" rel="noopener">Open</a>` : ''}
                </div>
              </div>
            `;
          }).join('') : '<div class="muted">No lists found.</div>'}

          <div class="sech" style="margin-top:10px"><b>Lists that include actor</b><span class="pill">${this.actorListsIncluding?.ok ? 'ok' : ''}</span></div>
          ${this.actorListsIncluding
            ? (this.actorListsIncluding.ok
              ? `<div class="muted">Supported by ${esc(this.actorListsIncluding.source || 'server')}</div>`
              : `<div class="muted">Not supported on this server.</div>`)
            : '<div class="muted">Click “Lists incl.” on a person to try.</div>'}
        </div>
      `
      : '';

    const listViewSection = this.listView
      ? `
        <div class="sec">
          <div class="sech"><b>List members</b><span class="pill">${this.listViewLoading ? 'Loading…' : ''}</span></div>
          ${this.listViewError ? `<div class="err">${esc(this.listViewError)}</div>` : ''}
          <div class="toolbar" style="margin:6px 0 10px 0;gap:8px">
            <button type="button" class="mini" data-action="close-list">Close</button>
            <button type="button" class="mini" data-action="queue-list-follows" ${this.listViewLoading ? 'disabled' : ''}>Queue follow all</button>
          </div>
          <div class="muted">${esc(String(this.listView?.uri || ''))}</div>
          ${(Array.isArray(this.listView?.items) && this.listView.items.length)
            ? this.listView.items.map((it) => {
              const subj = it?.subject || it;
              const did = String(subj?.did || '').trim();
              const handle = String(subj?.handle || '').trim();
              const name = String(subj?.displayName || '').trim();
              const label = (name || handle || did || '').trim();
              const prof = did ? bskyProfileUrl(did) : (handle ? bskyProfileUrl(handle) : '');
              return `
                <div class="row">
                  <div class="meta">
                    <div class="title">${esc(label || '(unknown)')}${handle ? ` <span class="muted">@${esc(handle)}</span>` : ''}</div>
                    ${did ? `<div class="tiny muted">${esc(did)}</div>` : ''}
                  </div>
                  <div class="rowActions">
                    ${did ? `<button type="button" class="mini" data-copy="${escAttr(did)}">Copy DID</button>` : ''}
                    ${prof ? `<a class="lnk" href="${escAttr(prof)}" target="_blank" rel="noopener">Open</a>` : ''}
                  </div>
                </div>
              `;
            }).join('')
            : '<div class="muted">No members found.</div>'}
        </div>
      `
      : '';

    const trendingHours = Number(this.trendingHours || (24 * 7));
    const trendingSection = showTrending
      ? `
        <div class="sec">
          <div class="sech">
            <b>Trending</b>
            <span class="pill">${this.trendingLoading ? 'Loading…' : ''}</span>
          </div>

          <div class="toolbar" style="margin:6px 0 10px 0;gap:8px">
            <select name="trendingHours" title="Trending window">
              ${[
                { h: 24, label: '24h' },
                { h: 24 * 3, label: '3d' },
                { h: 24 * 7, label: '7d' },
                { h: 24 * 30, label: '30d' },
              ].map((o) => `<option value="${o.h}" ${trendingHours === o.h ? 'selected' : ''}>${o.label}</option>`).join('')}
            </select>
            <button type="button" class="mini" data-action="refresh-trending" ${this.trendingLoading ? 'disabled' : ''}>Refresh</button>
            <span class="muted">From ${mode === 'network' ? 'network (if available)' : 'cache'}.</span>
          </div>

          ${this.trendingError ? `<div class="err">${esc(this.trendingError)}</div>` : ''}

          <div class="sech" style="margin-top:10px"><b>Hashtags</b><span class="pill">${trendingHashtags.length}</span></div>
          ${trendingHashtags.length ? `
            <div class="pills" role="list" aria-label="Trending hashtags">
              ${trendingHashtags.slice(0, 20).map((t) => {
                const tag = String(t?.tag || '').trim();
                const count = Number(t?.count || 0);
                return `<button type="button" class="pillBtn" role="listitem" data-trend-hashtag="${escAttr(tag)}" title="Search ${escAttr(tag)}">${esc(tag)} <span class="muted">${esc(count)}</span></button>`;
              }).join('')}
            </div>
          ` : '<div class="muted">No trending hashtags yet (sync/backfill posts to improve this).</div>'}

          <div class="sech" style="margin-top:10px"><b>Links</b><span class="pill">${trendingLinks.length}</span></div>
          ${trendingLinks.length ? `
            <div class="pills" role="list" aria-label="Trending links">
              ${trendingLinks.slice(0, 20).map((l) => {
                const host = String(l?.host || '').trim();
                const count = Number(l?.count || 0);
                const sample = String(l?.sampleUrl || '').trim();
                const open = sample && (sample.startsWith('http://') || sample.startsWith('https://')) ? sample : (host ? `https://${host}` : '');
                return `
                  <span style="display:inline-flex;gap:6px;align-items:center">
                    <button type="button" class="pillBtn" data-trend-host="${escAttr(host)}" title="Search ${escAttr(host)}">${esc(host)} <span class="muted">${esc(count)}</span></button>
                    ${open ? `<a class="lnk" href="${escAttr(open)}" target="_blank" rel="noopener" title="Open sample">Open</a>` : ''}
                  </span>
                `;
              }).join('')}
            </div>
          ` : '<div class="muted">No trending links yet (sync/backfill posts to improve this).</div>'}
        </div>
      `
      : '';

    const spTitle = this._starterPackTitle(this.starterPack) || '';
    const spDesc = this._starterPackDesc(this.starterPack) || '';
    const spUri = String(this.starterPack?.uri || '').trim();
    const spWarnings = Array.isArray(this.starterPack?.warnings) ? this.starterPack.warnings : [];
    const spMembers = Array.isArray(this.starterPackMembers) ? this.starterPackMembers : [];
    const spMemberRows = spMembers.slice(0, 100).map((m) => {
      const did = this._memberDid(m);
      const handle = this._memberHandle(m);
      const name = this._memberName(m);
      const label = (name || handle || did || '').trim();
      return `<div class="row">
        <div class="meta">
          <div class="title">${esc(label || '(unknown)')}${handle ? ` <span class="muted">@${esc(handle)}</span>` : ''}</div>
          ${did ? `<div class="tiny muted">${esc(did)}</div>` : ''}
        </div>
        <div class="rowActions">
          ${did ? `<button type="button" class="mini" data-copy="${escAttr(did)}">Copy DID</button>` : ''}
        </div>
      </div>`;
    }).join('') || '<div class="muted">No members loaded yet.</div>';

    const queueStatus = this.starterPackQueue?.status || null;
    const qCounts = queueStatus?.counts || null;
    const queueLine = queueStatus
      ? `<div class="muted">Queue: ${esc(String(qCounts?.pending ?? queueStatus?.pending ?? 0))} pending • ${esc(String(qCounts?.done ?? queueStatus?.done ?? 0))} done • ${esc(String(qCounts?.failed ?? queueStatus?.failed ?? 0))} failed</div>`
      : '';

    const starterPackSection = showTrending
      ? `
        <div class="sec">
          <div class="sech"><b>Starter pack</b><span class="pill">${this.starterPackLoading ? 'Loading…' : ''}</span></div>
          <div class="muted">Paste a starter pack URL/URI to browse members and queue follows (rate-limit friendly).</div>

          <div class="toolbar" style="margin:8px 0 10px 0;gap:8px">
            <input type="text" name="starterPackInput" value="${escAttr(this.starterPackInput)}" placeholder="https://bsky.app/starter-pack/... or at://..." autocomplete="off" spellcheck="false" />
            <button type="button" data-action="load-starter-pack" ${this.starterPackLoading ? 'disabled' : ''}>Load</button>
            <button type="button" data-action="queue-starter-pack-follows" ${this.starterPackLoading || !spMembers.length ? 'disabled' : ''}>Queue follow all</button>
            <button type="button" class="mini" data-action="process-follow-queue" ${this.starterPackLoading ? 'disabled' : ''} title="Process up to 50 queued follows">Run queue</button>
          </div>

          ${this.starterPackError ? `<div class="err">${esc(this.starterPackError)}</div>` : ''}
          ${queueLine}

          ${this.starterPack ? `
            <div class="row">
              <div class="meta">
                <div class="title">${esc(spTitle || 'Starter pack')}</div>
                ${spUri ? `<div class="tiny muted">${esc(spUri)}</div>` : ''}
                ${spDesc ? `<div class="snippet">${esc(spDesc)}</div>` : ''}
                ${spWarnings.length ? `<div class="tiny muted">${esc(spWarnings.join(' • '))}</div>` : ''}
              </div>
            </div>
            <div class="sech" style="margin-top:10px"><b>Members</b><span class="pill">${spMembers.length}</span></div>
            ${spMemberRows}
          ` : ''}
        </div>
      `
      : '';

    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{display:block}

        form{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
        input[type="text"]{flex:1 1 260px;min-width:220px;background:var(--bsky-input-bg,#0f0f0f);color:var(--bsky-fg,#fff);border:1px solid var(--bsky-border,#333);padding:8px 10px;border-radius:var(--bsky-radius,0px)}
        select{background:var(--bsky-input-bg,#0f0f0f);color:var(--bsky-fg,#fff);border:1px solid var(--bsky-border,#333);padding:8px 10px;border-radius:var(--bsky-radius,0px)}
        button{background:var(--bsky-btn-bg,#111);color:var(--bsky-fg,#fff);border:1px solid var(--bsky-border,#333);padding:8px 10px;border-radius:var(--bsky-radius,0px);cursor:pointer}
        button:disabled{opacity:.6;cursor:not-allowed}

        .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
        .targets{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
        .targets label{display:flex;gap:6px;align-items:center;color:var(--bsky-fg,#fff);font-size:.92rem}

        .pills{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
        .pillBtn{padding:6px 10px;font-size:.9rem;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:var(--bsky-surface-2,#0f0f0f)}
        .pillBtn:hover{border-color:#3b5a8f}

        .savedRow{display:flex;gap:12px;justify-content:space-between;align-items:flex-start;border:1px solid var(--bsky-border,#333);background:var(--bsky-bg,#070707);padding:10px;border-radius:var(--bsky-radius,0px);margin:8px 0}
        .savedMeta{min-width:0;flex:1 1 auto}
        .savedTitle{font-weight:800;word-break:break-word}
        .savedSub{font-size:.85rem;margin-top:2px}
        .savedQ{font-size:.86rem;margin-top:6px;word-break:break-word;white-space:pre-wrap}
        .savedActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;flex:0 0 auto}
        .mini.danger{border-color:rgba(255,0,0,.35);color:#ffb3b3}
        .mini.danger:hover{border-color:rgba(255,0,0,.6)}

        .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,Liberation Mono,monospace}

        .err{margin:10px 0;padding:10px;border:1px solid #5a2a2a;background:#1a0b0b;color:#ffb3b3}
        .muted{color:var(--bsky-muted,#aaa)}

        .sec{margin-top:12px}
        .sech{display:flex;justify-content:space-between;align-items:baseline;gap:10px;border-bottom:1px solid rgba(255,255,255,.10);padding-bottom:6px;margin-bottom:8px}
        .sech b{font-size:1.0rem}
        .pill{font-size:.85rem;color:#bbb}

        .row{display:flex;gap:12px;justify-content:space-between;align-items:flex-start;border:1px solid var(--bsky-border,#333);background:var(--bsky-surface-2,#0f0f0f);padding:10px;border-radius:var(--bsky-radius,0px);margin:8px 0}
        .rowMain{display:flex;gap:10px;align-items:flex-start;min-width:0;flex:1 1 auto}
        .meta{min-width:0;flex:1 1 auto}
        .title{font-weight:800;word-break:break-word}
        .sub{font-size:.9rem;color:#bbb;margin-top:2px}
        .snippet{margin-top:6px;color:#ddd;white-space:pre-wrap;word-break:break-word}
        .tiny{font-size:.78rem}

        .kfWrap{margin-top:10px;border-top:1px solid rgba(255,255,255,.10);padding-top:8px}
        .kf{font-size:.9rem}
        .kf.err{color:#ffb3b3}
        .kfLine{font-size:.86rem}
        .kfList{display:flex;flex-direction:column;gap:6px;margin-top:6px}
        .kfItem{display:flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);padding:6px 8px;border-radius:var(--bsky-radius,0px)}
        .kfAv{width:26px;height:26px;border-radius:var(--bsky-radius,0px);background:#222;object-fit:cover;flex:0 0 auto}
        .kfAv.ph{display:inline-block}
        .kfMeta{min-width:0;flex:1 1 auto}
        .kfTitle{font-weight:800;word-break:break-word;font-size:.9rem}
        .kfSub{font-size:.82rem}
        .rowActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;flex:0 0 auto}
        .mini{padding:6px 8px;font-size:.85rem}
        .lnk{color:var(--bsky-link,#9cd3ff);text-decoration:none;border:1px solid rgba(255,255,255,.15);padding:6px 8px;border-radius:var(--bsky-radius,0px)}

        .av{width:36px;height:36px;border-radius:var(--bsky-radius,0px);background:#222;object-fit:cover;flex:0 0 auto}
        .av.ph{display:inline-block}
      </style>

      <bsky-panel-shell dense title="Search" persist-key="search">
        <div slot="toolbar" class="toolbar">
          <form data-search>
            <input type="text" name="q" value="${escAttr(q)}" placeholder="Search people, posts, feeds…" autocomplete="off" spellcheck="false" />
            <select name="mode" title="Search mode">
              <option value="network" ${mode === 'network' ? 'selected' : ''}>Network</option>
              <option value="cache" ${mode === 'cache' ? 'selected' : ''}>Cache</option>
            </select>
            <select name="limit" title="Per-target limit">
              ${[10, 25, 50, 100].map((n) => `<option value="${n}" ${limit === n ? 'selected' : ''}>${n}/target</option>`).join('')}
            </select>
            <button type="submit" data-action="run" ${this.loading ? 'disabled' : ''}>Search</button>
            <button type="button" data-action="clear" ${this.loading ? 'disabled' : ''}>Clear</button>
            <button type="button" data-action="save-search" ${this.loading ? 'disabled' : ''} title="Save this query">Save…</button>
            <button type="button" data-action="pin-current" ${this.loading ? 'disabled' : ''} title="Pin/unpin this query">${pinnedNow ? 'Unpin current' : 'Pin current'}</button>
          </form>

          <div class="targets" role="group" aria-label="Search targets">
            <label><input type="checkbox" data-target="people" ${tgt('people') ? 'checked' : ''} ${this.loading ? 'disabled' : ''}> People</label>
            <label><input type="checkbox" data-target="posts" ${tgt('posts') ? 'checked' : ''} ${this.loading ? 'disabled' : ''}> Posts</label>
            <label><input type="checkbox" data-target="feeds" ${tgt('feeds') ? 'checked' : ''} ${this.loading ? 'disabled' : ''}> Feeds</label>
            <label><input type="checkbox" data-target="lists" ${tgt('lists') ? 'checked' : ''} ${this.loading ? 'disabled' : ''}> Lists</label>
            ${this.loading ? '<span class="muted">Loading…</span>' : ''}
          </div>
        </div>

        ${this.error ? `<div class="err">${esc(this.error)}</div>` : ''}
        ${mode === 'cache' ? '<div class="muted">Cache mode searches your local SQLite cache (fast, but not global).</div>' : ''}

        ${trendingSection}

        ${starterPackSection}

  ${actorListsSection}

  ${listViewSection}

        <div class="sec">
          <div class="sech"><b>Pinned</b><span class="pill">${pinned.length}</span></div>
          ${pills}
        </div>

        <div class="sec">
          <div class="sech"><b>Saved searches</b><span class="pill">${savedSorted.length}</span></div>
          ${savedRows}
        </div>

        <div class="sec">
          <div class="sech"><b>People</b><span class="pill">${people.length}</span></div>
          ${peopleRows}
        </div>

        <div class="sec">
          <div class="sech"><b>Posts</b><span class="pill">${posts.length}</span></div>
          ${postRows}
        </div>

        <div class="sec">
          <div class="sech"><b>Feeds</b><span class="pill">${feeds.length}</span></div>
          ${feedRows}
        </div>

        <div class="sec">
          <div class="sech"><b>Lists</b><span class="pill">${lists.length}</span></div>
          ${listRows}
        </div>
      </bsky-panel-shell>
    `;
  }
}

customElements.define('bsky-search-panel', BskySearchPanel);
