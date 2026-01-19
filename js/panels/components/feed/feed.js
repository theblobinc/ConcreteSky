import { call } from '../../../api.js';
import { identityCss, identityHtml, bindCopyClicks, copyToClipboard } from '../../../lib/identity.js';
import { PanelListController } from '../../../controllers/panel_list_controller.js';
import { ListWindowingController } from '../../../controllers/list_windowing_controller.js';
import { renderListEndcap } from '../../panel_api.js';
import { renderPostTextHtml } from '../../../components/interactions/utils.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) =>
  ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[m])
);
const fmtTime = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return ''; } };

class BskyFeed extends HTMLElement {
  constructor(){
    super();
    this.attachShadow({mode:'open'});
    this.cursor=null; this.loading=false; this.items=[]; this.error=null;
    this.followMap = {}; // did -> {following:boolean}
    this.modal = { open:false, uri:null, loading:false, error:null, likers:[], followingMap:{}, statsMap:null };

    // Keyed by actor DID: { open, loading, error, followers, fetchedAt }
    this._knownFollowers = new Map();

    // uri -> { open, loading, error, to, text }
    this._translateByUri = new Map();

    this._scrollTop = 0;
    this._renderedCount = 0;
    this._hasStaticDom = false;

    this._listCtl = new PanelListController(this, {
      getScroller: () => {
        try { return this.shadowRoot?.getElementById?.('scroll') || null; } catch { return null; }
      },
      itemSelector: 'article.post[data-uri]',
      keyAttr: 'data-uri',
      onLoadMore: () => this.loadMore(),
      enabled: () => true,
      isLoading: () => !!this.loading,
      hasMore: () => !!this.cursor,
      threshold: 280,
      cooldownMs: 250,
      ensureKeyVisible: (key) => this._winCtl?.ensureKeyVisible?.(key),
    });

    this._winCtl = new ListWindowingController(this, {
      listSelector: '#list',
      itemSelector: 'article.post[data-uri]',
      keyAttr: 'data-uri',
      getRoot: () => this.shadowRoot,
      getScroller: () => {
        try { return this.shadowRoot?.getElementById?.('scroll') || null; } catch { return null; }
      },
      enabled: () => true,
      getLayout: () => 'list',
      minItemsToWindow: 120,
      estimatePx: 220,
      overscanItems: 24,
      keyFor: (it) => String(it?.post?.uri || ''),
      renderRow: (it) => this._renderFeedPost(it),
    });
  }

  _findTextByUri(uri) {
    const target = String(uri || '');
    if (!target) return '';
    try {
      for (const it of (this.items || [])) {
        const p = it?.post || null;
        if (p && String(p.uri || '') === target) {
          return String(p?.record?.text || '');
        }
      }
    } catch {}
    return '';
  }

  async _translateUri(uri) {
    const u = String(uri || '').trim();
    if (!u) return;
    const cur = this._translateByUri.get(u) || null;
    if (cur && cur.open && !cur.loading) {
      this._translateByUri.set(u, { ...cur, open: false });
      this.render();
      return;
    }

    const text = this._findTextByUri(u);
    if (!String(text || '').trim()) return;

    const to = String((navigator?.language || 'en').split('-')[0] || 'en').toLowerCase();
    this._translateByUri.set(u, { open: true, loading: true, error: null, to, text: '' });
    this.render();
    try {
      const out = await call('translateText', { text, to, from: 'auto' });
      const translatedText = String(out?.translatedText || out?.data?.translatedText || '');
      this._translateByUri.set(u, { open: true, loading: false, error: null, to, text: translatedText });
    } catch (e) {
      this._translateByUri.set(u, { open: true, loading: false, error: String(e?.message || e || 'Translate failed'), to, text: '' });
    }
    this.render();
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

  _rerenderKnownFollowersChange() {
    if (this._winCtl?.enabled?.()) {
      try { this._winCtl?.rerenderWindowOnly?.({ force: true }); } catch {}
    }
    this.render();
  }

  async _toggleKnownFollowers(actorDid) {
    const did = String(actorDid || '').trim();
    if (!did) return;

    const cur = this._kfState(did);
    const nextOpen = !cur.open;
    this._setKfState(did, { open: nextOpen, error: cur.error || '' });
    this._rerenderKnownFollowersChange();

    if (!nextOpen) return;
    if (cur.loading) return;
    if (Array.isArray(cur.followers)) return;

    this._setKfState(did, { loading: true, error: '' });
    this._rerenderKnownFollowersChange();

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
      this._rerenderKnownFollowersChange();
    }
  }

  disconnectedCallback(){
    try { this._listCtl?.disconnect?.(); } catch {}
    try { this._winCtl?.disconnect?.(); } catch {}
  }

  _renderFeedPost(it){
    const meDid = window.BSKY?.meDid;
    const p = it?.post || {};
    const rec = p?.record || {};
    const author = p?.author || {};

    const text = renderPostTextHtml(rec?.text || '');
    const uri = p?.uri || '';
    const cid = p?.cid || '';
    const canLike = !!(uri && cid && author.did && meDid && author.did !== meDid);
    const when = fmtTime(rec?.createdAt || p?.indexedAt || '');
    const rel = this.followMap[author.did] || {};
    const following = !!rel.following;
    const postId = String((p?.uri || '').split('/').pop() || '');

    const kf = author?.did ? this._kfState(author.did) : null;
    const kfBtn = author?.did ? `
      <button class="mini" type="button" data-action="known-followers" data-did="${esc(author.did)}" ${kf?.loading ? 'disabled' : ''}>
        ${kf?.open ? 'Hide followers you know' : 'Followers you know'}
      </button>
    ` : '';
    const kfWrap = (() => {
      if (!kf || !kf.open) return '';
      if (kf.loading) return '<div class="kfWrap"><div class="kf muted">Loading followers you know…</div></div>';
      if (kf.error) return `<div class="kfWrap"><div class="kf err">${esc(kf.error)}</div></div>`;
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

    const tr = uri ? (this._translateByUri.get(String(uri)) || null) : null;
    const trBlock = (tr && tr.open) ? (() => {
      if (tr.loading) return `<div class="translate muted">Translating…</div>`;
      if (tr.error) return `<div class="translate err">Translate error: ${esc(tr.error)}</div>`;
      const t = String(tr.text || '');
      if (!t.trim()) return `<div class="translate muted">No translation returned.</div>`;
      return `
        <div class="translate">
          <div class="translate-top">
            <div class="muted">Translation (${esc(String(tr.to || ''))})</div>
            <button class="mini" type="button" data-action="copy-translation" data-uri="${esc(uri)}">Copy translation</button>
          </div>
          <div class="translate-text">${renderPostTextHtml(t)}</div>
        </div>
      `;
    })() : '';

    return `<article class="post" data-uri="${esc(uri)}">
      <header class="meta">
        <bsky-lazy-img class="avatar" src="${esc(author.avatar || '')}" alt="" aspect="1/1"></bsky-lazy-img>
        <div class="who">
          <div class="name">${identityHtml({ did: author.did, handle: author.handle, displayName: author.displayName }, { showHandle: true, showCopyDid: true })}</div>
        </div>
        <div class="time">${esc(when)}</div>
        <div class="actions">
          ${author.did && !following ? `<button class="follow-btn" data-follow-did="${esc(author.did)}">Follow</button>` : `<span class="following-badge" ${following?'':'style="display:none"'}>Following</span>`}
          ${kfBtn}
        </div>
      </header>
      ${kfWrap}
      <div class="text">${text}</div>
      ${trBlock}
      <footer class="row">
        <button class="who-liked" data-like-uri="${esc(uri)}" title="See who liked this">♥ Who liked${typeof p.likeCount === 'number' ? ` (${p.likeCount})` : ''}</button>
        ${uri ? `<button class="mini" type="button" data-action="copy-text" data-uri="${esc(uri)}">Copy text</button>` : ''}
        ${uri ? `<button class="mini" type="button" data-action="translate" data-uri="${esc(uri)}">${(tr && tr.open) ? 'Hide translation' : 'Translate'}</button>` : ''}
        ${canLike ? `<button class="like" disabled title="Like coming soon">♡ Like</button>` : ``}
        <a class="open" target="_blank" rel="noopener" href="https://bsky.app/profile/${esc(author.handle || author.did)}/post/${esc(postId)}">Open</a>
      </footer>
    </article>`;
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

  connectedCallback(){
    this.render();
    this.bootstrap();
    bindCopyClicks(this.shadowRoot);
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
    this.shadowRoot.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeModal(); });
  }

  async bootstrap(){
    this.loading = true; this.render();
    try {
      if (!window.BSKY?.meDid) {
        const me = await call('getProfile', {});
        window.BSKY = window.BSKY || {};
        window.BSKY.meDid = me.did;
      }
      await this.loadMore();
    } catch (e) {
      this.error = e.message;
    } finally {
      this.loading = false; this.render();
    }
  }

  async enrichFollowState(authors){
    const dids = Array.from(new Set(authors.filter(Boolean)));
    if (!dids.length) return;
    try {
      const rel = await call('getRelationships', { actors: dids });
      (rel.relationships || []).forEach(r => {
        this.followMap[r.did] = { following: !!(r.following) };
      });
    } catch {}
  }

  async loadMore(){
    if (this.loading) return;
    this.loading = true; this.render();
    try{
      let data;
      for (;;) {
        try {
          data = await call('getAuthorFeed', { limit: 25, cursor: this.cursor || null });
          break;
        } catch (e) {
          const waited = await this._backoffIfRateLimited(e);
          if (waited) continue;
          throw e;
        }
      }
      this.cursor = data.cursor || null;
      const newItems = (data.feed || []);
      this.items.push(...newItems);

      // collect authors to look up follow state
      const authors = newItems.map(it => it?.post?.author?.did).filter(Boolean);
      await this.enrichFollowState(authors);

      this.error = null;
    } catch(e){
      this.error = e.message;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  async openLikersModal(uri){
    this.modal = { open:true, uri, loading:true, error:null, likers:[], followingMap:{}, statsMap:null };
    this.render();
    try {
      const res = await call('getLikes', { uri, limit: 50 });
      const likers = (res.likes || []).map(lk => lk.actor || {}).filter(a => a?.did);
      this.modal.likers = likers;

      const actors = Array.from(new Set(likers.map(a => a.did)));
      if (actors.length) {
        const profs = await call('getProfiles', { actors });
        const map = {};
        (profs.profiles || []).forEach(p => {
          map[p.did] = {
            following: !!(p.viewer && p.viewer.following),
            handle: p.handle,
            displayName: p.displayName,
            avatar: p.avatar || ''
          };
        });
        this.modal.followingMap = map;
      }

      this.modal.loading = false;
    } catch (e) {
      this.modal.loading = false;
      this.modal.error = e.message;
    } finally {
      this.render();
    }
  }

  closeModal(){ if (this.modal.open){ this.modal.open = false; this.render(); } }

  async loadStatsIntoModal(days=180, pages=10){
    if (!this.modal.open || this.modal.loading) return;
    this.modal.loading = true; this.render();
    try {
      const stats = await call('getInteractionStats', { days, pages });
      this.modal.statsMap = stats.stats || {};
    } catch (e) {
      this.modal.error = e.message;
    } finally {
      this.modal.loading = false; this.render();
    }
  }

  async follow(did, btn){
    if (!did) return;
    btn?.setAttribute('disabled','disabled');
    try {
      await call('follow', { did });
      btn.textContent = 'Following';
      btn.classList.add('following');
      if (this.modal.followingMap[did]) this.modal.followingMap[did].following = true;
      this.followMap[did] = { following: true };
    } catch (e) {
      alert('Follow failed: ' + e.message);
      btn?.removeAttribute('disabled');
    }
  }

  async onClick(e){
    const actBtn = e.target?.closest?.('[data-action]');
    if (actBtn) {
      const act = String(actBtn.getAttribute('data-action') || '').trim();
      const uri = String(actBtn.getAttribute('data-uri') || '').trim();

      if (act === 'translate') {
        e.preventDefault();
        e.stopPropagation();
        this._translateUri(uri);
        return;
      }

      if (act === 'copy-text') {
        e.preventDefault();
        e.stopPropagation();
        const ok = await copyToClipboard(this._findTextByUri(uri));
        try {
          actBtn.textContent = ok ? 'Copied' : 'Copy failed';
          clearTimeout(actBtn.__bskyCopyT);
          actBtn.__bskyCopyT = setTimeout(() => {
            try { actBtn.textContent = 'Copy text'; } catch {}
          }, 900);
        } catch {}
        return;
      }

      if (act === 'copy-translation') {
        e.preventDefault();
        e.stopPropagation();
        const tr = uri ? (this._translateByUri.get(uri) || null) : null;
        const ok = await copyToClipboard(String(tr?.text || ''));
        try {
          actBtn.textContent = ok ? 'Copied' : 'Copy failed';
          clearTimeout(actBtn.__bskyCopyT);
          actBtn.__bskyCopyT = setTimeout(() => {
            try { actBtn.textContent = 'Copy translation'; } catch {}
          }, 900);
        } catch {}
        return;
      }
    }

    const knownBtn = e.target.closest('button[data-action="known-followers"]');
    if (knownBtn) {
      e.preventDefault();
      e.stopPropagation();
      this._toggleKnownFollowers(knownBtn.getAttribute('data-did'));
      return;
    }

    const likeBtn = e.target.closest('[data-like-uri]');
    if (likeBtn) { this.openLikersModal(likeBtn.getAttribute('data-like-uri')); return; }

    const followBtn = e.target.closest('[data-follow-did]');
    if (followBtn) { this.follow(followBtn.getAttribute('data-follow-did'), followBtn); return; }

    const overlay = e.target.closest('#overlay');
    if (overlay && e.target === overlay) { this.closeModal(); return; }

    const statsBtn = e.target.closest('#load-stats');
    if (statsBtn) { this.loadStatsIntoModal(); return; }

    const moreBtn = e.target.closest('#load-more');
    if (moreBtn) { this.loadMore(); return; }
  }

  render(){
    this._winCtl.setItems(this.items || []);

    const modal = this.modal.open ? (() => {
      const list = (this.modal.likers || []).map(a => {
        const f = this.modal.followingMap[a.did] || {};
        const following = !!f.following;
        const stats = (this.modal.statsMap && this.modal.statsMap[a.did]) ? this.modal.statsMap[a.did] : null;
        const statsText = stats ? ` • ❤ ${stats.likes||0} • 💬 ${stats.replies||0}` : '';
        const avatar = f.avatar || a.avatar || '';

        const kf = a?.did ? this._kfState(a.did) : null;
        const kfBtn = a?.did ? `
          <button class="mini" type="button" data-action="known-followers" data-did="${esc(a.did)}" ${kf?.loading ? 'disabled' : ''}>
            ${kf?.open ? 'Hide followers you know' : 'Followers you know'}
          </button>
        ` : '';
        const kfWrap = (() => {
          if (!kf || !kf.open) return '';
          if (kf.loading) return '<div class="kfWrap"><div class="kf muted">Loading followers you know…</div></div>';
          if (kf.error) return `<div class="kfWrap"><div class="kf err">${esc(kf.error)}</div></div>`;
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

        return `<div class="liker">
          <div class="li-meta">
            <bsky-lazy-img class="li-avatar" src="${esc(avatar)}" alt="" aspect="1/1"></bsky-lazy-img>
            <div class="li-names">
              <div class="li-name">
                ${identityHtml({ did: a.did, handle: a.handle, displayName: a.displayName }, { showHandle: true, showCopyDid: true })}
              </div>
              <div class="li-handle">@${esc(a.handle || '')}${statsText}</div>
            </div>
          </div>
          <div class="li-actions">
            ${(!following && a.did) ? `<button class="follow-btn" data-follow-did="${esc(a.did)}">Follow</button>` : `<span class="already">Following</span>`}
            ${kfBtn}
          </div>
          ${kfWrap}
        </div>`;
      }).join('');

      return `
      <div id="overlay" class="overlay" tabindex="-1">
        <div class="modal" role="dialog" aria-modal="true">
          <div class="head">
            <div>Liked by</div>
            <div class="actions">
              <button id="load-stats" ${this.modal.loading?'disabled':''} title="Load interaction stats (likes/replies on your posts)">Load stats</button>
              <button class="close" onclick="this.getRootNode().host.closeModal()">✕</button>
            </div>
          </div>
          <div class="body">
            ${this.modal.loading ? '<div class="muted">Loading…</div>' : ''}
            ${this.modal.error ? `<div class="err">Error: ${esc(this.modal.error)}</div>` : ''}
            <div class="likers-list">
              ${list || (!this.modal.loading ? '<div class="muted">No likes yet.</div>' : '')}
            </div>
          </div>
        </div>
      </div>`;
    })() : '';

    const ensureStaticDom = () => {
      if (this._hasStaticDom) return false;
      this.shadowRoot.innerHTML = `
        <style>
          :host{display:block;color:var(--bsky-fg, #fff);font-family:var(--bsky-font-family, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif)}
          .wrap{background:var(--bsky-bg, #000);border:1px solid var(--bsky-border-subtle, #222);border-radius:12px;padding:6px}
          #scroll{max-height:60vh; overflow:auto; padding:2px}
          .post{border:1px solid var(--bsky-border, #333); border-radius:10px; padding:12px; margin:10px 0; color:var(--bsky-fg, #fff); background:var(--bsky-surface, #0b0b0b)}
          .meta{display:flex; align-items:center; gap:10px; margin-bottom:8px}
          .avatar{width:36px;height:36px;border-radius:50%;background:var(--bsky-surface-2, #222);object-fit:cover}
          .who{display:flex;flex-direction:column;min-width:0}
          .name{font-weight:700;line-height:1}
          .handle{color:var(--bsky-muted-fg, #bbb);font-size:.9rem;line-height:1}
          .time{margin-left:auto;color:var(--bsky-muted-fg, #888);font-size:.85rem}
          .actions{margin-left:12px}
          .following-badge{color:#7bdc86;font-size:.9rem}
          .text{white-space:pre-wrap;line-height:1.35;margin:6px 0 2px}
          .row{margin-top:8px; display:flex; gap:8px; align-items:center}
          button, .open{background:var(--bsky-btn-bg, #121212);border:1px solid var(--bsky-border-soft, #555);color:var(--bsky-fg, #fff);padding:6px 10px;border-radius:8px;cursor:pointer;text-decoration:none}
          button:hover, .open:hover{background:#1b1b1b}
          .mini{padding:4px 8px; font-size:.78rem; font-weight:800}
          .muted{color:var(--bsky-muted-fg, #aaa)}
          .err{color:var(--bsky-danger-fg, #f88)}

          .translate{margin:10px 0 0 0; padding:10px; border:1px solid rgba(255,255,255,.12); background:rgba(0,0,0,.25); border-radius:10px}
          .translate-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
          .translate-text{white-space:normal}
          .win-spacer{width:100%;pointer-events:none;contain:layout size style}

          .kfWrap{margin-top:8px;padding-left:10px;border-left:2px solid #2f4b7a}
          .kf{font-size:.85rem;line-height:1.2}
          .kfList{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
          .kfItem{display:inline-flex;align-items:center;gap:6px;max-width:100%;border:1px solid #222;border-radius:8px;padding:4px 6px;background:rgba(0,0,0,.15);color:#fff;text-decoration:none}
          .kfItem:hover{border-color:#3b5a8f;background:rgba(0,0,0,.25)}
          .kfAv{width:18px;height:18px;border-radius:50%;object-fit:cover;background:#222}
          .kfName{font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}

          .overlay{position:fixed; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:center; justify-content:center; z-index:99999;}
          .modal{background:var(--bsky-surface, #0b0b0b); color:var(--bsky-fg, #fff); border:1px solid var(--bsky-border, #444); border-radius:12px; width:min(760px, 94vw); max-height:80vh; overflow:auto; box-shadow:0 10px 40px rgba(0,0,0,.6);}
          .head{display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid var(--bsky-border, #333); position:sticky; top:0; background:var(--bsky-surface, #0b0b0b)}
          .actions{display:flex; gap:8px}
          .body{padding:12px 14px}
          .likers-list{display:flex; flex-direction:column; gap:10px}
          .liker{display:flex; flex-direction:column; gap:8px; border:1px solid var(--bsky-border, #333); border-radius:10px; padding:10px; background:var(--bsky-input-bg, #0f0f0f)}
          .li-meta{display:flex; align-items:center; gap:10px}
          .li-actions{display:flex; gap:8px; align-items:center; justify-content:flex-end; flex-wrap:wrap}
          .li-avatar{width:36px;height:36px;border-radius:50%;object-fit:cover;background:var(--bsky-surface-2, #222)}
          .li-name a{color:var(--bsky-fg, #fff); text-decoration:underline}
          .li-handle{color:var(--bsky-muted-fg, #bbb); font-size:.9rem}
          .already{color:#7bdc86; font-size:.9rem}
          .close{border-color:#666}
          #load-more{width:100%}
          .footer{margin-top:8px;display:flex;justify-content:center}
        </style>

        <div id="modal-root"></div>

        <div class="wrap">
          <div id="scroll" tabindex="0">
            <div id="list"></div>
            <div id="endcap"></div>
            <div id="err" class="err" hidden></div>
          </div>
          <div class="footer">
            <button id="load-more"></button>
          </div>
        </div>
      `;
      this._hasStaticDom = true;
      return true;
    };

    const created = ensureStaticDom();

    try {
      const scroller = this.shadowRoot.getElementById('scroll');
      if (scroller) this._scrollTop = scroller.scrollTop || 0;

      const modalRoot = this.shadowRoot.getElementById('modal-root');
      if (modalRoot) modalRoot.innerHTML = modal;

      const listEl = this.shadowRoot.getElementById('list');
      if (listEl) {
        listEl.innerHTML = this._winCtl.innerHtml({ loadingHtml: '', emptyHtml: '' });
        this._renderedCount = this.items.length;
      }

      const endcapEl = this.shadowRoot.getElementById('endcap');
      if (endcapEl) {
        const hasMore = !!this.cursor;
        endcapEl.innerHTML = renderListEndcap({
          loading: !!this.loading && !this.items.length,
          loadingMore: !!this.loading && !!this.items.length,
          hasMore,
          count: this.items.length,
          emptyText: 'No posts.',
        });
      }

      const errEl = this.shadowRoot.getElementById('err');
      if (errEl) {
        if (this.error) {
          errEl.hidden = false;
          errEl.textContent = `Error: ${esc(this.error)}`;
        } else {
          errEl.hidden = true;
          errEl.textContent = '';
        }
      }

      const moreBtn = this.shadowRoot.getElementById('load-more');
      if (moreBtn) {
        moreBtn.hidden = !this.cursor;
        moreBtn.disabled = !!(this.loading || !this.cursor);
        moreBtn.textContent = 'Load more';
      }
    } catch {}

    this._winCtl.afterRender();
    this._listCtl.afterRender();

    queueMicrotask(() => {
      requestAnimationFrame(() => {
        const scroller = this.shadowRoot.getElementById('scroll');
        if (!scroller) return;
        if (created) scroller.scrollTop = Math.max(0, this._scrollTop || 0);
      });
    });
  }
}
customElements.define('bsky-feed', BskyFeed);
