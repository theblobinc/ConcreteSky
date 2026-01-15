// application/single_pages/bluesky_feed/js/components/interactions/engagement-lightbox.js
import { esc, fmtTime } from './utils.js';
import { call } from '../../api.js';
import { identityCss, identityHtml, bindCopyClicks } from '../../lib/identity.js';

function sortChronoAsc(items){
  // chronological (oldest → newest)
  return items.slice().sort((a,b) => (new Date(a.when||0).getTime() - new Date(b.when||0).getTime()));
}

export class BskyEngagementLightbox extends HTMLElement {
  constructor(){ super(); this.attachShadow({mode:'open'}); this.state = { open:false, type:'likes', uri:'', items:[], followMap:{} }; }

  open({ type, uri, replies=[] }){
    this.state = { ...this.state, open:true, type, uri, items:[], followMap:{} };
    this.render();
    if (type === 'likes') this.loadLikes();
    else if (type === 'reposts') this.loadReposts();
    else if (type === 'replies') this.loadReplies(replies);
  }
  close(){ this.state.open=false; this.render(); }

  async loadLikes(){
    try {
      const res = await call('getLikes', { uri: this.state.uri, limit: 100 });
      const items = (res?.likes || []).map(l => ({
        did: l.actor?.did,
        handle: l.actor?.handle,
        displayName: l.actor?.displayName,
        avatar: l.actor?.avatar,
        when: l.indexedAt || l.createdAt
      }));
      await this.enrichFollow(items);
    } catch(e){ this.shadowRoot.getElementById('err')?.replaceChildren(document.createTextNode(e.message)); }
  }
  async loadReposts(){
    try {
      const res = await call('getRepostedBy', { uri: this.state.uri, limit: 100 });
      const items = (res?.repostedBy || []).map(a => ({
        did: a?.did,
        handle: a?.handle,
        displayName: a?.displayName,
        avatar: a?.avatar,
        when: a.indexedAt
      }));
      await this.enrichFollow(items);
    } catch(e){ this.shadowRoot.getElementById('err')?.replaceChildren(document.createTextNode(e.message)); }
  }
  async loadReplies(replies){
    const items = (replies || []).map(p => ({
      did: p?.author?.did,
      handle: p?.author?.handle,
      displayName: p?.author?.displayName,
      avatar: p?.author?.avatar,
      when: p?.record?.createdAt
    }));
    await this.enrichFollow(items);
  }

  async enrichFollow(items){
    const dids = Array.from(new Set(items.map(i => i.did).filter(Boolean)));
    let followMap = {};
    try {
      const rel = await call('getRelationships', { actors: dids });
      (rel.relationships || []).forEach(r => { followMap[r.did] = { following: !!r.following }; });
    } catch {}
    this.state.items = sortChronoAsc(items);
    this.state.followMap = followMap;
    this.render();
  }

  connectedCallback(){
    bindCopyClicks(this.shadowRoot);
    this.shadowRoot.addEventListener('click', (e) => {
      if (e.target.id === 'close' || (e.target.id === 'overlay' && e.target === e.currentTarget)) this.close();
      const didBtn = e.target.closest('[data-follow-did]');
      if (didBtn) this.followOne(didBtn.getAttribute('data-follow-did'), didBtn);
      if (e.target.id === 'follow-all') this.followAll();
    });
    this.render();
  }

  async followOne(did, btn){
    if (!did) return;
    btn?.setAttribute('disabled','disabled');
    try {
      await call('follow', { did });
      this.state.followMap[did] = { following:true };
      this.render(); // quick refresh
    } catch (e) { alert('Follow failed: ' + e.message); btn?.removeAttribute('disabled'); }
  }
  async followAll(){
    const dids = this.state.items.map(i => i.did).filter(did => did && !this.state.followMap[did]?.following);
    if (!dids.length) return;
    const btn = this.shadowRoot.getElementById('follow-all');
    btn?.setAttribute('disabled','disabled');
    try {
      await call('followMany', { dids });
      dids.forEach(did => this.state.followMap[did] = { following:true });
      this.render();
    } catch (e) { alert('Bulk follow failed: ' + e.message); btn?.removeAttribute('disabled'); }
  }

  render(){
    const { open, type, items, followMap } = this.state;
    this.shadowRoot.innerHTML = open ? `
      <style>
        #overlay{ position:fixed; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:center; justify-content:center; z-index:999999; }
        .modal{ background:#0b0b0b; color:#fff; border:1px solid #444; border-radius: var(--bsky-radius, 0px); width:min(720px, 96vw); max-height:90vh; overflow:auto; }
        .head{ display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid #333; position:sticky; top:0; background:#0b0b0b; }
        .title{ font-weight:700; }
        #close, #follow-all{ background:#111; border:1px solid #555; color:#fff; padding:6px 10px; border-radius: var(--bsky-radius, 0px); cursor:pointer }
        a{ color:#fff; text-decoration:underline }
        a:hover{ color:#aaa }

        /* Make any embedded media fill modal width */
        .modal img:not(.avatar), .modal video, .modal .embed, .modal .thumb{
          width:100%; height:auto; max-width:100%;
          display:block;
        }

        .list{ padding:10px 12px; display:grid; gap:0 }
        .row{ display:flex; align-items:center; gap:10px; border:1px solid #333; border-radius: var(--bsky-radius, 0px); padding:2px }
        .avatar{
          width:48px; height:48px; border-radius: var(--bsky-radius, 0px); object-fit:cover; flex:0 0 auto;
          max-width:300px; /* hard cap to prevent stretch if external CSS leaks */
        }
        .who{ flex:1 1 auto; min-width:0 }
        .name{ font-weight:700 }
        .sub{ color:#bbb; font-size:.9rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
        .btn{ background:#111; border:1px solid #555; color:#fff; padding:6px 10px; border-radius: var(--bsky-radius, 0px); cursor:pointer }
        ${identityCss}
      </style>
      <div id="overlay">
        <div class="modal" role="dialog" aria-modal="true">
          <div class="head">
            <div class="title">${type === 'likes' ? 'Likes' : type === 'reposts' ? 'Reposts' : 'Replies'}</div>
            <div style="display:flex; gap:8px">
              <button id="follow-all" ${items.every(i => followMap[i.did]?.following) ? 'disabled' : ''}>Follow all</button>
              <button id="close">✕</button>
            </div>
          </div>
          <div id="err" style="color:#f88; padding:8px 12px"></div>
          <div class="list">
            ${items.map(i => `
              <div class="row">
                ${i.avatar ? `<img class="avatar" src="${esc(i.avatar)}" alt="">` : ''}
                <div class="who">
                  <div class="name">${identityHtml({ did: i.did, handle: i.handle, displayName: i.displayName }, { showHandle: true, showCopyDid: true })}</div>
                  <div class="sub">@${esc(i.handle || '')} • ${esc(fmtTime(i.when || ''))}</div>
                </div>
                ${followMap[i.did]?.following
                  ? '<span class="sub">Following</span>'
                  : `<button class="btn" data-follow-did="${esc(i.did)}">Follow</button>`}
              </div>
            `).join('') || '<div class="sub" style="padding:8px">No entries.</div>'}
          </div>
        </div>
      </div>
    ` : '';
  }
}
customElements.define('bsky-engagement-lightbox', BskyEngagementLightbox);
