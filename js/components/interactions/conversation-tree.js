// application/single_pages/bluesky_feed/js/components/interactions/conversation-tree.js
import { esc, renderPostCard, countsOf } from './utils.js';

function renderCountsBar(p){
  const uri = p?.uri || '';
  const c = countsOf(p); // { replies, likes, reposts, reach }
  return `
    <div class="counts">
      <button class="c" data-open-engagement="replies" data-engagement-uri="${esc(uri)}" title="View comments">💬 ${c.replies}</button>
      <button class="c" data-open-engagement="likes"   data-engagement-uri="${esc(uri)}" title="View likes">❤️ ${c.likes}</button>
      <button class="c" data-open-engagement="reposts" data-engagement-uri="${esc(uri)}" title="View reposts">🔁 ${c.reposts}</button>
    </div>
  `;
}

function renderActions(p){
  const uri = p?.uri || '';
  const cid = p?.cid || '';
  const viewer = p?.viewer || {};
  const liked = !!viewer?.like;
  const reposted = !!viewer?.repost;
  const likeRec = viewer?.like || '';
  const repostRec = viewer?.repost || '';

  return `
    <div class="actions">
      <button class="act-btn" data-reply-toggle-uri="${esc(uri)}">Reply</button>
      <button class="act-btn" data-action="${liked?'unlike':'like'}" data-uri="${esc(uri)}" data-cid="${esc(cid)}" ${likeRec?`data-like-rec="${esc(likeRec)}"`:''}>
        ${liked ? 'Liked ❤️' : 'Like'}
      </button>
      <button class="act-btn" data-action="${reposted?'unrepost':'repost'}" data-uri="${esc(uri)}" data-cid="${esc(cid)}" ${reposted?`data-repost-rec="${esc(repostRec)}"`:''}>
        ${reposted ? 'Reposted 🔁' : 'Repost'}
      </button>
    </div>
  `;
}

function renderNode(node, depth=0){
  if (!node) return '';
  const post = node.post || node;
  const indent = Math.min(depth, 6);
  const inner = renderPostCard(post) + renderCountsBar(post) + renderActions(post);
  const kids = Array.isArray(node.replies) ? node.replies.map(ch => renderNode(ch, depth+1)).join('') : '';
  return `
    <div class="thread-node" style="--indent:${indent}">
      ${inner}
      ${kids ? `<div class="thread-children">${kids}</div>` : ''}
    </div>
  `;
}

export class BskyConversationTree extends HTMLElement {
  set thread(v){ this._thread = v; this.render(); }
  get thread(){ return this._thread; }

  set hideRoot(v){ this._hideRoot = !!v; this.render(); }
  get hideRoot(){ return !!this._hideRoot; }

  connectedCallback(){
    this.attachShadow({mode:'open'});
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
    this.render();
  }

  // find the subtree node by a post URI
  findNodeByUri(uri){
    const root = this._thread;
    if (!root || !uri) return null;
    const stack = [root];
    while (stack.length){
      const n = stack.pop();
      const p = n?.post || n;
      if ((p?.uri || '') === uri) return n;
      if (Array.isArray(n?.replies)) stack.push(...n.replies);
    }
    return null;
  }

  // collect immediate replies’ post objects for a given node
  collectRepliesFor(uri){
    const node = this.findNodeByUri(uri);
    if (!node) return [];
    const replies = [];
    const kids = Array.isArray(node.replies) ? node.replies : [];
    for (const ch of kids){
      if (ch?.post) replies.push(ch.post);
    }
    return replies;
  }

  onClick(e){
    const actBtn = e.target.closest('[data-action][data-uri]');
    if (actBtn) {
      const action = actBtn.getAttribute('data-action');
      const detail = {
        action,
        uri: actBtn.getAttribute('data-uri') || '',
        cid: actBtn.getAttribute('data-cid') || '',
        likeRec: actBtn.getAttribute('data-like-rec') || '',
        repostRec: actBtn.getAttribute('data-repost-rec') || '',
      };
      this.dispatchEvent(new CustomEvent('post-action', { detail, bubbles: true, composed: true }));
      return;
    }

    // counts open lightbox
    const openBtn = e.target.closest('[data-open-engagement][data-engagement-uri]');
    if (openBtn) {
      const type = openBtn.getAttribute('data-open-engagement');
      const uri  = openBtn.getAttribute('data-engagement-uri') || '';
      if (type === 'replies') {
        const replies = this.collectRepliesFor(uri);
        this.dispatchEvent(new CustomEvent('open-engagement', {
          detail: { type:'replies', uri, replies },
          bubbles: true, composed: true
        }));
      } else {
        this.dispatchEvent(new CustomEvent('open-engagement', {
          detail: { type, uri },
          bubbles: true, composed: true
        }));
      }
      return;
    }

    const tgl = e.target.closest('[data-reply-toggle-uri]');
    if (tgl) {
      const uri = tgl.getAttribute('data-reply-toggle-uri');
      this.dispatchEvent(new CustomEvent('open-reply', { detail: { uri }, bubbles: true, composed: true }));
    }
  }

  render(){
    if (!this.shadowRoot) return;
    const t = this._thread;
    const hideRoot = !!(this._hideRoot || this.hasAttribute('hide-root') || this.hasAttribute('data-hide-root'));

    const renderThread = () => {
      if (!t) return '<div class="muted">No conversation.</div>';
      if (!hideRoot) return renderNode(t, 0);
      const kids = Array.isArray(t?.replies) ? t.replies : [];
      if (!kids.length) return '<div class="muted">No replies yet.</div>';
      return kids.map((ch) => renderNode(ch, 0)).join('');
    };

    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block}
        a{ color:#fff; text-decoration:underline }
        a:hover{ color:#aaa }
        .thread-node{ margin-top:8px; }
        .thread-node .post{ border:2px dotted rgba(255,255,255,0.9); border-radius:10px; padding:10px; background:#0b0b0b; margin-left: calc(var(--indent, 0) * 12px); }
        .thread-children{ margin-left: 12px; }

        /* media inside cards should fill container width */
        .post img:not(.av), .post video, .post .embed, .post .thumb{
          width:100%; height:auto; max-width:100%;
          display:block;
        }

        /* counts bar */
        .counts{
          display:flex; gap:8px; align-items:center; margin-top:6px;
        }
        .counts .c{
          background:#0b0b0b; color:#ddd!important; border:1px solid #333; border-radius:9999px;
          padding:4px 10px; cursor:pointer; font-size:.95rem; color: white;
        }
        .counts .c:hover{ background:#111!important; }

        .actions{ display:flex; gap:8px; flex-wrap:wrap; margin-top:6px }
        .act-btn{ background:#111; border:1px solid #555; color:#fff; padding:6px 10px; border-radius:8px; cursor:pointer }
        .act-btn.small{ padding:4px 8px; font-size:.9rem }

        /* Avatar sizing */
        .post img.av{
          width:40px !important;
          height:40px !important;
          max-width:300px !important;
          border-radius:50%;
          object-fit:cover;
          display:inline-block !important;
          flex:0 0 auto;
        }

        .post header.meta{ display:flex; align-items:center; gap:10px }
        .post .text{ white-space:pre-wrap; line-height:1.35; margin-top:6px }
      </style>
      ${renderThread()}
    `;
  }
}
customElements.define('bsky-conversation-tree', BskyConversationTree);

