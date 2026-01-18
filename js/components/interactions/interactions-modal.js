// application/single_pages/bluesky_feed/js/components/interactions/interactions-modal.js
import { call } from '../../api.js';
import { esc, countsOf, renderCountsClickable, renderPostCard } from './utils.js';
import './conversation-tree.js';
import './other-replies.js';
import './engagement-lightbox.js';
import { identityCss, bindCopyClicks } from '../../lib/identity.js';
import { resolveMentionDidsFromTexts, buildFacetsSafe, defaultLangs } from '../../controllers/compose_controller.js';
import { syncRecent } from '../../controllers/cache_sync_controller.js';

const postCache   = new Map(); // uri -> post
const threadCache = new Map(); // uri -> thread

export class BskyInteractionsModal extends HTMLElement {
  constructor(){
    super(); this.attachShadow({mode:'open'});
    this.state = {
      open:false, uri:'', cid:'',
      loading:false, error:null,
      meDid:null, subject:null, parent:null,
      subjectThread:null, parentThread:null,
    };
    this._initial = null; // 'likes' | 'reposts' | 'replies' (optional auto-open)
  }

  static get observedAttributes(){ return ['uri','cid','initial']; }
  attributeChangedCallback(n,_o,v){
    if (n==='uri') this.state.uri = v||'';
    if (n==='cid') this.state.cid = v||'';
    if (n==='initial') this._initial = String(v || '').toLowerCase();
  }

  open(){ this.state.open = true; this.render(); this.loadAll(); }
  close(){ this.state.open = false; this.remove(); }

  connectedCallback(){
    this.render();
    bindCopyClicks(this.shadowRoot);
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
    this.shadowRoot.addEventListener('post-action', (e) => this.onPostAction(e.detail), { capture:true });
    // allow children to request opening the engagement lightbox
    this.shadowRoot.addEventListener('open-engagement', (e) => {
      const { type, uri, replies=[] } = e.detail || {};
      const lb = this.shadowRoot.querySelector('bsky-engagement-lightbox');
      if (!lb) return;
      if (type === 'replies') lb.open({ type, uri, replies });
      else lb.open({ type: (type || 'likes'), uri });
    }, { capture:true });
  }

  async loadAll(){
    if (!this.state.uri || this.state.loading) return;
    this.state.loading = true; this.state.error = null; this.render();
    try {
      if (!this.state.meDid) {
        try {
          const me = await call('getProfile', {});
          this.state.meDid = me?.did || null;
          window.BSKY = window.BSKY || {};
          window.BSKY.meDid = this.state.meDid;
        } catch {}
      }

      const subject = await this.getOnePost(this.state.uri);
      this.state.subject = subject || null;

      const parentUri = subject?.record?.reply?.parent?.uri || null;
      this.state.parent = parentUri ? await this.getOnePost(parentUri) : null;

      this.state.subjectThread = await this.getThread(subject?.uri);
      this.state.parentThread  = parentUri ? await this.getThread(parentUri) : null;

    } catch (e) {
      this.state.error = e.message;
    } finally {
      this.state.loading = false;
      this.render();

      // Only auto-open if developer explicitly asks via `initial` attribute
      const want = (this._initial && ['likes','reposts','replies'].includes(this._initial)) ? this._initial : null;
      if (want) {
        const lb = this.shadowRoot.querySelector('bsky-engagement-lightbox');
        if (lb) {
          if (want === 'replies') {
            const replies = [];
            const stack = Array.isArray(this.state.subjectThread?.replies) ? [...this.state.subjectThread.replies] : [];
            while (stack.length) {
              const node = stack.shift();
              if (node?.post) replies.push(node.post);
              if (Array.isArray(node?.replies)) stack.push(...node.replies);
            }
            lb.open({ type:'replies', uri:this.state.uri, replies });
          } else {
            lb.open({ type: want, uri: this.state.uri });
          }
        }
        this._initial = null; // only auto-open once
      }
    }
  }

  async getOnePost(uri){
    if (!uri) return null;
    if (postCache.has(uri)) return postCache.get(uri);
    try {
      const res = await call('getPosts', { uris:[uri] });
      const p = (res?.posts || [])[0] || null;
      if (p) postCache.set(uri, p);
      return p;
    } catch { return null; }
  }

  async refreshOnePost(uri){
    try {
      const res = await call('getPosts', { uris:[uri] });
      const p = (res?.posts || [])[0] || null;
      if (!p) return;
      postCache.set(uri, p);
      if (this.state.subject?.uri === uri) this.state.subject = p;
      if (this.state.parent?.uri  === uri) this.state.parent  = p;
      const repl = (node) => {
        if (!node) return;
        if (node.post?.uri === uri) node.post = p;
        if (Array.isArray(node.replies)) node.replies.forEach(repl);
      };
      repl(this.state.subjectThread);
      repl(this.state.parentThread);
      this.render();
    } catch {}
  }

  async getThread(uri){
    if (!uri) return null;
    if (threadCache.has(uri)) return threadCache.get(uri);
    try {
      const res = await call('getPostThread', { uri, depth: 10, parentHeight: 6 });
      const view = res?.thread || res?.view || res || null;
      if (view) threadCache.set(uri, view);
      return view;
    } catch { return null; }
  }

  onClick(e){
    const overlay = e.target.closest?.('#overlay');
    if (overlay && e.target === overlay) { this.close(); return; }
    if (e.target.closest?.('#close')) { this.close(); return; }

    // counts → engagement lightbox for top sections (fallback handler)
    const openBtn = e.target.closest?.('[data-open-engagement]');
    if (openBtn) {
      const type = openBtn.getAttribute('data-open-engagement'); // likes|reposts|replies
      const lb = this.shadowRoot.querySelector('bsky-engagement-lightbox');
      if (!lb) return;
      if (type === 'replies') {
        const replies = [];
        const stack = Array.isArray(this.state.subjectThread?.replies) ? [...this.state.subjectThread.replies] : [];
        while (stack.length) {
          const node = stack.shift();
          if (node?.post) replies.push(node.post);
          if (Array.isArray(node?.replies)) stack.push(...node.replies);
        }
        lb.open({ type:'replies', uri:this.state.uri, replies });
      } else {
        lb.open({ type, uri:this.state.uri });
      }
      return;
    }
  }

  async onPostAction({ action, uri, cid /*, likeRec, repostRec*/ }){
    try {
      if (action === 'like')    await call('like',    { uri, cid });
      if (action === 'unlike')  await call('unlike',  { uri, cid });
      if (action === 'repost')  await call('repost',  { uri, cid });
      if (action === 'unrepost')await call('unrepost',{ uri, cid });
      await this.refreshOnePost(uri);

      // Broadcast engagement changes so other panels (Posts / thread tree) can update.
      try {
        const p = postCache.get(uri) || this.state?.subject;
        if (p && String(p?.uri || '') === String(uri || '')) {
          const liked = !!(p?.viewer && p.viewer.like);
          const reposted = !!(p?.viewer && p.viewer.repost);
          const likeCount = (typeof p?.likeCount === 'number') ? p.likeCount : null;
          const repostCount = (typeof p?.repostCount === 'number') ? p.repostCount : null;

          if (action === 'like' || action === 'unlike') {
            window.dispatchEvent(new CustomEvent('bsky-like-changed', {
              detail: { uri, cid, liked, likeCount },
            }));
          }
          if (action === 'repost' || action === 'unrepost') {
            window.dispatchEvent(new CustomEvent('bsky-repost-changed', {
              detail: { uri, cid, reposted, repostCount },
            }));
          }
        }
      } catch {}

      // Ask the throttled cache sync to run so cache-based panels can refresh.
      try {
        await syncRecent({ minutes: 5, refreshMinutes: 30, allowDirectFallback: false });
      } catch {}
    } catch (e) {
      alert(`Action failed: ${e.message}`);
    }
  }

  render(){
    if (!this.state.open) { this.shadowRoot.innerHTML = ''; return; }

    const { loading, error, subject, parent, subjectThread, parentThread, meDid } = this.state;
    const subjCounts = countsOf(subject);
    const parentCounts = countsOf(parent);

    // sections: In reply to (top) → Your post (counts clickable) → Conversation → Other replies
    this.shadowRoot.innerHTML = `
      <style>
        :host{ all: initial; }
        a{ color:#fff; text-decoration:underline }
        a:hover{ color:#aaa }
        #overlay{ position:fixed; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:center; justify-content:center; z-index:999999; }
        .modal{ background:#0b0b0b; color:#fff; border:1px solid #444; border-radius:12px; width:min(1100px, 96vw); max-height:92vh; overflow:auto; box-shadow:0 10px 40px rgba(0,0,0,.6); }
        .head{ display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid #333; position:sticky; top:0; background:#0b0b0b; }
        .title{ font-weight:700 }
        #close{ background:#111; border:1px solid #555; color:#fff; padding:6px 10px; border-radius:8px; cursor:pointer }
        .body{ padding:12px 14px; }
        .ctx{ border:1px solid #333; border-radius:10px; padding:10px; background:#0f0f0f; }
        .ctx + .ctx{ margin-top:10px }
        .ctx-title{ color:#bbb; font-size:.95rem; margin:4px 0 10px; font-weight:600 }
        .counts{ display:flex; gap:10px; color:#ddd; font-size:.95rem; margin-top:6px }
        .counts .c{ display:inline-flex; gap:6px; align-items:center; padding:4px 10px; border:1px solid #333; border-radius:999px; background:#0b0b0b; cursor:pointer; color:#ddd; }
        .reply-box textarea{ width:100%; min-height:80px; background:#0e0e0e; color:#fff; border:1px solid #444; border-radius:8px; padding:8px; margin-top:6px }
        .reply-box button{ background:#111; border:1px solid #555; color:#fff; padding:6px 10px; border-radius:8px; cursor:pointer }

        /* Media in posts inside modal should fill the width */
        .modal .post img:not(.av), .modal .post video, .modal .post .embed, .modal .post .thumb{
          width:100%; height:auto; max-width:100%;
          display:block;
        }

        /* Avatar sizing in posts inside modal */
        .ctx .post img.av{
          width:40px !important;
          height:40px !important;
          max-width:300px !important;
          border-radius:50%;
          object-fit:cover;
          display:inline-block !important;
          flex:0 0 auto;
        }

        ${identityCss}
      </style>

      <div id="overlay">
        <div class="modal" role="dialog" aria-modal="true">
          <div class="head">
            <div class="title">Interactions</div>
            <button id="close">✕</button>
          </div>
          <div class="body">
            ${loading ? '<div class="muted">Loading…</div>' : ''}
            ${error ? `<div class="err">Error: ${esc(error)}</div>` : ''}

            <div class="ctx">
              <div class="ctx-title">In reply to</div>
              ${parent ? renderPostCard(parent) : '<div class="muted">No parent post.</div>'}
              ${parent ? renderCountsClickable(parentCounts) : ''}
            </div>

            ${(() => {
              // Your other comment trees on the same parent (besides the current subject)
              const me = meDid || '';
              const subjUri = subject?.uri || '';
              const nodes = Array.isArray(parentThread?.replies) ? parentThread.replies.filter(n =>
                (n?.post?.author?.did === me) && (n?.post?.uri !== subjUri)
              ) : [];
              if (!nodes.length) return '';
              return `
                <div class="ctx" id="my-other-comments">
                  <div class="ctx-title">Your other comments on this post</div>
                  <div class="mine-list">${nodes.map((_,i)=>`<div class="mine-item" data-idx="${i}"></div>`).join('')}</div>
                </div>
              `;
            })()}

            <div class="ctx">
              <div class="ctx-title">Your post</div>
              ${subject ? renderPostCard(subject) : '<div class="muted">Unavailable</div>'}
              ${renderCountsClickable(subjCounts)}
              ${(subject?.uri && subject?.cid) ? `
                <div class="reply-box">
                  <textarea id="reply-subject-text" placeholder="Write a reply…"></textarea>
                  <div style="margin-top:8px"><button id="reply-subject">Reply</button></div>
                </div>` : ''
              }
            </div>

            <div class="ctx">
              <div class="ctx-title">Conversation</div>
              <bsky-conversation-tree></bsky-conversation-tree>
            </div>

            <div class="ctx">
              <div class="ctx-title">Other replies to that post</div>
              <bsky-other-replies></bsky-other-replies>
            </div>
          </div>

          <bsky-engagement-lightbox></bsky-engagement-lightbox>
        </div>
      </div>
    `;

    // hydrate main conversation tree
    const conv = this.shadowRoot.querySelector('bsky-conversation-tree');
    const threadRoot = (t) => {
      try {
        let cur = t;
        while (cur?.parent?.post) cur = cur.parent;
        return cur || t;
      } catch {
        return t;
      }
    };
    if (conv) {
      conv.thread = threadRoot(subjectThread);
      // Root/subject/parent are rendered in the sections above; avoid duplicating root here.
      try { conv.hideRoot = true; } catch { try { conv.setAttribute('hide-root', ''); } catch {} }
    }

    // hydrate "other replies"
    const others = this.shadowRoot.querySelector('bsky-other-replies');
    if (others) others.data = { parentThread, subject, meDid };

    // hydrate "Your other comments" section with individual trees
    if (parentThread && meDid) {
      const subjUri = subject?.uri || '';
      const mineNodes = Array.isArray(parentThread.replies)
        ? parentThread.replies.filter(n => (n?.post?.author?.did === meDid) && (n?.post?.uri !== subjUri))
        : [];
      const wrap = this.shadowRoot.getElementById('my-other-comments');
      if (wrap && mineNodes.length) {
        const holders = wrap.querySelectorAll('.mine-item');
        holders.forEach((holder, i) => {
          const tree = document.createElement('bsky-conversation-tree');
          tree.thread = threadRoot(mineNodes[i]);
          try { tree.hideRoot = true; } catch { try { tree.setAttribute('hide-root', ''); } catch {} }
          holder.replaceChildren(tree);
        });
      }
    }

    // quick-reply to subject
    const replyBtn = this.shadowRoot.getElementById('reply-subject');
    if (replyBtn) {
      replyBtn.addEventListener('click', async () => {
        const ta = this.shadowRoot.getElementById('reply-subject-text');
        const txt = (ta?.value || '').trim();
        if (!txt) return;
        replyBtn.setAttribute('disabled','disabled');
        try {
          const subj = this.state.subject || null;
          const subjUri = String(subj?.uri || this.state.uri || '');
          const subjCid = String(subj?.cid || this.state.cid || '');
          const rootUri = String(subj?.record?.reply?.root?.uri || subjUri);
          const rootCid = String(subj?.record?.reply?.root?.cid || subjCid);

          const langs = defaultLangs();
          const didByHandle = await resolveMentionDidsFromTexts([txt]);
          const facets = buildFacetsSafe(txt, didByHandle);

          await call('createPost', {
            text: txt,
            langs,
            reply: { root:{ uri: rootUri, cid: rootCid }, parent:{ uri: subjUri, cid: subjCid } },
            ...(facets ? { facets } : {}),
          });
          if (ta) ta.value = '';
          // refresh
          await Promise.all([
            this.refreshOnePost(this.state.uri),
            this.getThread(this.state.subject?.uri).then(v => this.state.subjectThread = v),
            this.state.parent?.uri ? this.getThread(this.state.parent.uri).then(v => this.state.parentThread = v) : null
          ]);
          this.render();
        } catch (e) { alert('Reply failed: ' + e.message); }
        finally { replyBtn.removeAttribute('disabled'); }
      });
    }
  }
}
customElements.define('bsky-interactions-modal', BskyInteractionsModal);
