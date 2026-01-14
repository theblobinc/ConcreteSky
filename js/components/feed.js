import { call } from '../api.js';
import { identityCss, identityHtml, bindCopyClicks } from '../lib/identity.js';

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
      const data = await call('getAuthorFeed', { limit: 25, cursor: this.cursor || null });
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

  onClick(e){
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
    const meDid = window.BSKY?.meDid;

    const posts = this.items.map(it => {
      const p = it.post || {};
      const rec = p.record || {};
      const author = p.author || {};
      const text = esc(rec.text || '');
      const uri = p.uri || '';
      const cid = p.cid || '';
      const canLike = !!(uri && cid && author.did && meDid && author.did !== meDid);
      const when = fmtTime(rec.createdAt || p.indexedAt || '');
      const rel = this.followMap[author.did] || {};
      const following = !!rel.following;

      return `<article class="post">
        <header class="meta">
          <img class="avatar" src="${esc(author.avatar || '')}" alt="" onerror="this.style.display='none'">
          <div class="who">
            <div class="name">${identityHtml({ did: author.did, handle: author.handle, displayName: author.displayName }, { showHandle: true, showCopyDid: true })}</div>
          </div>
          <div class="time">${esc(when)}</div>
          <div class="actions">
            ${author.did && !following ? `<button class="follow-btn" data-follow-did="${esc(author.did)}">Follow</button>` : `<span class="following-badge" ${following?'':'style="display:none"'}>Following</span>`}
          </div>
        </header>
        <div class="text">${text}</div>
        <footer class="row">
          <button class="who-liked" data-like-uri="${esc(uri)}" title="See who liked this">♥ Who liked${typeof p.likeCount === 'number' ? ` (${p.likeCount})` : ''}</button>
          ${canLike ? `<button class="like" disabled title="Like coming soon">♡ Like</button>` : ``}
          <a class="open" target="_blank" rel="noopener" href="https://bsky.app/profile/${esc(author.handle || author.did)}/post/${esc((p.uri || '').split('/').pop() || '')}">Open</a>
        </footer>
      </article>`;
    }).join('');

    const modal = this.modal.open ? (() => {
      const list = (this.modal.likers || []).map(a => {
        const f = this.modal.followingMap[a.did] || {};
        const following = !!f.following;
        const stats = (this.modal.statsMap && this.modal.statsMap[a.did]) ? this.modal.statsMap[a.did] : null;
        const statsText = stats ? ` • ❤ ${stats.likes||0} • 💬 ${stats.replies||0}` : '';
        const avatar = f.avatar || a.avatar || '';
        return `<div class="liker">
          <div class="li-meta">
            <img class="li-avatar" src="${esc(avatar)}" alt="" onerror="this.style.display='none'">
            <div class="li-names">
              <div class="li-name">
                ${identityHtml({ did: a.did, handle: a.handle, displayName: a.displayName }, { showHandle: true, showCopyDid: true })}
              </div>
              <div class="li-handle">@${esc(a.handle || '')}${statsText}</div>
            </div>
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
        .wrap{background:#000;border:1px solid #222;border-radius:12px;padding:6px}
        #scroll{max-height:60vh; overflow:auto; padding:2px}
        .post{border:1px solid #333; border-radius:10px; padding:12px; margin:10px 0; color:#fff; background:#0b0b0b}
        .meta{display:flex; align-items:center; gap:10px; margin-bottom:8px}
        .avatar{width:36px;height:36px;border-radius:50%;background:#222;object-fit:cover}
        .who{display:flex;flex-direction:column;min-width:0}
        .name{font-weight:700;line-height:1}
        .handle{color:#bbb;font-size:.9rem;line-height:1}
        .time{margin-left:auto;color:#888;font-size:.85rem}
        .actions{margin-left:12px}
        .following-badge{color:#7bdc86;font-size:.9rem}
        .text{white-space:pre-wrap;line-height:1.35;margin:6px 0 2px}
        .row{margin-top:8px; display:flex; gap:8px; align-items:center}
        button, .open{background:#121212;border:1px solid #555;color:#fff;padding:6px 10px;border-radius:8px;cursor:pointer;text-decoration:none}
        button:hover, .open:hover{background:#1b1b1b}
        .muted{color:#aaa}
        .err{color:#f88}

        .overlay{position:fixed; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:center; justify-content:center; z-index:99999;}
        .modal{background:#0b0b0b; color:#fff; border:1px solid #444; border-radius:12px; width:min(760px, 94vw); max-height:80vh; overflow:auto; box-shadow:0 10px 40px rgba(0,0,0,.6);}
        .head{display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid #333; position:sticky; top:0; background:#0b0b0b}
        .actions{display:flex; gap:8px}
        .body{padding:12px 14px}
        .likers-list{display:flex; flex-direction:column; gap:10px}
        .liker{display:flex; justify-content:space-between; align-items:center; border:1px solid #333; border-radius:10px; padding:10px; background:#0f0f0f}
        .li-meta{display:flex; align-items:center; gap:10px}
        .li-avatar{width:36px;height:36px;border-radius:50%;object-fit:cover;background:#222}
        .li-name a{color:#fff; text-decoration:underline}
        .li-handle{color:#bbb; font-size:.9rem}
        .already{color:#7bdc86; font-size:.9rem}
        .close{border-color:#666}
        #load-more{width:100%}
      </style>

      ${modal}

      <div class="wrap">
        <div id="scroll" tabindex="0">
          ${posts || (this.loading ? '<div class="muted">Loading…</div>' : '<div class="muted">No posts.</div>')}
          ${this.error ? `<div class="err">Error: ${esc(this.error)}</div>` : ''}
        </div>
        <div style="margin-top:8px;display:flex;justify-content:center">
          <button id="load-more" ${this.loading || !this.cursor ? 'disabled':''}>${this.cursor ? 'Load more' : 'No more'}</button>
        </div>
      </div>
    `;
  }
}
customElements.define('bsky-feed', BskyFeed);
