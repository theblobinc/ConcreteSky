// application/single_pages/bluesky_feed/js/components/interactions/other-replies.js
import { esc, countsOf, renderPostCard } from './utils.js';

function nodeHasKeyword(node, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    const txt = String(n?.post?.record?.text || n?.record?.text || '').toLowerCase();
    if (txt.includes(needle)) return true;
    const kids = Array.isArray(n?.replies) ? n.replies : [];
    for (const k of kids) stack.push(k);
  }
  return false;
}

export class BskyOtherReplies extends HTMLElement {
  constructor(){
    super();
    this._thread = null;   // parentThread
    this._subject = null;
    this._meDid = null;
    this.state = { sort:'chrono', hours:24, search:'' };
  }

  static get observedAttributes(){ return ['hours','sort']; }
  attributeChangedCallback(n,_o,v){
    if (n==='hours') this.state.hours = Number(v||24);
    if (n==='sort')  this.state.sort  = (v==='reach'?'reach':'chrono');
    this.renderList(); // partial
  }

  set data({ parentThread, subject, meDid }){
    this._thread = parentThread; this._subject = subject; this._meDid = meDid;
    this.render(); // full first time
  }

  connectedCallback(){
    this.attachShadow({mode:'open'});
    this.shadowRoot.addEventListener('input', (e) => {
      if (e.target?.dataset?.ctrl === 'search') {
        this.state.search = e.target.value || '';
        this.renderList(e.target); // partial, keep focus
      }
    });
    this.shadowRoot.addEventListener('change', (e) => {
      if (e.target?.dataset?.ctrl === 'sort') {
        this.state.sort = e.target.value === 'reach' ? 'reach' : 'chrono';
        this.renderList();
      }
      if (e.target?.dataset?.ctrl === 'hours') {
        const v = Number(e.target.value || 24);
        this.state.hours = Number.isFinite(v) ? v : 24;
        this.renderList();
      }
    });
    this.shadowRoot.addEventListener('click', (e) => {
      const actBtn = e.target.closest('[data-action][data-uri]');
      if (actBtn) {
        const detail = {
          action: actBtn.getAttribute('data-action'),
          uri: actBtn.getAttribute('data-uri') || '',
          cid: actBtn.getAttribute('data-cid') || '',
          likeRec: actBtn.getAttribute('data-like-rec') || '',
          repostRec: actBtn.getAttribute('data-repost-rec') || '',
        };
        this.dispatchEvent(new CustomEvent('post-action', { detail, bubbles:true, composed:true }));
        return;
      }
      const openBtn = e.target.closest?.('[data-open-engagement][data-engagement-uri]');
      if (openBtn) {
        const type = openBtn.getAttribute('data-open-engagement');
        const uri  = openBtn.getAttribute('data-engagement-uri') || '';
        if (type === 'replies') {
          const replies = this.collectImmediateReplies(uri);
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
      }
    });
    this.render();
  }

  /* ---------- helpers for engagement ---------- */
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

  collectImmediateReplies(uri){
    const node = this.findNodeByUri(uri);
    if (!node) return [];
    const kids = Array.isArray(node.replies) ? node.replies : [];
    const out = [];
    for (const ch of kids) if (ch?.post) out.push(ch.post);
    return out;
  }

  /* ---------- rendering ---------- */
  render(){
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block}
        a{ color:#fff; text-decoration:underline }
        a:hover{ color:#aaa }
        .sub-controls{ display:flex; gap:12px; align-items:center; justify-content:space-between; margin:0 0 8px; }
        .sub-controls label{ color:#ddd; display:inline-flex; gap:6px; align-items:center }
        .sub-controls select, .sub-controls input[type="search"]{
          background:#0e0e0e; color:#fff; border:1px solid #444; border-radius:8px; padding:6px 8px;
        }
        .thread-node{ margin-top:8px; }
        .thread-node .post{ border:2px dotted rgba(255,255,255,0.9); border-radius:10px; padding:10px; background:#0b0b0b; margin-left: calc(var(--indent, 0) * 12px); }
        .thread-children{ margin-left: 12px; }
        .post img:not(.av), .post video, .post .embed, .post .thumb{
          width:100%; height:auto; max-width:100%;
          display:block;
        }

        /* counts bar */
        .counts{
          display:flex; gap:8px; align-items:center; margin-top:6px;
        }
        .counts .c{
          background:#0b0b0b; color:#ddd; border:1px solid #333; border-radius:9999px;
          padding:4px 10px; cursor:pointer; font-size:.95rem;
        }
        .counts .c:hover{ background:#111; }

        .actions{ display:flex; gap:8px; flex-wrap:wrap; margin-top:6px }
        .act-btn{ background:#111; border:1px solid #555; color:#fff; padding:6px 10px; border-radius:8px; cursor:pointer }
        .act-btn.small{ padding:4px 8px; font-size:.9rem }

        /* Avatar sizing (cap + a tad bigger ask: 300px max) */
        .post img.av{
          width:40px !important;
          height:40px !important;
          max-width:300px !important;
          border-radius:50%;
          object-fit:cover;
          display:inline-block !important;
          flex:0 0 auto;
        }
      </style>
      <div class="sub-controls">
        <div class="left">
          <label>Sort
            <select data-ctrl="sort" value="${esc(this.state.sort)}">
              <option value="chrono" ${this.state.sort==='chrono'?'selected':''}>Chronological</option>
              <option value="reach"  ${this.state.sort==='reach' ?'selected':''}>Reach</option>
            </select>
          </label>
          <label>Range
            <select data-ctrl="hours">
              <option value="24"  ${this.state.hours===24?'selected':''}>Last 24h</option>
              <option value="72"  ${this.state.hours===72?'selected':''}>Last 3 days</option>
              <option value="168" ${this.state.hours===168?'selected':''}>Last 7 days</option>
              <option value="720" ${this.state.hours===720?'selected':''}>Last 30 days</option>
              <option value="0"   ${this.state.hours===0?'selected':''}>All</option>
            </select>
          </label>
        </div>
        <div class="right">
          <input data-ctrl="search" type="search" placeholder="Search keyword…" value="${esc(this.state.search)}">
        </div>
      </div>
      <div id="list"></div>
    `;
    this.renderList();
  }

  renderList(focusedEl=null){
    const list = this.shadowRoot.getElementById('list');
    if (!list) return;

    // preserve caret
    let selStart=null, selEnd=null, restore=false;
    if (focusedEl && focusedEl.dataset?.ctrl==='search') {
      restore = true;
      try { selStart = focusedEl.selectionStart; selEnd = focusedEl.selectionEnd; } catch {}
    }

    const thread = this._thread;
    const subject = this._subject;
    const meDid = this._meDid;

    if (!thread) { list.innerHTML = '<div class="muted">No replies.</div>'; return; }

    const now = Date.now();
    const cutoff = this.state.hours > 0 ? (now - this.state.hours*3600*1000) : 0;
    const search = (this.state.search || '').trim();

    let children = Array.isArray(thread.replies) ? thread.replies.slice() : [];
    children = children.filter(n => (n?.post?.uri || '') !== (subject?.uri || ''));

    const postTimeMs = (p) => {
      try {
        const iso = p?.record?.createdAt || p?.indexedAt || '';
        const ts = new Date(iso).getTime();
        return Number.isNaN(ts) ? 0 : ts;
      } catch {
        return 0;
      }
    };

    const textOf = (n) => {
      try {
        return String(n?.post?.record?.text || n?.record?.text || '').toLowerCase();
      } catch {
        return '';
      }
    };

    const matchSelf = (n, q) => {
      if (!q) return true;
      const needle = String(q || '').toLowerCase();
      if (!needle) return true;
      return textOf(n).includes(needle);
    };

    const pruneNode = (node, depth = 0) => {
      if (!node || !node.post) return null;
      const kids = Array.isArray(node.replies) ? node.replies : [];
      const prunedKids = [];
      for (const k of kids) {
        const pk = pruneNode(k, depth + 1);
        if (pk) prunedKids.push(pk);
      }

      const ts = postTimeMs(node.post);
      const timeOk = !cutoff || (ts >= cutoff);
      const kwOkSelf = !search || matchSelf(node, search);
      const kwOk = !search || kwOkSelf || prunedKids.length > 0;

      // Keep context nodes if they lead to kept descendants.
      const keep = kwOk && (timeOk || prunedKids.length > 0);
      if (!keep) return null;

      return {
        post: node.post,
        replies: prunedKids,
      };
    };

    // Prune each top-level reply subtree based on time/search.
    children = children.map((n) => pruneNode(n, 0)).filter(Boolean);

    const withMeta = children.map(n => {
      const p = n?.post || {};
      const c = countsOf(p);
      return { node:n, post:p, reach:c.reach, time:new Date(p?.record?.createdAt || p?.indexedAt || 0).getTime() || 0 };
    });

    const mine   = withMeta.filter(x => (x.post?.author?.did || '') === (meDid || ''));
    const others = withMeta.filter(x => (x.post?.author?.did || '') !== (meDid || ''));

    const sortFn = (a,b) => {
      if (this.state.sort === 'reach') return (b.reach - a.reach) || (b.time - a.time);
      return (b.time - a.time) || (b.reach - a.reach);
    };
    mine.sort(sortFn); others.sort(sortFn);
    const ordered = [...mine, ...others].map(x => x.node);

    const sortKidsChronoAsc = (kids) => {
      return kids.slice().sort((a, b) => postTimeMs(a?.post) - postTimeMs(b?.post));
    };

    const renderNode = (n, depth = 0) => {
      if (!n || !n.post) return '';
      const p = n.post;
      const indent = Math.min(depth, 6);
      const uri = esc(p?.uri || '');
      const cid = esc(p?.cid || '');
      const liked = !!p?.viewer?.like;
      const reposted = !!p?.viewer?.repost;
      const likeRec = esc(p?.viewer?.like || '');
      const repostRec = esc(p?.viewer?.repost || '');

      const c = countsOf(p);
      const kids = Array.isArray(n.replies) ? sortKidsChronoAsc(n.replies) : [];
      const kidsHtml = kids.map((k) => renderNode(k, depth + 1)).join('');

      return `
        <div class="thread-node" style="--indent:${indent}">
          ${renderPostCard(p)}

          <div class="counts">
            <button class="c" data-open-engagement="replies" data-engagement-uri="${uri}" title="View comments">💬 ${c.replies}</button>
            <button class="c" data-open-engagement="likes"   data-engagement-uri="${uri}" title="View likes">❤️ ${c.likes}</button>
            <button class="c" data-open-engagement="reposts" data-engagement-uri="${uri}" title="View reposts">🔁 ${c.reposts}</button>
          </div>

          <div class="actions">
            <button class="act-btn" data-action="${liked?'unlike':'like'}" data-uri="${uri}" data-cid="${cid}" ${likeRec?`data-like-rec="${likeRec}"`:''}>
              ${liked ? 'Liked ❤️' : 'Like'}
            </button>
            <button class="act-btn" data-action="${reposted?'unrepost':'repost'}" data-uri="${uri}" data-cid="${cid}" ${repostRec?`data-repost-rec="${repostRec}"`:''}>
              ${reposted ? 'Reposted 🔁' : 'Repost'}
            </button>
          </div>

          ${kidsHtml ? `<div class="thread-children">${kidsHtml}</div>` : ''}
        </div>
      `;
    };

    const html = ordered.map((n) => renderNode(n, 0)).join('');

    list.innerHTML = html || '<div class="muted">No matching replies in this range.</div>';

    if (restore) {
      const input = this.shadowRoot.querySelector('[data-ctrl="search"]');
      if (input) {
        input.focus();
        try { if (selStart != null && selEnd != null) input.setSelectionRange(selStart, selEnd); } catch {}
      }
    }
  }
}
customElements.define('bsky-other-replies', BskyOtherReplies);
