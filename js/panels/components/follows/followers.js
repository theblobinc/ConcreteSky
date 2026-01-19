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

    // Keyed by actor DID: { open, loading, error, followers, fetchedAt }
    this._knownFollowers = new Map();

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

        const did = String(p?.did || '').trim();
        const kf = did ? this._kfState(did) : null;

        const kfBtn = did ? `
          <button
            class="mini"
            type="button"
            data-action="known-followers"
            data-did="${esc(did)}"
            ${kf?.loading ? 'disabled' : ''}
          >${kf?.open ? 'Hide followers you know' : 'Followers you know'}</button>
        ` : '';

        const kfWrap = (() => {
          if (!kf || !kf.open) return '';
          if (kf.loading) return '<div class="kfWrap"><div class="kf muted">Loading followers you know…</div></div>';
          if (kf.error) return `<div class="kfWrap"><div class="kf err">${esc(kf.error)}</div></div>`;
          const items = Array.isArray(kf.followers) ? kf.followers : [];
          if (!items.length) return '<div class="kfWrap"><div class="kf muted">No followers you know found.</div></div>';
          const line = this._fmtKnownFollowersLine(items);
          const list = items.slice(0, 8).map((x) => {
            const url = x?.did ? `https://bsky.app/profile/${encodeURIComponent(x.did)}` : (x?.handle ? `https://bsky.app/profile/${encodeURIComponent(x.handle)}` : '');
            const label = x?.displayName || (x?.handle ? `@${x.handle}` : '') || x?.did;
            return `
              <a class="kfItem" href="${esc(url)}" target="_blank" rel="noopener">
                <img class="kfAv" src="${esc(x?.avatar || '')}" alt="" onerror="this.style.display='none'">
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
        <div class="row" data-did="${esc(p?.did || '')}">
          <img class="av" src="${esc(p?.avatar || '')}" alt="" onerror="this.style.display='none'">
          <div class="main">
            <div class="top">
              ${identityHtml({ did: p?.did, handle: p?.handle, displayName: p?.displayName }, { showHandle: false, showCopyDid: true })}
              ${mutual ? `<span class="chip">Mutual</span>` : ``}
              ${kfBtn}
            </div>
            <div class="sub">${p?.handle ? `<a href="${esc(toProfileUrl({ handle: p.handle, did: p.did }))}" target="_blank" rel="noopener">@${esc(p.handle)}</a>` : ''}</div>
            ${p?.description ? `<div class="bio">${esc(p.description)}</div>` : ``}
            <div class="meta">
              <span>Followers: ${esc(p?.followersCount ?? '—')}</span>
              <span>Following: ${esc(p?.followsCount ?? '—')}</span>
              <span>Posts: ${esc(p?.postsCount ?? '—')}</span>
              <span>Age: ${ageDays === null ? '—' : `${ageDays}d`}</span>
            </div>
            ${kfWrap}
          </div>
        </div>
      `;
      },
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

  _rerenderKnownFollowersUi() {
    const total = (this.items || []).length;
    const canWindow = !!(this._winCtl && this._winCtl.enabled && this._winCtl.enabled());
    const shouldWindow = canWindow && total >= Number(this._winCtl.minItemsToWindow || 0);
    if (shouldWindow) {
      this._winCtl.rerenderWindowOnly({ force: true });
      return;
    }
    this.render();
  }

  async _toggleKnownFollowers(actorDid) {
    const did = String(actorDid || '').trim();
    if (!did) return;

    const cur = this._kfState(did);
    const nextOpen = !cur.open;
    this._setKfState(did, { open: nextOpen, error: cur.error || '' });
    this._rerenderKnownFollowersUi();

    if (!nextOpen) return;
    if (cur.loading) return;
    if (Array.isArray(cur.followers)) return;

    this._setKfState(did, { loading: true, error: '' });
    this._rerenderKnownFollowersUi();

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
      this._rerenderKnownFollowersUi();
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

    const knownBtn = e.target?.closest?.('button[data-action="known-followers"]');
    if (knownBtn) {
      e.preventDefault();
      e.stopPropagation();
      const did = String(knownBtn.getAttribute('data-did') || '').trim();
      this._toggleKnownFollowers(did);
      return;
    }
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
        .mini{appearance:none;background:transparent;border:1px solid var(--bsky-border-soft, #555);color:var(--bsky-fg, #fff);border-radius: var(--bsky-radius, 0px);padding:4px 8px;cursor:pointer;font-size:.78rem;font-weight:800}
        .mini:hover{background:#1b1b1b}
        .mini:disabled{opacity:.6;cursor:not-allowed}
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

        .kfWrap{margin-top:6px;padding-left:8px;border-left:2px solid #2f4b7a}
        .kf{font-size:.85rem;line-height:1.2}
        .kfList{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
        .kfItem{display:inline-flex;align-items:center;gap:6px;max-width:100%;border:1px solid var(--bsky-border, #333);border-radius: var(--bsky-radius, 0px);padding:4px 6px;background:rgba(0,0,0,.15);color:var(--bsky-fg, #fff);text-decoration:none}
        .kfItem:hover{background:rgba(0,0,0,.25);border-color:var(--bsky-border-soft, #3a3a3a)}
        .kfAv{width:18px;height:18px;border-radius: var(--bsky-radius, 0px);object-fit:cover;background:var(--bsky-surface-2, #222)}
        .kfName{font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
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
