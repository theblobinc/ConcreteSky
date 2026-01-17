import { call } from '../../../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../../../auth_state.js';
import { identityCss, identityHtml, bindCopyClicks, toProfileUrl } from '../../../lib/identity.js';
import { queueProfiles } from '../../../profile_hydrator.js';
import { bindInfiniteScroll, captureScrollAnchor, applyScrollAnchor } from '../../panel_api.js';
import { BSKY_SEARCH_EVENT } from '../../../search/search_bus.js';
import { SEARCH_TARGETS } from '../../../search/constants.js';
import { compileSearchMatcher } from '../../../search/query.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[m]));

function safeDate(iso) {
  try {
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? d : null;
  } catch {
    return null;
  }
}

function daysSince(iso) {
  const d = safeDate(iso);
  if (!d) return null;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

class BskyConnections extends HTMLElement {
  constructor(){
    super();
    this.attachShadow({mode:'open'});
    this.loading = false;
    this.error = null;
    this.items = [];
    this.total = 0;
    this.offset = 0;
    this.limit = 100;
    this.hasMore = false;

    this.filters = {
      q: '',
      sort: 'followers',
      onlyMutuals: false,
      showFollowers: true,
      showFollowing: true,
    };

    this._unbindInfiniteScroll = null;
    this._infiniteScrollEl = null;

    this._restoreScrollNext = false;
    this._scrollAnchor = null;
    this._scrollTop = 0;


    this._qTimer = null;

    this._hudPrevQ = null;
    this._hudSearchSpec = null;
    this._hudMatcher = null;
    this._onSearchChanged = null;

    this._hudNetworkActive = false;

    this._onProfilesHydrated = null;
    this._hydratedDidSet = new Set();
    this._hydratedTimer = null;
  }

  _scheduleMergeHydrated(dids) {
    try {
      for (const did of (dids || [])) this._hydratedDidSet.add(String(did));
    } catch {}
    if (this._hydratedTimer) return;
    this._hydratedTimer = setTimeout(() => {
      this._hydratedTimer = null;
      const list = Array.from(this._hydratedDidSet);
      this._hydratedDidSet.clear();
      this._mergeHydratedProfiles(list).catch(() => {});
    }, 150);
  }

  async _mergeHydratedProfiles(dids) {
    const want = new Set((this.items || []).map((p) => p?.did).filter(Boolean));
    const intersect = (dids || []).map(String).filter((d) => want.has(d));
    if (!intersect.length) return;

    const res = await call('cacheGetProfiles', { dids: intersect, max: 200 });
    const profiles = Array.isArray(res?.profiles) ? res.profiles : [];
    if (!profiles.length) return;

    const byDid = new Map(profiles.map((p) => [p.did, p]));
    this.items = (this.items || []).map((it) => {
      const p = it?.did ? byDid.get(it.did) : null;
      if (!p) return it;
      return {
        ...it,
        handle: it.handle || p.handle || '',
        displayName: it.displayName || p.displayName || '',
        avatar: it.avatar || p.avatar || '',
        description: it.description || p.description || '',
        createdAt: it.createdAt || p.createdAt || '',
        followersCount: p.followersCount ?? it.followersCount,
        followsCount: p.followsCount ?? it.followsCount,
        postsCount: p.postsCount ?? it.postsCount,
      };
    });
    this.render();
  }

  _applyHudPeopleFilters(spec) {
    try {
      const f = spec?.filters?.people || {};
      const list = String(f?.list || 'all');
      const sort = String(f?.sort || 'followers');
      const mutual = !!f?.mutual;

      if (list === 'followers') {
        this.filters.showFollowers = true;
        this.filters.showFollowing = false;
      } else if (list === 'following') {
        this.filters.showFollowers = false;
        this.filters.showFollowing = true;
      } else {
        this.filters.showFollowers = true;
        this.filters.showFollowing = true;
      }

      if (['followers','following','posts','age','name','handle'].includes(sort)) {
        this.filters.sort = sort;
      }
      this.filters.onlyMutuals = mutual;
    } catch {
      // ignore
    }
  }

  async _loadNetworkPeopleSearch(q) {
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    this._hudNetworkActive = true;
    this.render();

    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this.items = [];
        this.total = 0;
        this.offset = 0;
        this.hasMore = false;
        this.error = 'Not connected. Use the Connect button.';
        return;
      }

      const res = await call('search', {
        q,
        mode: 'network',
        targets: ['people'],
        limit: this.limit,
      });

      const actors = Array.isArray(res?.results?.people) ? res.results.people : [];
      const mapped = actors.map((a) => ({
        did: a.did || '',
        handle: a.handle || '',
        displayName: a.displayName || a.display_name || '',
        avatar: a.avatar || '',
        description: a.description || '',
        createdAt: a.createdAt || a.created_at || '',
        followersCount: a.followersCount ?? a.followers_count,
        followsCount: a.followsCount ?? a.follows_count,
        postsCount: a.postsCount ?? a.posts_count,
      })).filter((x) => x.did || x.handle);

      this.items = mapped;
      this.total = mapped.length;
      this.offset = mapped.length;
      this.hasMore = false;

      try {
        queueProfiles(mapped.map(p => p?.did).filter(Boolean));
      } catch {}
    } catch (e) {
      this.error = isNotConnectedError(e) ? 'Not connected. Use the Connect button.' : e.message;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  _cssPx(varName, fallback) {
    try {
      const raw = getComputedStyle(this).getPropertyValue(varName);
      const n = Number.parseFloat(String(raw || ''));
      return Number.isFinite(n) ? n : fallback;
    } catch {
      return fallback;
    }
  }

  connectedCallback(){
    this.render();
    if (this._unbindInfiniteScroll) { try { this._unbindInfiniteScroll(); } catch {} this._unbindInfiniteScroll = null; }
    this._infiniteScrollEl = null;
    this.load(true);
    bindCopyClicks(this.shadowRoot);
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
    this.shadowRoot.addEventListener('input', (e) => this.onInput(e));
    this.shadowRoot.addEventListener('change', (e) => this.onChange(e));

    if (!this._onSearchChanged) {
      this._onSearchChanged = (e) => {
        const spec = e?.detail || null;
        const targets = Array.isArray(spec?.targets) ? spec.targets : [];
        const isTargeted = targets.includes(SEARCH_TARGETS.PEOPLE);

        if (!isTargeted) {
          // If HUD previously overrode the panel query, restore it.
          if (this._hudPrevQ !== null) {
            this.filters.q = String(this._hudPrevQ || '');
            this._hudPrevQ = null;
            this._hudSearchSpec = null;
            this._hudMatcher = null;
            this._hudNetworkActive = false;
            this.load(true);
          }
          return;
        }

        const q = String(spec?.query || '').trim();
        this._applyHudPeopleFilters(spec);
        if (q.length < 2) {
          if (this._hudPrevQ !== null) {
            this.filters.q = String(this._hudPrevQ || '');
            this._hudPrevQ = null;
          }
          this._hudSearchSpec = null;
          this._hudMatcher = null;
          this._hudNetworkActive = false;
          this.load(true);
          return;
        }

        if (this._hudPrevQ === null) this._hudPrevQ = String(this.filters.q || '');
        this.filters.q = q;
        this._hudSearchSpec = spec;
        try {
          this._hudMatcher = compileSearchMatcher(spec.parsed);
        } catch {
          this._hudMatcher = null;
        }
        if (String(spec?.mode || 'cache') === 'network') {
          this._loadNetworkPeopleSearch(q);
        } else {
          this._hudNetworkActive = false;
          this.load(true);
        }
      };
      window.addEventListener(BSKY_SEARCH_EVENT, this._onSearchChanged);
    }

    if (!this._onProfilesHydrated) {
      this._onProfilesHydrated = (e) => {
        const dids = Array.isArray(e?.detail?.dids) ? e.detail.dids : [];
        if (!dids.length) return;
        this._scheduleMergeHydrated(dids);
      };
      window.addEventListener('bsky-profiles-hydrated', this._onProfilesHydrated);
    }
  }

  disconnectedCallback(){
    if (this._unbindInfiniteScroll) { try { this._unbindInfiniteScroll(); } catch {} this._unbindInfiniteScroll = null; }
    this._infiniteScrollEl = null;

    if (this._onSearchChanged) {
      try { window.removeEventListener(BSKY_SEARCH_EVENT, this._onSearchChanged); } catch {}
      this._onSearchChanged = null;
    }

    if (this._onProfilesHydrated) {
      try { window.removeEventListener('bsky-profiles-hydrated', this._onProfilesHydrated); } catch {}
      this._onProfilesHydrated = null;
    }
    if (this._hydratedTimer) { try { clearTimeout(this._hydratedTimer); } catch {} this._hydratedTimer = null; }
    this._hydratedDidSet?.clear?.();
  }

  onClick(e){
    if (e.target.closest('#refresh')) { this.load(true); return; }
    if (e.target.closest('#more')) { this.load(false); return; }
    if (e.target.closest('#sync')) { this.sync(); return; }
  }

  onInput(e){
    if (e.target.id === 'q') {
      this.filters.q = e.target.value;
      // Debounce to avoid querying the DB on every keystroke.
      if (this._qTimer) clearTimeout(this._qTimer);
      this._qTimer = setTimeout(() => {
        this._qTimer = null;
        this.load(true);
      }, 220);
    }
  }

  onChange(e){
    if (e.target.id === 'sort') {
      this.filters.sort = e.target.value;
      this.load(true);
    }
    if (e.target.id === 'only-mutuals') {
      this.filters.onlyMutuals = !!e.target.checked;
      this.load(true);
    }

    if (e.target.id === 'show-followers') {
      this.filters.showFollowers = !!e.target.checked;
      if (!this.filters.showFollowers && !this.filters.showFollowing) this.filters.showFollowing = true;
      this.load(true);
    }
    if (e.target.id === 'show-following') {
      this.filters.showFollowing = !!e.target.checked;
      if (!this.filters.showFollowers && !this.filters.showFollowing) this.filters.showFollowers = true;
      this.load(true);
    }

    if (e.target.id === 'view') {
      this.render();
    }
  }

  listMode(){
    if (this.filters.showFollowers && this.filters.showFollowing) return 'all';
    if (this.filters.showFollowers) return 'followers';
    return 'following';
  }

  async sync(){
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    this.render();
    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this.error = 'Not connected. Use the Connect button.';
        return;
      }
      for (;;) {
        try {
          await call('cacheSync', { kind: 'both', mode: 'force', pagesMax: 80 });
          break;
        } catch (e) {
          const isRate = (e && (e.status === 429 || e.code === 'RATE_LIMITED' || e.name === 'RateLimitError'))
            || /\bHTTP\s*429\b/i.test(String(e?.message || ''));
          if (!isRate) throw e;
          const sec = Number.isFinite(e?.retryAfterSeconds) ? e.retryAfterSeconds : null;
          const waitSec = Number.isFinite(sec) ? Math.min(3600, Math.max(1, sec)) : 10;
          this.error = `Rate limited. Waiting ${waitSec}s…`;
          this.render();
          await new Promise((r) => setTimeout(r, waitSec * 1000));
        }
      }
      await this.load(true);
    } catch (e) {
      this.error = isNotConnectedError(e) ? 'Not connected. Use the Connect button.' : e.message;
      this.loading = false;
      this.render();
    }
  }

  async load(reset){
    if (this._hudNetworkActive) {
      // Network search results are non-paginated in this panel.
      this.hasMore = false;
      this.loading = false;
      this.render();
      return;
    }
    if (window.BSKY?.cacheAvailable === false) {
      this.error = 'SQLite cache is unavailable on the server (pdo_sqlite missing or disabled).';
      this.loading = false;
      this.render();
      return;
    }
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    if (reset) {
      this.items = [];
      this.offset = 0;
      this._restoreScrollNext = false;
    }
    if (!reset) this._restoreScrollNext = true;
    this.render();

    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this.items = [];
        this.total = 0;
        this.offset = 0;
        this.hasMore = false;
        this.error = 'Not connected. Use the Connect button.';
        return;
      }

      let data;
      for (;;) {
        try {
          data = await call('cacheQueryPeople', {
            list: this.listMode(),
            q: this.filters.q,
            sort: this.filters.sort,
            mutual: this.filters.onlyMutuals,
            limit: this.limit,
            offset: this.offset,
          });
          break;
        } catch (e) {
          const isRate = (e && (e.status === 429 || e.code === 'RATE_LIMITED' || e.name === 'RateLimitError'))
            || /\bHTTP\s*429\b/i.test(String(e?.message || ''));
          if (!isRate) throw e;
          const sec = Number.isFinite(e?.retryAfterSeconds) ? e.retryAfterSeconds : null;
          const waitSec = Number.isFinite(sec) ? Math.min(3600, Math.max(1, sec)) : 10;
          this.error = `Rate limited. Waiting ${waitSec}s…`;
          this.render();
          await new Promise((r) => setTimeout(r, waitSec * 1000));
        }
      }

      const batch = Array.isArray(data.items) ? data.items : [];
      if (reset) this.items = batch;
      else this.items.push(...batch);

      this.total = Number(data.total || 0);
      this.hasMore = !!data.hasMore;
      this.offset = this.items.length;

      // Background profile hydration: fill follower/following/posts counts.
      try {
        queueProfiles(batch.map(p => p?.did).filter(Boolean));
      } catch {}
    } catch (e) {
      this.error = isNotConnectedError(e) ? 'Not connected. Use the Connect button.' : e.message;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  render(){
    // Preserve scroll position across re-renders.
    try {
      const prevScroller = this.shadowRoot.querySelector('bsky-panel-shell')?.getScroller?.();
      if (prevScroller) {
        this._scrollTop = prevScroller.scrollTop || 0;
        if (this._restoreScrollNext) {
          this._scrollAnchor = captureScrollAnchor({
            scroller: prevScroller,
            root: this.shadowRoot,
            itemSelector: '.entry[data-did]',
            keyAttr: 'data-did',
          });
        }
      }
    } catch {}

    const orderedRaw = (this.items || []);
    const hudQ = String(this._hudSearchSpec?.query || '').trim();
    const hudMatcher = this._hudMatcher;
    const ordered = (hudMatcher && hudQ.length >= 2)
      ? orderedRaw.filter((p) => {
          try {
            const text = [p.displayName, p.handle ? `@${p.handle}` : '', p.description].filter(Boolean).join(' ');
            const fields = {
              did: p.did || '',
              handle: p.handle || '',
              displayName: p.displayName || '',
              description: p.description || '',
            };
            return !!hudMatcher(text, fields);
          } catch {
            return true;
          }
        })
      : orderedRaw;

    const rows = ordered.map((p) => {
      const ageDays = daysSince(p.createdAt);
      const key = String(p.did || '');
      return {
        key,
        html: `
        <div class="entry" data-did="${esc(key)}">
          <bsky-lazy-img class="av" src="${esc(p.avatar || '')}" alt="" aspect="1/1"></bsky-lazy-img>
          <div class="main">
            <div class="top">
              ${identityHtml({ did: p.did, handle: p.handle, displayName: p.displayName }, { showHandle: false, showCopyDid: true })}
            </div>
            <div class="sub">${p.handle ? `<a href="${esc(toProfileUrl({ handle: p.handle, did: p.did }))}" target="_blank" rel="noopener">@${esc(p.handle)}</a>` : ''}</div>
            ${p.description ? `<div class="bio">${esc(p.description)}</div>` : ``}
            <div class="meta">
              <span>Followers: ${esc(p.followersCount ?? '—')}</span>
              <span>Following: ${esc(p.followsCount ?? '—')}</span>
              <span>Posts: ${esc(p.postsCount ?? '—')}</span>
              <span>Age: ${ageDays === null ? '—' : `${ageDays}d`}</span>
            </div>
          </div>
        </div>
      `
      };
    });

    const rowsHtml = rows.map(r => r.html).join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{display:block;margin:0;--bsky-connections-ui-offset:290px}
        .muted{color:#aaa}
        .muted{color:#aaa}
        .controls{display:flex;gap:var(--bsky-panel-control-gap-dense, 6px);flex-wrap:wrap;align-items:center}
        input,select{background:#0f0f0f;color:#fff;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:8px 10px}
        label{color:#ddd;font-size:.95rem;display:flex;gap:6px;align-items:center}
        button{background:#111;border:1px solid #555;color:#fff;padding:8px 10px;border-radius: var(--bsky-radius, 0px);cursor:pointer}
        button:disabled{opacity:.6;cursor:not-allowed}

        .entries{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--bsky-card-min-w, 350px),1fr));gap:var(--bsky-card-gap, var(--bsky-grid-gutter, 0px));align-items:start;max-width:100%;min-height:0}

        .entry{display:flex;gap:8px;border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:5px;background:#0f0f0f;width:100%;max-width:100%;min-width:0}
        .av{width:40px;height:40px;border-radius: var(--bsky-radius, 0px);background:#222;object-fit:cover;flex:0 0 auto}
        .main{min-width:0;flex:1}
        .top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .sub{color:#bbb;font-size:.9rem;margin-top:2px}
        .sub a{color:#bbb;text-decoration:underline}
        /* Clamp bio to reduce height variance (less empty space between cards). */
        .bio{color:#ddd;margin-top:6px;word-break:break-word;white-space:normal;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3}
        .meta{color:#bbb;font-size:.85rem;margin-top:6px;display:flex;gap:10px;flex-wrap:wrap}
        .err{color:#f88}
        ${identityCss}

        @media (max-width: 380px){
          .wrap{padding:8px}
        }
      </style>
      <bsky-panel-shell title="Connections" dense style="--bsky-panel-ui-offset: var(--bsky-connections-ui-offset)">
        <div slot="head-right" class="muted">Showing: ${esc(ordered.length)} · Loaded: ${esc(this.items.length)} / ${esc(this.total)}</div>

        <div slot="toolbar" class="controls">
          <input id="q" type="search" placeholder="Search (name/handle/bio)…" value="${esc(this.filters.q)}">
          <select id="sort">
            <option value="followers" ${this.filters.sort==='followers'?'selected':''}>Sort: followers</option>
            <option value="following" ${this.filters.sort==='following'?'selected':''}>Sort: following</option>
            <option value="posts" ${this.filters.sort==='posts'?'selected':''}>Sort: posts</option>
            <option value="age" ${this.filters.sort==='age'?'selected':''}>Sort: account age</option>
            <option value="name" ${this.filters.sort==='name'?'selected':''}>Sort: name</option>
            <option value="handle" ${this.filters.sort==='handle'?'selected':''}>Sort: handle</option>
          </select>
          <label><input id="show-followers" type="checkbox" ${this.filters.showFollowers?'checked':''}> followers</label>
          <label><input id="show-following" type="checkbox" ${this.filters.showFollowing?'checked':''}> following</label>
          <label><input id="only-mutuals" type="checkbox" ${this.filters.onlyMutuals?'checked':''}> mutuals only</label>

          <button id="sync" ${this.loading?'disabled':''}>Sync cache</button>
          <button id="refresh" ${this.loading?'disabled':''}>Reload</button>
          <button id="more" ${this.loading || !this.hasMore ? 'disabled' : ''}>Load more</button>
        </div>

        ${this.error ? `<div class="err">Error: ${esc(this.error)}</div>` : ''}

        <div class="entries">
          ${rowsHtml || (this.loading ? '<div class="muted">Loading…</div>' : '<div class="muted">No connections loaded.</div>')}
        </div>
      </bsky-panel-shell>
    `;

    // Restore scroll after DOM rebuild.
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        const scroller = this.shadowRoot.querySelector('bsky-panel-shell')?.getScroller?.();
        if (!scroller) return;
        if (this._restoreScrollNext && this._scrollAnchor) {
          applyScrollAnchor({ scroller, root: this.shadowRoot, anchor: this._scrollAnchor, keyAttr: 'data-did' });
          setTimeout(() => applyScrollAnchor({ scroller, root: this.shadowRoot, anchor: this._scrollAnchor, keyAttr: 'data-did' }), 160);
        } else {
          scroller.scrollTop = Math.max(0, this._scrollTop || 0);
        }
        this._restoreScrollNext = false;
        this._scrollAnchor = null;
      });
    });

    // Infinite scroll: load the next page when nearing the bottom (de-duped across renders).
    const scroller = this.shadowRoot.querySelector('bsky-panel-shell')?.getScroller?.();
    if (scroller && scroller !== this._infiniteScrollEl) {
      try { this._unbindInfiniteScroll?.(); } catch {}
      this._infiniteScrollEl = scroller;
      this._unbindInfiniteScroll = bindInfiniteScroll(scroller, () => this.load(false), {
        threshold: 220,
        enabled: () => true,
        isLoading: () => !!this.loading,
        hasMore: () => !!this.hasMore,
        cooldownMs: 250,
        anchor: {
          getRoot: () => this.shadowRoot,
          itemSelector: '.entry[data-did]',
          keyAttr: 'data-did',
        },
        // Avoid auto-fetching every page on open ("fill the viewport" loop).
        initialTick: false,
      });
    }
  }
}

customElements.define('bsky-connections', BskyConnections);
