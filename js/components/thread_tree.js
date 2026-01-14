const esc = (s) => String(s || '').replace(/[<>&"]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[m]));

function pickText(post) {
  const rec = post?.record || {};
  return String(rec.text || '');
}

function pickAuthor(post) {
  const a = post?.author || {};
  const handle = a?.handle ? `@${a.handle}` : '';
  return a?.displayName ? `${a.displayName} ${handle}`.trim() : (handle || '');
}

function pickTime(post) {
  const rec = post?.record || {};
  const iso = rec?.createdAt || post?.indexedAt || '';
  try {
    return iso ? new Date(iso).toLocaleString() : '';
  } catch {
    return '';
  }
}

export class BskyThreadTree extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._thread = null; // getPostThread().thread
    this._replyTo = null; // { uri, author }
  }

  setThread(thread) {
    this._thread = thread || null;
    this.render();
  }

  setReplyTo(replyTo) {
    this._replyTo = replyTo || null;
    this.render();
  }

  connectedCallback() {
    this.render();
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
  }

  onClick(e) {
    const btn = e.target?.closest?.('[data-reply-uri]');
    if (btn) {
      const uri = btn.getAttribute('data-reply-uri') || '';
      const author = btn.getAttribute('data-reply-author') || '';
      this.dispatchEvent(new CustomEvent('bsky-reply-to', {
        detail: { uri, author },
        bubbles: true,
        composed: true,
      }));
      return;
    }
  }

  renderNode(node, depth) {
    const post = node?.post || null;
    const uri = post?.uri || '';
    const who = pickAuthor(post);
    const when = pickTime(post);
    const text = pickText(post);

    const replies = Array.isArray(node?.replies) ? node.replies : [];
    const hasReplies = replies.length > 0;

    return `
      <div class="node" style="--depth:${depth}">
        <div class="card">
          <div class="meta">
            <div class="who">${esc(who)}</div>
            <div class="when">${esc(when)}</div>
            ${uri ? `<button class="reply" type="button" data-reply-uri="${esc(uri)}" data-reply-author="${esc(who)}">Reply</button>` : ''}
          </div>
          ${text ? `<div class="text">${esc(text)}</div>` : '<div class="text muted">(no text)</div>'}
        </div>
        ${hasReplies ? `<div class="replies">${replies.map((r) => this.renderNode(r, depth + 1)).join('')}</div>` : ''}
      </div>
    `;
  }

  render() {
    const root = this._thread;

    this.shadowRoot.innerHTML = `
      <style>
        :host, *, *::before, *::after{box-sizing:border-box}
        :host{display:block}
        .muted{color:#aaa}

        .node{margin: 0 0 8px 0; padding-left: calc(var(--depth, 0) * 12px); border-left: 2px solid rgba(255,255,255,0.06)}
        .card{border:1px solid #222; border-radius:10px; background:#0b0b0b; padding:8px}
        .meta{display:flex; align-items:center; gap:10px; color:#bbb; font-size:0.9rem; margin-bottom:6px}
        .who{font-weight:700; color:#eaeaea; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
        .when{margin-left:auto; white-space:nowrap}
        .text{white-space:pre-wrap; line-height:1.25}

        .reply{appearance:none; border:1px solid #333; background:#111; color:#fff; border-radius:999px; padding:4px 10px; cursor:pointer}
        .reply:hover{border-color:#3b5a8f}

        .replies{margin-top:8px}
      </style>
      ${root ? this.renderNode(root, 0) : '<div class="muted">Select a post to view its thread.</div>'}
    `;
  }
}

customElements.define('bsky-thread-tree', BskyThreadTree);
