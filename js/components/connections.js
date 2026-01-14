import { call } from '../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../auth_state.js';
import { identityCss, identityHtml, bindCopyClicks, toProfileUrl } from '../lib/identity.js';
import { queueProfiles } from '../profile_hydrator.js';
// Versioned import to bust aggressive browser module cache when MagicGrid changes.
import MagicGrid from '../magicgrid/magic-grid.esm.js?v=0.1.28';

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

    // Single layout mode: MagicGrid.
    this.view = 'magic';
    this.filters = {
      q: '',
      sort: 'followers',
      onlyMutuals: false,
      showFollowers: true,
      showFollowing: true,
    };
    this._magic = null;
    this._magicRO = null;
  }

  connectedCallback(){
    this.render();
    this.load(true);
    bindCopyClicks(this.shadowRoot);
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
    this.shadowRoot.addEventListener('input', (e) => this.onInput(e));
    this.shadowRoot.addEventListener('change', (e) => this.onChange(e));
  }

  disconnectedCallback(){
    if (this._magicRO) { try { this._magicRO.disconnect(); } catch {} this._magicRO = null; }
    this._magic = null;
  }

  ensureMagicGrid(){
    if (this.view !== 'magic') {
      if (this._magicRO) { try { this._magicRO.disconnect(); } catch {} this._magicRO = null; }
      this._magic = null;
      return;
    }

    const host = this.shadowRoot.querySelector('.list.magic');
    if (!host) return;

    if (!this._magic) {
      try {
        this._magic = new MagicGrid({
          container: host,
          static: true,
          gutter: 12,
          useTransform: false,
          animate: false,
          center: false,
          maxColumns: false,
          useMin: false,
          itemWidth: 350,
        });
      } catch {
        this._magic = null;
      }
    } else {
      try { this._magic.setContainer(host); } catch {}
    }

    try { this._magic?.positionItems?.(); } catch {}

    if (!this._magicRO) {
      try {
        this._magicRO = new ResizeObserver(() => {
          try { this._magic?.positionItems?.(); } catch {}
        });
        this._magicRO.observe(host);
      } catch {
        this._magicRO = null;
      }
    }
  }

  onClick(e){
    if (e.target.closest('#refresh')) { this.load(true); return; }
    if (e.target.closest('#more')) { this.load(false); return; }
    if (e.target.closest('#sync')) { this.sync(); return; }
  }

  onInput(e){
    if (e.target.id === 'q') {
      this.filters.q = e.target.value;
      this.load(true);
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
      // Force MagicGrid regardless of selection (back-compat for stored values).
      this.view = 'magic';
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
      await call('cacheSync', { kind: 'both', mode: 'force', pagesMax: 80 });
      await this.load(true);
    } catch (e) {
      this.error = isNotConnectedError(e) ? 'Not connected. Use the Connect button.' : e.message;
      this.loading = false;
      this.render();
    }
  }

  async load(reset){
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
    }
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

      const data = await call('cacheQueryPeople', {
        list: this.listMode(),
        q: this.filters.q,
        sort: this.filters.sort,
        mutual: this.filters.onlyMutuals,
        limit: this.limit,
        offset: this.offset,
      });

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
    const ordered = (this.items || []);

    const rows = ordered.map((p) => {
      const ageDays = daysSince(p.createdAt);
      const key = String(p.did || '');
      return {
        key,
        html: `
        <div class="row" data-did="${esc(key)}">
          <img class="av" src="${esc(p.avatar || '')}" alt="" onerror="this.style.display='none'">
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
        .wrap{border:1px solid #333;border-radius:12px;padding:10px;background:#070707;color:#fff}
        .head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
        .title{font-weight:800}
        .muted{color:#aaa}
        .controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
        input,select{background:#0f0f0f;color:#fff;border:1px solid #333;border-radius:10px;padding:8px 10px}
        label{color:#ddd;font-size:.95rem;display:flex;gap:6px;align-items:center}
        button{background:#111;border:1px solid #555;color:#fff;padding:8px 10px;border-radius:10px;cursor:pointer}
        button:disabled{opacity:.6;cursor:not-allowed}

        .listWrap{width:100%;max-height:calc(100vh - var(--bsky-connections-ui-offset));overflow:auto;padding-right:4px}
        .list{display:block;gap:12px;justify-content:start;align-items:start}
        /* MagicGrid: absolute-positioned cards. */
        .list.magic{position:relative;display:block;width:100%;min-height:0}
        /* Fixed card width so MagicGrid can lay out multiple columns; clamp for very narrow panels. */
        .list.magic .row{width:350px;max-width:350px;margin:0}

        .row{display:flex;gap:10px;border:1px solid #333;border-radius:12px;padding:10px;background:#0f0f0f;width:min(350px, 100%);max-width:350px}
        .av{width:40px;height:40px;border-radius:50%;background:#222;object-fit:cover;flex:0 0 auto}
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
      <div class="wrap">
        <div class="head">
          <div class="title">Connections</div>
          <div class="muted">Loaded: ${esc(this.items.length)} / ${esc(this.total)}</div>
        </div>

        <div class="controls">
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
        <div class="listWrap">
          <div class="list magic">
            ${rowsHtml || (this.loading ? '<div class="muted">Loading…</div>' : '<div class="muted">No connections loaded.</div>')}
          </div>
        </div>
      </div>
    `;

    queueMicrotask(() => this.ensureMagicGrid());
  }
}

customElements.define('bsky-connections', BskyConnections);
