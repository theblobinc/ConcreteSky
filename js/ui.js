import { call } from './api.js';

const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) =>
  ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[m])
);

/* ---------- Profile ---------- */
class BskyProfile extends HTMLElement {
  constructor(){ super(); this.attachShadow({mode:'open'}); }
  connectedCallback(){
    this._onAuthChanged = () => this.render();
    window.addEventListener('bsky-auth-changed', this._onAuthChanged);
    this.render();
  }

  disconnectedCallback(){
    if (this._onAuthChanged) window.removeEventListener('bsky-auth-changed', this._onAuthChanged);
  }
  async render() {
    this.shadowRoot.innerHTML = `<style>:host{display:block;margin-bottom:12px}</style><div>Loading profile…</div>`;
    try {
      // If not connected to Bluesky yet, avoid calling getProfile (it will 401).
      const auth = await call('authStatus', {});
      if (!auth?.connected) {
        this.shadowRoot.innerHTML = `
          <style>:host{display:block;margin-bottom:12px}.muted{color:#aaa}</style>
          <div class="muted">Bluesky: not connected. Use the Connect button in the tab bar.</div>
        `;
        return;
      }

      const prof = await call('getProfile', {});
      // expose my DID globally so other components can hide Like on own posts
      window.BSKY = window.BSKY || {};
      window.BSKY.meDid = prof.did;

      this.shadowRoot.innerHTML =
        `<style>a{color:#fff;text-decoration:underline}</style>
         <div><strong>${esc(prof.displayName || prof.handle)}</strong>
         • <a target="_blank" rel="noopener" href="https://bsky.app/profile/${esc(prof.did)}">@${esc(prof.handle)}</a></div>`;
    } catch(e) {
      console.error('[BskyProfile] render error', e);
      this.shadowRoot.innerHTML = `<div style="color:#f88">Profile error: ${esc(e.message)}</div>`;
    }
  }
}
customElements.define('bsky-profile', BskyProfile);

/* ---------- Feed + Lightbox for "Who Liked" ---------- */
class BskyFeed extends HTMLElement {
  constructor(){
    super();
    this.attachShadow({mode:'open'});
    this.cursor=null; this.loading=false; this.items=[]; this.error=null;

    // lightbox state
    this.modal = { open:false, uri:null, loading:false, error:null, likers:[], followingMap:{}, statsMap:null };
  }

  connectedCallback(){
    this.render();
    this.bootstrap();
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
    this.shadowRoot.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeModal(); });
  }

  async bootstrap(){
    this.loading = true; this.render();
    try {
      // ensure we know my DID (if profile component didn't run first)
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

  async loadMore(){
    if (this.loading) return;
    this.loading = true; this.render();
    try{
      const data = await call('getAuthorFeed', { limit: 25, cursor: this.cursor || null });
      this.cursor = data.cursor || null;
      this.items.push(...(data.feed || []));
      this.error = null;
    } catch(e){
      console.error('[BskyFeed] loadMore error', e);
      this.error = e.message;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  /* modal ops */
  async openLikersModal(uri){
    this.modal = { open:true, uri, loading:true, error:null, likers:[], followingMap:{}, statsMap:null };
    this.render();
    try {
      // 1) fetch likers
      const res = await call('getLikes', { uri, limit: 50 });
      const likers = (res.likes || []).map(lk => lk.actor || {}).filter(a => a?.did);
      this.modal.likers = likers;

      // 2) enrich with follow status (viewer.following) via getProfiles
      const actors = Array.from(new Set(likers.map(a => a.did)));
      if (actors.length) {
        const profs = await call('getProfiles', { actors });
        const map = {};
        (profs.profiles || []).forEach(p => {
          map[p.did] = {
            following: !!(p.viewer && p.viewer.following),
            handle: p.handle,
            displayName: p.displayName
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
      // mark in followingMap so UI updates if re-render
      if (this.modal.followingMap[did]) this.modal.followingMap[did].following = true;
    } catch (e) {
      alert('Follow failed: ' + e.message);
      btn?.removeAttribute('disabled');
    }
  }

  /* Delegated click handling */
  onClick(e){
    // open likers modal
    const likeBtn = e.target.closest('[data-like-uri]');
    if (likeBtn) {
      this.openLikersModal(likeBtn.getAttribute('data-like-uri'));
      return;
    }

    // follow inside modal
    const followBtn = e.target.closest('[data-follow-did]');
    if (followBtn) {
      this.follow(followBtn.getAttribute('data-follow-did'), followBtn);
      return;
    }

    // overlay click to close (only if clicking the dim background)
    const overlay = e.target.closest('#overlay');
    if (overlay && e.target === overlay) {
      this.closeModal();
      return;
    }

    // load stats button
    const statsBtn = e.target.closest('#load-stats');
    if (statsBtn) {
      this.loadStatsIntoModal();
      return;
    }
  }

  render(){
    const meDid = window.BSKY?.meDid;

    /* posts list */
    const posts = this.items.map(it => {
      const p = it.post || {};
      const rec = p.record || {};
      const text = esc(rec.text || '');
      const author = p.author || {};
      const likeCount = (typeof p.likeCount === 'number') ? p.likeCount : (typeof it.post?.likeCount === 'number' ? it.post.likeCount : '');
      const uri = p.uri || '';
      const cid = p.cid || '';

      // no "Like" on my own posts
      const canLike = !!(uri && cid && author.did && meDid && author.did !== meDid);

      return `<div class="post">
        <div class="meta"><b>${esc(author.displayName || author.handle || '')}</b> <span>@${esc(author.handle || '')}</span></div>
        <div class="text">${text}</div>
        <div class="row">
          <button class="who-liked" data-like-uri="${esc(uri)}">♥ Who liked${likeCount!=='' ? ` (${likeCount})` : ''}</button>
          ${canLike ? `<button class="like" disabled title="Like coming soon">♡ Like</button>` : ``}
        </div>
      </div>`;
    }).join('');

    /* modal content */
    const modal = this.modal.open ? (() => {
      const list = (this.modal.likers || []).map(a => {
        const f = this.modal.followingMap[a.did] || {};
        const following = !!f.following;
        const stats = (this.modal.statsMap && this.modal.statsMap[a.did]) ? this.modal.statsMap[a.did] : null;
        const statsText = stats ? ` • ❤ ${stats.likes||0} • 💬 ${stats.replies||0}` : '';
        return `<div class="liker">
          <div class="li-meta">
            <div class="li-name">
              <a target="_blank" rel="noopener" href="https://bsky.app/profile/${esc(a.did)}">${esc(a.displayName || a.handle || a.did)}</a>
            </div>
            <div class="li-handle">@${esc(a.handle || '')}${statsText}</div>
          </div>
          ${(!following && a.did) ? `<button class="follow-btn" data-follow-did="${esc(a.did)}">Follow</button>` : `<span class="already">Following</span>`}
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

    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block}
        #scroll{max-height:60vh; overflow:auto; background:#000; padding:2px}
        .post{border:1px solid #333; border-radius: var(--bsky-radius, 0px); padding:10px; margin:8px 0; color:#fff}
        .meta{font-size:.9rem; color:#ccc; margin-bottom:6px}
        .row{margin-top:8px; display:flex; gap:8px}
        button{background:#111;border:1px solid #555;color:#fff;padding:4px 8px;border-radius: var(--bsky-radius, 0px);cursor:pointer}
        button:hover{background:#1b1b1b}
        .muted{color:#aaa}
        .err{color:#f88}

        /* lightbox */
        .overlay{
          position:fixed; inset:0; background:rgba(0,0,0,.6);
          display:flex; align-items:center; justify-content:center; z-index:99999;
        }
        .modal{
          background:#0b0b0b; color:#fff; border:1px solid #444; border-radius: var(--bsky-radius, 0px);
          width:min(720px, 92vw); max-height:80vh; overflow:auto; box-shadow:0 10px 40px rgba(0,0,0,.6);
        }
        .head{display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid #333; position:sticky; top:0; background:#0b0b0b}
        .actions{display:flex; gap:8px}
        .body{padding:10px 12px}
        .likers-list{display:flex; flex-direction:column; gap:0}
        .liker{display:flex; justify-content:space-between; align-items:center; border:1px solid #333; border-radius: var(--bsky-radius, 0px); padding:2px}
        .li-name a{color:#fff; text-decoration:underline}
        .li-handle{color:#bbb; font-size:.9rem}
        .already{color:#7bdc86; font-size:.9rem}
        .close{border-color:#666}
      </style>

      ${modal}

      <div id="scroll" tabindex="0">
        ${posts || (this.loading ? '<div class="muted">Loading…</div>' : '<div class="muted">No posts.</div>')}
        ${this.error ? `<div class="err">Error: ${esc(this.error)}</div>` : ''}
        ${this.loading ? '<div class="muted" style="margin:10px 0">Loading more…</div>' : ''}
      </div>`;
  }
}
customElements.define('bsky-feed', BskyFeed);

/* ---------- Optional: Notifications (unchanged from your last version) ---------- */
class BskyNotifications extends HTMLElement {
  constructor(){ super(); this.attachShadow({mode:'open'}); this.cursor=null; this.loading=false; this.items=[]; this.error=null; }
  connectedCallback(){ this.render(); this.load(); }
  async load(){
    if (this.loading) return;
    this.loading = true; this.render();
    try {
      const data = await call('listNotifications', { limit: 25, cursor: this.cursor || null });
      this.cursor = data.cursor || null;
      this.items.push(...(data.notifications || []));
      this.error = null;
    } catch(e) {
      this.error = e.message;
    } finally {
      this.loading = false; this.render();
    }
  }
  render(){
    const items = this.items.map(n => {
      const a = n.author || {};
      return `<div class="n">
        <div class="who"><b>${esc(a.displayName || a.handle || a.did)}</b> <span>@${esc(a.handle || '')}</span></div>
        <div class="reason">${esc(n.reason || '')}</div>
      </div>`;
    }).join('');
    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block;margin:10px 0}
        .wrap{border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:8px;background:#070707;color:#fff}
        .n{border:1px solid #333;border-radius: var(--bsky-radius, 0px);padding:2px;margin:0}
        .who span{color:#bbb;font-size:.9rem}
        .muted{color:#aaa}
        button{background:#111;border:1px solid #555;color:#fff;padding:4px 8px;border-radius: var(--bsky-radius, 0px);cursor:pointer}
      </style>
      <div class="wrap">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <div><strong>Notifications</strong></div>
          <div><button ${this.loading?'disabled':''} id="more">Load more</button></div>
        </div>
        ${items || (this.loading ? '<div class="muted">Loading…</div>' : '<div class="muted">No notifications.</div>')}
        ${this.error ? `<div class="muted" style="color:#f88">Error: ${esc(this.error)}</div>` : ''}
      </div>`;
    this.shadowRoot.getElementById('more')?.addEventListener('click', () => this.load());
  }
}
customElements.define('bsky-notifications', BskyNotifications);
