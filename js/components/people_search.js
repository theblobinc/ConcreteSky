import { call } from '../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../auth_state.js';
import { identityCss, identityHtml, bindCopyClicks, toProfileUrl } from '../lib/identity.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) =>
  ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[m])
);

function fuzzyMatch(query, text) {
  const q = String(query || '').trim();
  if (!q) return true;
  const t = String(text || '');
  let i = 0;
  for (const ch of q) {
    i = t.toLowerCase().indexOf(ch.toLowerCase(), i);
    if (i === -1) return false;
    i++;
  }
  return true;
}

class BskyPeopleSearch extends HTMLElement {
  constructor(){
    super();
    this.attachShadow({mode:'open'});
    this.loading = false;
    this.error = null;
    this.cursor = null;
    this.q = '';
    this.items = [];
    this.mode = 'cache'; // 'cache' | 'network'
    this.total = 0;
    this.offset = 0;
    this.limit = 100;
    this.hasMore = false;
  }

  connectedCallback(){
    this.render();
    bindCopyClicks(this.shadowRoot);
    this.shadowRoot.addEventListener('submit', (e) => this.onSubmit(e));
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
    this.shadowRoot.addEventListener('input', (e) => this.onInput(e));
  }

  onInput(e){
    if (e.target.id === 'q') {
      this.q = e.target.value;
      // local filter only (no network) so typing is instant
      this.render();
    }
  }

  onClick(e){
    if (e.target.closest('#more')) {
      this.search(false);
      return;
    }
    if (e.target.closest('#sync')) {
      this.sync();
      return;
    }
  }

  onSubmit(e){
    e.preventDefault();
    this.search(true);
  }

  async sync(){
    if (window.BSKY?.cacheAvailable === false) {
      this.error = 'SQLite cache is unavailable on the server (pdo_sqlite missing or disabled).';
      this.render();
      return;
    }
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
      await call('cacheSync', { kind: 'both', mode: 'force', pagesMax: 50 });
    } catch (e) {
      this.error = isNotConnectedError(e) ? 'Not connected. Use the Connect button.' : e.message;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  async search(reset){
    const q = String(this.q || '').trim();
    if (!q) {
      this.items = [];
      this.cursor = null;
      this.error = null;
      this.render();
      return;
    }

    if (this.loading) return;
    this.loading = true;
    this.error = null;
    if (reset) {
      this.items = [];
      this.cursor = null;
      this.offset = 0;
    }
    this.render();

    try {
      const auth = await getAuthStatusCached();
      if (!auth?.connected) {
        this.error = 'Not connected. Use the Connect button.';
        return;
      }

      if (this.mode === 'cache' && window.BSKY?.cacheAvailable === false) {
        this.mode = 'network';
        this.error = 'SQLite cache unavailable on server; switched to live search.';
      }

      if (this.mode === 'network') {
        const res = await call('searchActors', { q, limit: 50, cursor: reset ? null : (this.cursor || null) });
        const batch = Array.isArray(res.actors) ? res.actors : [];
        this.items.push(...batch);
        this.cursor = res.cursor || null;
        this.total = this.items.length;
        this.hasMore = !!this.cursor;
      } else {
        const res = await call('cacheQueryPeople', {
          list: 'all',
          q,
          sort: 'followers',
          mutual: false,
          limit: this.limit,
          offset: this.offset,
        });
        const batch = Array.isArray(res.items) ? res.items : [];
        if (reset) this.items = batch;
        else this.items.push(...batch);
        this.total = Number(res.total || 0);
        this.hasMore = !!res.hasMore;
        this.offset = this.items.length;
      }
    } catch (e) {
      this.error = isNotConnectedError(e) ? 'Not connected. Use the Connect button.' : e.message;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  filteredItems(){
    const q = String(this.q || '').trim();
    if (!q) return [];
    return this.items.filter(a => {
      const hay = `${a.displayName || ''} ${a.handle || ''} ${a.description || ''}`;
      return fuzzyMatch(q, hay);
    });
  }

  render(){
    const q = String(this.q || '');
    const rows = this.filteredItems().map(a => {
      return `
        <div class="row">
          <img class="av" src="${esc(a.avatar || '')}" alt="" onerror="this.style.display='none'">
          <div class="main">
            <div class="top">
              ${identityHtml({ did: a.did, handle: a.handle, displayName: a.displayName }, { showHandle: false, showCopyDid: true })}
            </div>
            <div class="sub">${a.handle ? `<a href="${esc(toProfileUrl({ handle: a.handle, did: a.did }))}" target="_blank" rel="noopener">@${esc(a.handle)}</a>` : ''}</div>
            ${a.description ? `<div class="bio">${esc(a.description)}</div>` : ``}
            <div class="meta">
              <span>Followers: ${esc(a.followersCount ?? '—')}</span>
              <span>Following: ${esc(a.followsCount ?? '—')}</span>
              <span>Posts: ${esc(a.postsCount ?? '—')}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block}
        .wrap{border:1px solid #333;border-radius:12px;padding:10px;background:#070707;color:#fff}
        .head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
        .title{font-weight:800}
        .muted{color:#aaa}
        form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
        input{background:#0f0f0f;color:#fff;border:1px solid #333;border-radius:10px;padding:10px 12px;min-width:min(520px, 100%)}
        select{background:#0f0f0f;color:#fff;border:1px solid #333;border-radius:10px;padding:10px 12px}
        button{background:#111;border:1px solid #555;color:#fff;padding:10px 12px;border-radius:10px;cursor:pointer}
        button:disabled{opacity:.6;cursor:not-allowed}
        .list{display:flex;flex-direction:column;gap:10px}
        .row{display:flex;gap:10px;border:1px solid #333;border-radius:12px;padding:10px;background:#0f0f0f}
        .av{width:40px;height:40px;border-radius:50%;background:#222;object-fit:cover;flex:0 0 auto}
        .main{min-width:0;flex:1}
        .name{color:#fff;text-decoration:underline;font-weight:700}
        .sub{color:#bbb;font-size:.9rem;margin-top:2px}
        .sub a{color:#bbb;text-decoration:underline}
        .bio{color:#ddd;margin-top:6px;white-space:pre-wrap;word-break:break-word}
        .meta{color:#bbb;font-size:.85rem;margin-top:6px;display:flex;gap:10px;flex-wrap:wrap}
        .err{color:#f88}
        ${identityCss}
      </style>
      <div class="wrap">
        <div class="head">
          <div class="title">Search</div>
          <div class="muted">${q.trim() ? `Results: ${esc(this.items.length)} / ${esc(this.total)} (${this.mode==='cache'?'cache':'live'})` : 'Search for accounts by handle/name/bio'}</div>
        </div>

        <form>
          <input id="q" type="search" placeholder="Try: emoji 🧿, handle, or bio text…" value="${esc(q)}" />
          <select id="mode" onchange="this.getRootNode().host.mode=this.value; this.getRootNode().host.search(true);">
            <option value="cache" ${this.mode==='cache'?'selected':''}>Local cache</option>
            <option value="network" ${this.mode==='network'?'selected':''}>Live Bluesky</option>
          </select>
          <button type="submit" ${this.loading?'disabled':''}>Search</button>
          <button id="more" type="button" ${this.loading || !(this.mode==='network' ? this.cursor : this.hasMore) ? 'disabled' : ''}>Load more</button>
          <button id="sync" type="button" ${this.loading?'disabled':''}>Sync cache</button>
        </form>

        ${this.error ? `<div class="err">Error: ${esc(this.error)}</div>` : ''}
        <div class="list">
          ${rows || (this.loading ? '<div class="muted">Loading…</div>' : (q.trim() ? '<div class="muted">No results yet.</div>' : '<div class="muted">Enter a search query.</div>'))}
        </div>
      </div>
    `;
  }
}

customElements.define('bsky-people-search', BskyPeopleSearch);
