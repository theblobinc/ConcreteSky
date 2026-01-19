import { call } from '../../../api.js';
import { getAuthStatusCached, isNotConnectedError } from '../../../auth_state.js';
import { identityCss, identityHtml, bindCopyClicks, toProfileUrl } from '../../../lib/identity.js';
import { queueProfiles } from '../../../profile_hydrator.js';
import { PanelListController } from '../../../controllers/panel_list_controller.js';
import { ListWindowingController } from '../../../controllers/list_windowing_controller.js';
import { renderListEndcap } from '../../panel_api.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) =>
  ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[m])
);

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

class BskyFollowers extends HTMLElement {
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
    this.view = 'list'; // 'list' | 'masonry'
    this.diff = null;   // {counts:{added,removed}, latest, previous}
    this.filters = {
      q: '',
      sort: 'followers',
      onlyMutuals: false,
    };

    this._onProfilesHydrated = null;
    this._hydratedDidSet = new Set();
    this._hydratedTimer = null;

    this._listCtl = new PanelListController(this, {
      itemSelector: '.row[data-did]',
      keyAttr: 'data-did',
      enabled: () => true,
      isLoading: () => !!this.loading,
      hasMore: () => !!this.hasMore,
      onLoadMore: () => this.load(false),
      threshold: 220,
      cooldownMs: 250,
      ensureKeyVisible: (key) => this._winCtl?.ensureKeyVisible?.(key),
    });

    this._winCtl = new ListWindowingController(this, {
      listSelector: '.list',
      itemSelector: '.row[data-did]',
      keyAttr: 'data-did',
      getScroller: () => this._listCtl?.getScroller?.() || null,
      enabled: () => String(this.view || 'list') === 'list',
      getLayout: () => 'list',
      minItemsToWindow: 240,
      estimatePx: 96,
      overscanItems: 40,
      keyFor: (p) => String(p?.did || ''),
      renderRow: (p) => {
        const mutual = this.filters.onlyMutuals;
        const ageDays = daysSince(p?.createdAt);
        return `
        <div class="row" data-did="${esc(p?.did || '')}">
          <img class="av" src="${esc(p?.avatar || '')}" alt="" onerror="this.style.display='none'">
          <div class="main">
            <div class="top">
              ${identityHtml({ did: p?.did, handle: p?.handle, displayName: p?.displayName }, { showHandle: false, showCopyDid: true })}
              ${mutual ? `<span class="chip">Mutual</span>` : ``}
            </div>
            <div class="sub">${p?.handle ? `<a href="${esc(toProfileUrl({ handle: p.handle, did: p.did }))}" target="_blank" rel="noopener">@${esc(p.handle)}</a>` : ''}</div>
            ${p?.description ? `<div class="bio">${esc(p.description)}</div>` : ``}
            <div class="meta">
              <span>Followers: ${esc(p?.followersCount ?? '—')}</span>
              <span>Following: ${esc(p?.followsCount ?? '—')}</span>
              <span>Posts: ${esc(p?.postsCount ?? '—')}</span>
              <span>Age: ${ageDays === null ? '—' : `${ageDays}d`}</span>
            </div>
          </div>
        </div>
      `;
      },
    });
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

  async _backoffIfRateLimited(e) {
    if (!this._isRateLimitError(e)) return false;
    const sec = this._retryAfterSeconds(e);
    const waitSec = Number.isFinite(sec) ? Math.min(3600, Math.max(1, sec)) : 10;
    this.error = `Rate limited. Waiting ${waitSec}s…`;
    this.render();
    await new Promise((r) => setTimeout(r, waitSec * 1000));
    return true;
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

  connectedCallback(){
    this.render();
    this.load(true);
    bindCopyClicks(this.shadowRoot);
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
    this.shadowRoot.addEventListener('input', (e) => this.onInput(e));
    this.shadowRoot.addEventListener('change', (e) => this.onChange(e));

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
    this._listCtl?.disconnect?.();
    this._winCtl?.disconnect?.();
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
    if (e.target.id === 'view') {
      this.view = String(e.target.value || 'list');
      this.render();
    }
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
      await call('cacheSync', { kind: 'both', mode: 'force', pagesMax: 50 });
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
    if (!reset) this._listCtl?.requestRestore?.({ anchor: true });
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

      if (reset) {
        // pull diff summary (counts only)
        try {
          this.diff = await call('cacheFriendDiff', { kind: 'followers', limit: 0 });
        } catch (_) { /* ignore */ }
      }
      let data;
      for (;;) {
        try {
          data = await call('cacheQueryPeople', {
            list: 'followers',
            q: this.filters.q,
            sort: this.filters.sort,
            mutual: this.filters.onlyMutuals,
            limit: this.limit,
            offset: this.offset,
          });
          break;
        } catch (e) {
          const waited = await this._backoffIfRateLimited(e);
          if (waited) continue;
          throw e;
        }
      }
      const batch = Array.isArray(data.items) ? data.items : [];
      if (reset) this.items = batch;
      else this.items.push(...batch);
      this.total = Number(data.total || 0);
      this.hasMore = !!data.hasMore;
      this.offset = this.items.length;

      try {
        queueProfiles(batch.map((p) => p?.did).filter(Boolean));
      } catch {}
    } catch (e) {
      this.error = isNotConnectedError(e) ? 'Not connected. Use the Connect button.' : e.message;
      this._listCtl?.toastError?.(this.error, { kind: 'error' });
    } finally {
      this.loading = false;
      this.render();
    }
  }

  render(){
    this._listCtl?.beforeRender?.();

    const rows = (this.items || []).map((p) => this._winCtl.renderRow(p)).join('');
    this._winCtl.setItems(this.items || []);
    const listInner = (String(this.view || 'list') === 'list')
      ? this._winCtl.innerHtml({
          loadingHtml: '<div class="muted">Loading…</div>',
          emptyHtml: '<div class="muted">No followers loaded.</div>',
        })
      : (rows || (this.loading ? '<div class="muted">Loading…</div>' : '<div class="muted">No followers loaded.</div>'));

    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block}
        .wrap{border:1px solid var(--bsky-border, #333);border-radius: var(--bsky-radius, 0px);padding:10px;background:var(--bsky-bg, #070707);color:var(--bsky-fg, #fff)}
        .head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
        .title{font-weight:800}
        .muted{color:var(--bsky-muted-fg, #aaa)}
        .controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
        input,select{background:var(--bsky-input-bg, #0f0f0f);color:var(--bsky-fg, #fff);border:1px solid var(--bsky-border, #333);border-radius: var(--bsky-radius, 0px);padding:8px 10px}
        label{color:var(--bsky-muted-fg, #ddd);font-size:.95rem;display:flex;gap:6px;align-items:center}
        button{background:var(--bsky-btn-bg, #111);border:1px solid var(--bsky-border-soft, #555);color:var(--bsky-fg, #fff);padding:8px 10px;border-radius: var(--bsky-radius, 0px);cursor:pointer}
        button:disabled{opacity:.6;cursor:not-allowed}
        .list{display:flex;flex-direction:column;gap:0}
        .list.masonry{column-width:350px; column-gap:12px; display:block}
            .list.masonry .row{break-inside:avoid; display:inline-flex; width:100%; content-visibility:auto; contain-intrinsic-size:350px 92px;}
        .win-spacer{width:100%;pointer-events:none;contain:layout size style}
        .row{display:flex;gap:10px;border:1px solid var(--bsky-border, #333);border-radius: var(--bsky-radius, 0px);padding:2px;background:var(--bsky-input-bg, #0f0f0f)}
        .av{width:40px;height:40px;border-radius: var(--bsky-radius, 0px);background:var(--bsky-surface-2, #222);object-fit:cover;flex:0 0 auto}
        .main{min-width:0;flex:1}
        .top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .name{color:var(--bsky-fg, #fff);text-decoration:underline;font-weight:700}
        .sub{color:var(--bsky-muted-fg, #bbb);font-size:.9rem;margin-top:2px}
        .sub a{color:var(--bsky-muted-fg, #bbb);text-decoration:underline}
        .bio{color:var(--bsky-fg, #ddd);margin-top:6px;white-space:pre-wrap;word-break:break-word}
        .meta{color:var(--bsky-muted-fg, #bbb);font-size:.85rem;margin-top:6px;display:flex;gap:10px;flex-wrap:wrap}
        .chip{background:#1e2e1e;color:#89f0a2;border:1px solid #2e5a3a;border-radius: var(--bsky-radius, 0px);padding:1px 8px;font-size:.75rem}
        .err{color:var(--bsky-danger-fg, #f88)}
        ${identityCss}
      </style>
      <div class="wrap">
        <div class="head">
          <div class="title">Followers</div>
          <div class="muted">Loaded: ${esc(this.items.length)} / ${esc(this.total)}${this.diff?.counts ? ` • Δ +${esc(this.diff.counts.added)} / -${esc(this.diff.counts.removed)}` : ''}</div>
        </div>

        <div class="controls">
          <input id="q" type="search" placeholder="Search (name/handle/bio, supports emoji)…" value="${esc(this.filters.q)}">
          <select id="sort">
            <option value="followers" ${this.filters.sort==='followers'?'selected':''}>Sort: followers</option>
            <option value="following" ${this.filters.sort==='following'?'selected':''}>Sort: following</option>
            <option value="posts" ${this.filters.sort==='posts'?'selected':''}>Sort: posts</option>
            <option value="age" ${this.filters.sort==='age'?'selected':''}>Sort: account age</option>
            <option value="name" ${this.filters.sort==='name'?'selected':''}>Sort: name</option>
            <option value="handle" ${this.filters.sort==='handle'?'selected':''}>Sort: handle</option>
          </select>
          <select id="view">
            <option value="list" ${this.view==='list'?'selected':''}>View: list</option>
            <option value="masonry" ${this.view==='masonry'?'selected':''}>View: masonry</option>
          </select>
          <label><input id="only-mutuals" type="checkbox" ${this.filters.onlyMutuals?'checked':''}> mutuals only</label>
          <button id="sync" ${this.loading?'disabled':''}>Sync cache</button>
          <button id="refresh" ${this.loading?'disabled':''}>Reload</button>
          <button id="more" ${this.loading || !this.hasMore ? 'disabled' : ''}>Load more</button>
        </div>

        ${this.error ? `<div class="err">Error: ${esc(this.error)}</div>` : ''}
        <div class="list ${esc(this.view)}">
          ${listInner}
        </div>

            ${renderListEndcap({
              loading: this.loading,
              hasMore: this.hasMore,
              count: this.items.length,
              style: 'margin-top:10px',
            })}
      </div>
    `;

    this._winCtl.afterRender();
    this._listCtl?.afterRender?.();
  }
}

customElements.define('bsky-followers', BskyFollowers);
